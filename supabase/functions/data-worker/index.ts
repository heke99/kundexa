import { createClient } from "npm:@supabase/supabase-js@2.110.7";
import { decryptJson, encryptJson } from "../_shared/crypto.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const encryptionKey = Deno.env.get("KUNDEXA_ENCRYPTION_KEY")!;
const cronSecret = Deno.env.get("CRON_SECRET")!;
const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

const MAX_RESPONSE_BYTES = 2_000_000;
const CANONICAL_FIELDS = new Set([
  "canonical_name", "organization_number", "legal_form", "organization_status",
  "address_line1", "postal_code", "city", "municipality", "municipality_code",
  "county", "county_code", "country_code", "latitude", "longitude", "industry",
  "sni_code", "employee_count", "revenue", "result", "website", "phone_e164", "email",
]);

type Job = {
  id: string;
  tenant_id: string;
  master_entity_id: string;
  data_provider_id: string;
  provider_account_id: string;
  permission_id: string;
  enrichment_type: string;
  requested_fields: string[];
  purpose: string;
  attempts: number;
};

type Provider = {
  provider: string;
  adapter_key: string | null;
  integration_type: string;
  field_mapping: Record<string, string> | null;
  status: string;
};

type Account = {
  configuration: Record<string, unknown> | null;
  credentials_ciphertext: string | null;
  status: string;
};

type Permission = {
  allowed_domains: string[];
  allowed_paths: string[];
  raw_storage_allowed: boolean;
  status: string;
};

type Entity = {
  id: string;
  entity_type: "organization" | "establishment" | "person";
  external_primary_id: string | null;
  organization_number: string | null;
};

type Credentials = {
  headers?: Record<string, string>;
  query?: Record<string, string>;
  apiKey?: string;
  apiKeyHeader?: string;
};

type AdapterConfig = {
  endpoint_template?: string;
  method?: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  request_body?: unknown;
  response_root_path?: string;
  external_id_path?: string;
  source_timestamp_path?: string;
  field_mapping?: Record<string, string>;
  timeout_ms?: number;
  estimated_cost_per_call?: number;
};

class WorkerError extends Error {
  constructor(message: string, readonly retryable = false, readonly delaySeconds = 60, readonly details: Record<string, unknown> = {}) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pathValue(source: unknown, path: string | undefined): unknown {
  if (!path) return source;
  return path.split(".").filter(Boolean).reduce<unknown>((value, part) => {
    if (Array.isArray(value) && /^\d+$/.test(part)) return value[Number(part)];
    if (isRecord(value)) return value[part];
    return undefined;
  }, source);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256(value: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function interpolate(value: string, variables: Record<string, string>) {
  return value.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_match, key: string) => {
    if (!(key in variables)) throw new WorkerError(`adapter_variable_missing:${key}`);
    return encodeURIComponent(variables[key]);
  });
}

function forbiddenHost(host: string) {
  const normalized = host.toLowerCase();
  return normalized === "localhost" || normalized.endsWith(".local") || normalized === "127.0.0.1" || normalized === "::1" ||
    /^10\./.test(normalized) || /^192\.168\./.test(normalized) || /^169\.254\./.test(normalized) || /^172\.(1[6-9]|2\d|3[01])\./.test(normalized) ||
    normalized === "0.0.0.0";
}

function assertProviderUrl(value: string, permission: Permission) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) throw new WorkerError("provider_https_url_required");
  if (forbiddenHost(url.hostname)) throw new WorkerError("provider_private_network_forbidden");
  const domains = permission.allowed_domains.map((domain) => domain.trim().toLowerCase().replace(/^\*\./, "")).filter(Boolean);
  if (!domains.length || !domains.some((domain) => url.hostname.toLowerCase() === domain || url.hostname.toLowerCase().endsWith(`.${domain}`))) {
    throw new WorkerError("provider_domain_not_permitted");
  }
  const paths = permission.allowed_paths.map((path) => path.trim()).filter(Boolean);
  if (paths.length && !paths.some((path) => url.pathname.startsWith(path))) throw new WorkerError("provider_path_not_permitted");
  return url;
}

