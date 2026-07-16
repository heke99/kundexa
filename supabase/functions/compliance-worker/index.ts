import { createClient } from "npm:@supabase/supabase-js@2.110.7";
import { decryptJson } from "../_shared/crypto.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const cronSecret = Deno.env.get("CRON_SECRET")!;
const encryptionKey = Deno.env.get("KUNDEXA_ENCRYPTION_KEY")!;
const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

const CANONICAL_RESULTS = new Set(["listed", "not_listed", "unknown", "error"]);
const MAX_RESPONSE_BYTES = 1_000_000;

type JsonRecord = Record<string, unknown>;
type NixJob = {
  id: string;
  tenant_id: string;
  configuration_id: string;
  customer_id: string;
  phone_e164: string;
  attempts: number;
};
type NixConfiguration = {
  id: string;
  tenant_id: string;
  name: string;
  endpoint_template: string;
  method: "GET" | "POST";
  allowed_domains: string[];
  allowed_paths: string[];
  credentials_ciphertext: string | null;
  request_configuration: JsonRecord;
  result_path: string;
  result_mapping: JsonRecord;
  timeout_ms: number;
};
type Credentials = {
  apiKey?: string;
  apiKeyHeader?: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
};

class WorkerError extends Error {
  constructor(message: string, readonly retryable = false) {
    super(message);
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pathValue(root: unknown, path: string | undefined): unknown {
  if (!path) return root;
  return path.split(".").filter(Boolean).reduce<unknown>((value, key) => {
    if (Array.isArray(value) && /^\d+$/.test(key)) return value[Number(key)];
    return isRecord(value) ? value[key] : undefined;
  }, root);
}

function interpolate(template: string, values: Record<string, string>) {
  return template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_, key: string) => {
    if (!(key in values)) throw new WorkerError(`nix_template_variable_missing:${key}`);
    return encodeURIComponent(values[key]);
  });
}

function normalizeHost(hostname: string) {
  return hostname.trim().toLowerCase().replace(/\.$/, "");
}

function hostMatches(host: string, allowed: string) {
  const normalizedAllowed = normalizeHost(allowed).replace(/^\*\./, "");
  return host === normalizedAllowed || host.endsWith(`.${normalizedAllowed}`);
}

function isPrivateHost(hostname: string) {
  const host = normalizeHost(hostname).replace(/^\[|\]$/g, "");
  if (["localhost", "localhost.localdomain", "::1", "0.0.0.0"].includes(host) || host.endsWith(".local")) return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return true;
  const ipv4 = host.match(/^172\.(\d{1,3})\./);
  if (ipv4 && Number(ipv4[1]) >= 16 && Number(ipv4[1]) <= 31) return true;
  if (/^(fc|fd|fe8|fe9|fea|feb)/i.test(host) || host === "::") return true;
  return false;
}

async function assertPublicDns(hostname: string) {
  // The contract allow-list is authoritative. DNS lookup adds protection against
  // accidental private targets while remaining compatible with edge runtimes.
  for (const recordType of ["A", "AAAA"] as const) {
    try {
      const addresses = await Deno.resolveDns(hostname, recordType);
      if (addresses.some((address) => isPrivateHost(address))) throw new WorkerError("nix_private_network_forbidden");
    } catch (error) {
      if (error instanceof WorkerError) throw error;
      // Some edge runtimes do not expose DNS resolution. Literal/private hosts
      // are still rejected and the exact contractual domain must be allow-listed.
    }
  }
}

async function assertProviderUrl(raw: string, configuration: NixConfiguration) {
  let url: URL;
  try { url = new URL(raw); } catch { throw new WorkerError("nix_endpoint_invalid"); }
  if (url.protocol !== "https:") throw new WorkerError("nix_https_required");
  const host = normalizeHost(url.hostname);
  if (isPrivateHost(host)) throw new WorkerError("nix_private_network_forbidden");
  if (!configuration.allowed_domains.some((allowed) => hostMatches(host, allowed))) throw new WorkerError("nix_domain_not_permitted");
  if (configuration.allowed_paths.length && !configuration.allowed_paths.some((path) => url.pathname.startsWith(path))) throw new WorkerError("nix_path_not_permitted");
  url.username = "";
  url.password = "";
  await assertPublicDns(host);
  return url;
}