function normalizedCanonicalValue(field: string, value: unknown): string | number | null {
  if (value == null || value === "") return null;
  if (["latitude", "longitude", "revenue", "result"].includes(field)) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new WorkerError(`provider_field_invalid_number:${field}`);
    return number;
  }
  if (field === "employee_count") {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 0) throw new WorkerError("provider_field_invalid_integer:employee_count");
    return number;
  }
  const text = String(value).trim();
  if (field === "country_code" && !/^[A-Z]{2}$/i.test(text)) throw new WorkerError("provider_field_invalid_country_code");
  if (field === "phone_e164" && !/^\+[1-9][0-9]{7,14}$/.test(text)) throw new WorkerError("provider_field_invalid_phone");
  if (field === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) throw new WorkerError("provider_field_invalid_email");
  return field === "country_code" ? text.toUpperCase() : text;
}

function safeHeaders(headers: Headers) {
  const result: Record<string, string> = {};
  for (const key of ["content-type", "etag", "last-modified", "x-request-id", "retry-after"]) {
    const value = headers.get(key);
    if (value) result[key] = value.slice(0, 1000);
  }
  return result;
}

async function loadJobContext(job: Job) {
  const [providerResult, accountResult, permissionResult, entityResult, fieldsResult, parserResult] = await Promise.all([
    supabase.from("data_providers").select("provider,adapter_key,integration_type,field_mapping,status").eq("tenant_id", job.tenant_id).eq("id", job.data_provider_id).single(),
    supabase.from("provider_accounts").select("configuration,credentials_ciphertext,status").eq("tenant_id", job.tenant_id).eq("id", job.provider_account_id).single(),
    supabase.from("provider_permissions").select("allowed_domains,allowed_paths,raw_storage_allowed,status").eq("tenant_id", job.tenant_id).eq("id", job.permission_id).single(),
    supabase.from("master_entities").select("id,entity_type,external_primary_id,organization_number").eq("id", job.master_entity_id).single(),
    supabase.from("provider_field_permissions").select("field_key,may_fetch,may_store").eq("tenant_id", job.tenant_id).eq("permission_id", job.permission_id),
    supabase.from("parser_versions").select("id,version,expected_fields,minimum_match_rate,disappearance_threshold").eq("tenant_id", job.tenant_id).eq("data_provider_id", job.data_provider_id).eq("status", "active").order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  for (const result of [providerResult, accountResult, permissionResult, entityResult]) {
    if (result.error || !result.data) throw new WorkerError(result.error?.message ?? "enrichment_context_missing");
  }
  if (fieldsResult.error) throw new WorkerError(fieldsResult.error.message);
  if (parserResult.error) throw new WorkerError(parserResult.error.message);
  return {
    provider: providerResult.data as Provider,
    account: accountResult.data as Account,
    permission: permissionResult.data as Permission,
    entity: entityResult.data as Entity,
    fieldPermissions: (fieldsResult.data ?? []) as Array<{ field_key: string; may_fetch: boolean; may_store: boolean }>,
    parser: parserResult.data,
  };
}

async function executeGenericJson(job: Job) {
  const context = await loadJobContext(job);
  if (context.provider.status !== "active" || context.account.status !== "active" || context.permission.status !== "active") {
    throw new WorkerError("provider_configuration_inactive");
  }
  if (context.provider.adapter_key !== "generic_json" || !["api", "json"].includes(context.provider.integration_type)) {
    throw new WorkerError(`unsupported_provider_adapter:${context.provider.adapter_key ?? "missing"}`);
  }
  const externalIdentifier = context.entity.external_primary_id || context.entity.organization_number;
  if (!externalIdentifier) throw new WorkerError("entity_external_identifier_missing");

  const config = (context.account.configuration ?? {}) as AdapterConfig;
  if (!config.endpoint_template) throw new WorkerError("provider_endpoint_missing");
  const credentials = context.account.credentials_ciphertext
    ? await decryptJson<Credentials>(context.account.credentials_ciphertext, encryptionKey)
    : {};
  const variables = {
    external_identifier: externalIdentifier,
    organization_number: context.entity.organization_number ?? externalIdentifier,
    purpose: job.purpose,
    entity_type: context.entity.entity_type,
  };
  const url = assertProviderUrl(interpolate(config.endpoint_template, variables), context.permission);
  for (const [key, value] of Object.entries({ ...(config.query ?? {}), ...(credentials.query ?? {}) })) {
    url.searchParams.set(key, interpolate(String(value), variables));
  }

  const method = String(config.method ?? "GET").toUpperCase();
  if (!["GET", "POST"].includes(method)) throw new WorkerError("provider_method_not_supported");
  const headers = new Headers({ accept: "application/json" });
  for (const [key, value] of Object.entries(config.headers ?? {})) headers.set(key, interpolate(String(value), variables));
  for (const [key, value] of Object.entries(credentials.headers ?? {})) headers.set(key, String(value));
  if (credentials.apiKey) headers.set(credentials.apiKeyHeader || "Authorization", credentials.apiKeyHeader ? credentials.apiKey : `Bearer ${credentials.apiKey}`);
  headers.delete("host"); headers.delete("content-length"); headers.delete("cookie");

  const timeoutMs = Math.max(1000, Math.min(Number(config.timeout_ms ?? 30000), 120000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      redirect: "manual",
      signal: controller.signal,
      body: method === "POST" ? JSON.stringify(config.request_body ?? { external_identifier: externalIdentifier }) : undefined,
    });
  } catch (error) {
    throw new WorkerError(error instanceof DOMException && error.name === "AbortError" ? "provider_timeout" : "provider_network_error", true, 60, { cause: String(error) });
  } finally {
    clearTimeout(timer);
  }
  if (response.status >= 300 && response.status < 400) throw new WorkerError("provider_redirect_forbidden");
  const retryAfter = Math.max(1, Math.min(Number(response.headers.get("retry-after") ?? 60), 3600));
  if (response.status === 429 || response.status >= 500) throw new WorkerError(`provider_http_${response.status}`, true, retryAfter);
  if (!response.ok) throw new WorkerError(`provider_http_${response.status}`);
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > MAX_RESPONSE_BYTES) throw new WorkerError("provider_response_too_large");
  const text = await response.text();
  if (new TextEncoder().encode(text).length > MAX_RESPONSE_BYTES) throw new WorkerError("provider_response_too_large");
  let payload: unknown;
  try { payload = JSON.parse(text); } catch { throw new WorkerError("provider_invalid_json"); }
  const root = pathValue(payload, config.response_root_path);
  if (!isRecord(root)) throw new WorkerError("provider_response_root_invalid");

  const permitted = new Set(context.fieldPermissions.filter((field) => field.may_fetch && field.may_store).map((field) => field.field_key));
  const requested = new Set(job.requested_fields.length ? job.requested_fields : [...permitted]);
  const mapping = { ...(context.provider.field_mapping ?? {}), ...(config.field_mapping ?? {}) };
  const facts: Array<{ field_key: string; field_value: unknown; value_hash: string; confidence: number }> = [];
  const canonical: Record<string, string | number> = {};
  for (const [field, sourcePath] of Object.entries(mapping)) {
    if (!permitted.has(field) || !requested.has(field)) continue;
    const rawValue = pathValue(root, sourcePath);
    if (rawValue == null || rawValue === "") continue;
    const value = CANONICAL_FIELDS.has(field) ? normalizedCanonicalValue(field, rawValue) : rawValue;
    if (value == null) continue;
    facts.push({ field_key: field, field_value: value, value_hash: await sha256(stableJson(value)), confidence: 0.8 });
    if (CANONICAL_FIELDS.has(field) && (typeof value === "string" || typeof value === "number")) canonical[field] = value;
  }
  if (!facts.length) throw new WorkerError("provider_no_permitted_fields_returned");
  if (!canonical.canonical_name && context.entity.entity_type !== "person") canonical.canonical_name = String(root.name ?? root.company_name ?? externalIdentifier);

  if (context.parser?.expected_fields?.length) {
    const present = new Set(facts.map((fact) => fact.field_key));
    const matchRate = context.parser.expected_fields.filter((field: string) => present.has(field)).length / context.parser.expected_fields.length;
    if (matchRate < Number(context.parser.minimum_match_rate ?? 0.9)) {
      throw new WorkerError("parser_match_rate_below_threshold", false, 0, { matchRate, expected: context.parser.expected_fields });
    }
  }

  const externalFromResponse = pathValue(root, config.external_id_path);
  const sourceTimestampValue = pathValue(root, config.source_timestamp_path);
  const sourceTimestamp = sourceTimestampValue && !Number.isNaN(Date.parse(String(sourceTimestampValue))) ? new Date(String(sourceTimestampValue)).toISOString() : null;
  const payloadHash = await sha256(stableJson(payload));
  const encryptedPayload = context.permission.raw_storage_allowed ? await encryptJson(payload, encryptionKey) : null;
  const { data, error } = await supabase.rpc("complete_enrichment_job", {
    p_job_id: job.id,
    p_external_identifier: String(externalFromResponse ?? externalIdentifier),
    p_facts: facts,
    p_canonical: canonical,
    p_payload_sha256: payloadHash,
    p_payload_ciphertext: encryptedPayload,
    p_content_type: response.headers.get("content-type") ?? "application/json",
    p_http_status: response.status,
    p_response_headers: safeHeaders(response.headers),
    p_request_id: response.headers.get("x-request-id"),
    p_source_timestamp: sourceTimestamp,
    p_parser_version_id: context.parser?.id ?? null,
    p_actual_cost: Number(config.estimated_cost_per_call ?? 0),
    p_metadata: { adapter: "generic_json", provider: context.provider.provider, parser_version: context.parser?.version ?? null },
  });
  if (error) throw new WorkerError(`complete_enrichment_failed:${error.message}`, true, 60);
  return data;
}

async function failJob(job: Job, error: unknown) {
  const normalized = error instanceof WorkerError ? error : new WorkerError(error instanceof Error ? error.message : String(error), true, 60);
  await supabase.rpc("fail_enrichment_job", {
    p_job_id: job.id,
    p_stage: "data_worker",
    p_error: normalized.message,
    p_retryable: normalized.retryable,
    p_delay_seconds: normalized.delaySeconds,
    p_details: normalized.details,
  });
  return { id: job.id, status: normalized.retryable ? "retry_scheduled" : "failed", error: normalized.message };
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return new Response("method_not_allowed", { status: 405 });
  if (!cronSecret || request.headers.get("x-cron-secret") !== cronSecret) return new Response("unauthorized", { status: 401 });
  const body = await request.json().catch(() => ({})) as { limit?: number; workerId?: string };
  const limit = Math.max(1, Math.min(Number(body.limit ?? 10), 25));
  const workerId = String(body.workerId ?? `data-worker:${crypto.randomUUID()}`).slice(0, 200);
  const { data, error } = await supabase.rpc("claim_enrichment_jobs", { p_worker: workerId, p_limit: limit });
  if (error) return Response.json({ error: error.message }, { status: 500 });
  const jobs = (data ?? []) as Job[];
  const results: unknown[] = [];
  for (const job of jobs) {
    try {
      results.push({ id: job.id, status: "completed", result: await executeGenericJson(job) });
    } catch (jobError) {
      results.push(await failJob(job, jobError));
    }
  }
  return Response.json({ workerId, claimed: jobs.length, results });
});