function canonicalResult(raw: unknown, mapping: JsonRecord): "listed" | "not_listed" | "unknown" | "error" {
  if (typeof raw === "boolean") return raw ? "listed" : "not_listed";
  const normalized = String(raw ?? "").trim().toLowerCase();
  if (CANONICAL_RESULTS.has(normalized)) return normalized as "listed" | "not_listed" | "unknown" | "error";
  const direct = mapping[normalized];
  if (typeof direct === "string" && CANONICAL_RESULTS.has(direct.toLowerCase())) return direct.toLowerCase() as "listed" | "not_listed" | "unknown" | "error";
  for (const [canonical, providerValue] of Object.entries(mapping)) {
    if (String(providerValue).trim().toLowerCase() === normalized && CANONICAL_RESULTS.has(canonical.toLowerCase())) {
      return canonical.toLowerCase() as "listed" | "not_listed" | "unknown" | "error";
    }
  }
  return "unknown";
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function safeHeaders(headers: Headers) {
  const safe = new Set(["content-type", "date", "etag", "last-modified", "x-request-id"]);
  return Object.fromEntries([...headers.entries()].filter(([key]) => safe.has(key.toLowerCase())));
}

async function executeJob(job: NixJob) {
  const { data, error } = await supabase.from("nix_provider_configurations").select("*").eq("id", job.configuration_id).eq("tenant_id", job.tenant_id).single();
  if (error || !data) throw new WorkerError(`nix_configuration_load_failed:${error?.message ?? "missing"}`);
  const configuration = data as NixConfiguration;
  if ((data as { status: string }).status !== "active") throw new WorkerError("nix_configuration_inactive");

  const credentials: Credentials = configuration.credentials_ciphertext
    ? await decryptJson<Credentials>(configuration.credentials_ciphertext, encryptionKey)
    : {};
  const requestConfiguration = configuration.request_configuration ?? {};
  const variables = {
    phone_e164: job.phone_e164,
    phone: job.phone_e164.replace(/^\+/, ""),
    customer_id: job.customer_id,
  };
  const url = await assertProviderUrl(interpolate(configuration.endpoint_template, variables), configuration);
  if (isRecord(requestConfiguration.query)) {
    for (const [key, value] of Object.entries(requestConfiguration.query)) url.searchParams.set(key, interpolate(String(value), variables));
  }
  for (const [key, value] of Object.entries(credentials.query ?? {})) url.searchParams.set(key, interpolate(String(value), variables));

  const headers = new Headers({ accept: "application/json" });
  if (isRecord(requestConfiguration.headers)) {
    for (const [key, value] of Object.entries(requestConfiguration.headers)) headers.set(key, interpolate(String(value), variables));
  }
  for (const [key, value] of Object.entries(credentials.headers ?? {})) headers.set(key, interpolate(String(value), variables));
  if (credentials.apiKey) headers.set(credentials.apiKeyHeader || "Authorization", credentials.apiKeyHeader ? credentials.apiKey : `Bearer ${credentials.apiKey}`);
  headers.delete("host"); headers.delete("content-length"); headers.delete("cookie"); headers.delete("authorization-proxy");

  const method = configuration.method || "GET";
  let body: string | undefined;
  if (method === "POST") {
    const configuredBody = isRecord(requestConfiguration.body) ? requestConfiguration.body : { phone_e164: "{{phone_e164}}" };
    body = JSON.stringify(Object.fromEntries(Object.entries(configuredBody).map(([key, value]) => [key, interpolate(String(value), variables)])));
    headers.set("content-type", "application/json");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Math.min(configuration.timeout_ms || 15000, 120000)));
  let response: Response;
  try {
    response = await fetch(url, { method, headers, body, redirect: "manual", signal: controller.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw new WorkerError("nix_provider_timeout", true);
    throw new WorkerError(`nix_provider_network_error:${String(error)}`, true);
  } finally { clearTimeout(timer); }

  if (response.status >= 300 && response.status < 400) throw new WorkerError("nix_provider_redirect_forbidden");
  if (response.status === 429 || response.status >= 500) throw new WorkerError(`nix_provider_http_${response.status}`, true);
  if (!response.ok) throw new WorkerError(`nix_provider_http_${response.status}`);
  const text = await response.text();
  if (new TextEncoder().encode(text).length > MAX_RESPONSE_BYTES) throw new WorkerError("nix_provider_response_too_large");
  let payload: unknown;
  try { payload = JSON.parse(text); } catch { throw new WorkerError("nix_provider_invalid_json"); }
  const result = canonicalResult(pathValue(payload, configuration.result_path), configuration.result_mapping ?? {});
  const sourceVersionPath = typeof requestConfiguration.source_version_path === "string" ? requestConfiguration.source_version_path : undefined;
  const sourceVersion = sourceVersionPath ? String(pathValue(payload, sourceVersionPath) ?? "") || null : response.headers.get("etag");
  const evidence = {
    provider: configuration.name,
    checkedEndpoint: `${url.origin}${url.pathname}`,
    httpStatus: response.status,
    responseHash: await sha256(text),
    responseHeaders: safeHeaders(response.headers),
    requestId: response.headers.get("x-request-id"),
  };
  const { error: completeError } = await supabase.rpc("complete_nix_check_job", {
    p_job_id: job.id,
    p_result: result,
    p_source_version: sourceVersion,
    p_evidence: evidence,
  });
  if (completeError) throw new WorkerError(`nix_job_complete_failed:${completeError.message}`, true);
  return { id: job.id, status: "completed", result };
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return new Response("method_not_allowed", { status: 405 });
  if (!cronSecret || request.headers.get("x-cron-secret") !== cronSecret) return new Response("unauthorized", { status: 401 });
  if (!encryptionKey) return Response.json({ error: "encryption_key_missing" }, { status: 500 });
  const body = await request.json().catch(() => ({})) as { limit?: number; queueLimit?: number; workerId?: string };
  const limit = Math.max(1, Math.min(Number(body.limit ?? 20), 100));
  const workerId = String(body.workerId ?? `compliance-worker:${crypto.randomUUID()}`).slice(0, 200);
  const { data: queued, error: queueError } = await supabase.rpc("queue_due_nix_checks", { p_limit: Math.max(limit, Math.min(Number(body.queueLimit ?? 100), 1000)) });
  if (queueError) return Response.json({ error: queueError.message }, { status: 500 });
  const { data: claimed, error: claimError } = await supabase.rpc("claim_nix_check_jobs", { p_worker: workerId, p_limit: limit });
  if (claimError) return Response.json({ error: claimError.message }, { status: 500 });

  const results: unknown[] = [];
  for (const job of (claimed ?? []) as NixJob[]) {
    try { results.push(await executeJob(job)); }
    catch (error) {
      const workerError = error instanceof WorkerError ? error : new WorkerError(String(error), true);
      await supabase.rpc("fail_nix_check_job", { p_job_id: job.id, p_error: workerError.message, p_retryable: workerError.retryable });
      results.push({ id: job.id, status: workerError.retryable ? "retrying" : "dead", error: workerError.message });
    }
  }
  return Response.json({ workerId, queued: Number(queued ?? 0), claimed: (claimed ?? []).length, results });
});
