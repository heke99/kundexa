import { createClient } from "npm:@supabase/supabase-js@2.110.7";
import { decryptJson, encryptJson } from "../_shared/crypto.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const encryptionKey = Deno.env.get("KUNDEXA_ENCRYPTION_KEY")!;
const cronSecret = Deno.env.get("CRON_SECRET")!;
const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
const MAX_RESPONSE_BYTES = 8_000_000;

const CANONICAL_FIELDS = new Set([
  "canonical_name", "organization_number", "legal_form", "organization_status", "address_line1", "postal_code",
  "city", "municipality", "municipality_code", "county", "county_code", "country_code", "latitude", "longitude",
  "industry", "sni_code", "employee_count", "revenue", "result", "website", "phone_e164", "email", "registration_date",
  "f_tax_registered", "vat_registered", "employer_registered", "phone_type", "date_of_birth",
]);

type JsonObject = Record<string, unknown>;
type Run = {
  id: string;
  tenant_id: string;
  ingestion_job_id: string;
  parser_version_id: string | null;
  requested_records: number;
  fetched_records: number;
  current_page: string | null;
  next_page: string | null;
};
type Job = {
  id: string;
  tenant_id: string;
  data_provider_id: string;
  provider_account_id: string | null;
  permission_id: string;
  entity_type: "organization" | "establishment" | "person";
  max_records: number;
  filter_definition: JsonObject;
  adapter_key: string;
  adapter_configuration: JsonObject;
};
type Permission = {
  id: string;
  allowed_domains: string[];
  allowed_paths: string[];
  raw_storage_allowed: boolean;
  status: string;
};
type Account = { configuration: JsonObject | null; credentials_ciphertext: string | null; status: string };
type Provider = { provider: string; field_mapping: Record<string, string> | null; discovery_configuration: JsonObject | null; status: string };
type FieldPermission = { field_key: string; may_fetch: boolean; may_store: boolean };
type Credentials = { headers?: Record<string, string>; query?: Record<string, string>; apiKey?: string; apiKeyHeader?: string };

type AdapterConfig = {
  format?: "json" | "ndjson" | "csv" | "html_regex";
  endpoint_template?: string;
  method?: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  request_body?: unknown;
  response_root_path?: string;
  items_path?: string;
  next_page_path?: string;
  external_id_path?: string;
  source_timestamp_path?: string;
  field_mapping?: Record<string, string>;
  regex_mapping?: Record<string, string>;
  record_regex?: string;
  page_parameter?: string;
  page_start?: number;
  page_size?: number;
  max_pages_per_run?: number;
  delimiter?: string;
  timeout_ms?: number;
};

class WorkerError extends Error {
  constructor(message: string, readonly retryable = false, readonly delaySeconds = 60, readonly details: JsonObject = {}) { super(message); }
}

function isRecord(value: unknown): value is JsonObject { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function pathValue(source: unknown, path?: string): unknown {
  if (!path) return source;
  return path.split(".").filter(Boolean).reduce<unknown>((value, part) => {
    if (Array.isArray(value) && /^\d+$/.test(part)) return value[Number(part)];
    if (isRecord(value)) return value[part];
    return undefined;
  }, source);
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
async function sha256(value: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function interpolate(value: string, vars: Record<string, string>) {
  return value.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_m, key: string) => {
    if (!(key in vars)) throw new WorkerError(`adapter_variable_missing:${key}`);
    return encodeURIComponent(vars[key]);
  });
}
function forbiddenHost(host: string) {
  const normalized = host.toLowerCase();
  return normalized === "localhost" || normalized.endsWith(".local") || normalized === "127.0.0.1" || normalized === "::1" ||
    /^10\./.test(normalized) || /^192\.168\./.test(normalized) || /^169\.254\./.test(normalized) || /^172\.(1[6-9]|2\d|3[01])\./.test(normalized) || normalized === "0.0.0.0";
}
function assertProviderUrl(raw: string, permission: Permission) {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || forbiddenHost(url.hostname)) throw new WorkerError("provider_url_forbidden");
  const domains = permission.allowed_domains.map((d) => d.toLowerCase().replace(/^\*\./, "")).filter(Boolean);
  if (!domains.some((domain) => url.hostname.toLowerCase() === domain || url.hostname.toLowerCase().endsWith(`.${domain}`))) throw new WorkerError("provider_domain_not_permitted");
  const paths = permission.allowed_paths.map((p) => p.trim()).filter(Boolean);
  if (paths.length && !paths.some((p) => url.pathname.startsWith(p))) throw new WorkerError("provider_path_not_permitted");
  return url;
}
function safeHeaders(headers: Headers) {
  const result: Record<string, string> = {};
  for (const key of ["content-type", "etag", "last-modified", "x-request-id", "retry-after"]) {
    const value = headers.get(key); if (value) result[key] = value.slice(0, 1000);
  }
  return result;
}
function parseCsv(text: string, delimiter = ","): JsonObject[] {
  const rows: string[][] = []; let row: string[] = []; let field = ""; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === delimiter) { row.push(field); field = ""; }
    else if (char === "\n") { row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = ""; }
    else field += char;
  }
  if (field.length || row.length) { row.push(field.replace(/\r$/, "")); rows.push(row); }
  const headers = (rows.shift() ?? []).map((h) => h.trim());
  return rows.filter((r) => r.some((v) => v.trim())).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ""])));
}
function parseHtmlRegex(text: string, config: AdapterConfig): JsonObject[] {
  if (!config.record_regex || !config.regex_mapping) throw new WorkerError("html_regex_configuration_missing");
  let recordPattern: RegExp;
  try { recordPattern = new RegExp(config.record_regex, "gis"); } catch { throw new WorkerError("html_record_regex_invalid"); }
  const records: JsonObject[] = [];
  for (const match of text.matchAll(recordPattern)) {
    const source = match[0]; const record: JsonObject = {};
    for (const [key, pattern] of Object.entries(config.regex_mapping)) {
      try { const m = new RegExp(pattern, "is").exec(source); if (m) record[key] = (m.groups?.value ?? m[1] ?? m[0]).trim(); }
      catch { throw new WorkerError(`html_field_regex_invalid:${key}`); }
    }
    records.push(record);
  }
  return records;
}
function normalizeCanonical(field: string, value: unknown): string | number | boolean | null {
  if (value == null || value === "") return null;
  if (["latitude", "longitude", "revenue", "result"].includes(field)) { const n = Number(value); return Number.isFinite(n) ? n : null; }
  if (field === "employee_count") { const n = Number(value); return Number.isInteger(n) && n >= 0 ? n : null; }
  if (["f_tax_registered", "vat_registered", "employer_registered"].includes(field)) {
    if (typeof value === "boolean") return value;
    const normalized = String(value).trim().toLowerCase();
    if (["true", "1", "yes", "ja", "registered"].includes(normalized)) return true;
    if (["false", "0", "no", "nej", "not_registered"].includes(normalized)) return false;
    return null;
  }
  const text = String(value).trim(); if (!text) return null;
  if (field === "country_code") return text.toUpperCase();
  if (field === "phone_e164") return /^\+[1-9]\d{7,14}$/.test(text) ? text : null;
  if (field === "email") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) ? text.toLowerCase() : null;
  return text;
}
async function loadContext(run: Run) {
  const { data: job, error: jobError } = await supabase.from("ingestion_jobs").select("*").eq("id", run.ingestion_job_id).single();
  if (jobError || !job) throw new WorkerError(`ingestion_job_load_failed:${jobError?.message ?? "missing"}`);
  const typedJob = job as Job;
  const [providerResult, accountResult, permissionResult, fieldsResult] = await Promise.all([
    supabase.from("data_providers").select("provider,field_mapping,discovery_configuration,status").eq("id", typedJob.data_provider_id).single(),
    typedJob.provider_account_id ? supabase.from("provider_accounts").select("configuration,credentials_ciphertext,status").eq("id", typedJob.provider_account_id).single() : Promise.resolve({ data: null, error: null }),
    supabase.from("provider_permissions").select("id,allowed_domains,allowed_paths,raw_storage_allowed,status").eq("id", typedJob.permission_id).single(),
    supabase.from("provider_field_permissions").select("field_key,may_fetch,may_store").eq("permission_id", typedJob.permission_id).eq("entity_type", typedJob.entity_type),
  ]);
  if (!providerResult.data || providerResult.error) throw new WorkerError("provider_not_found");
  if (!permissionResult.data || permissionResult.error) throw new WorkerError("permission_not_found");
  if (providerResult.data.status !== "active" || permissionResult.data.status !== "active") throw new WorkerError("provider_or_permission_inactive");
  if (typedJob.provider_account_id && (!accountResult.data || accountResult.data.status !== "active")) throw new WorkerError("provider_account_inactive");
  return {
    job: typedJob,
    provider: providerResult.data as Provider,
    account: accountResult.data as Account | null,
    permission: permissionResult.data as Permission,
    fieldPermissions: (fieldsResult.data ?? []) as FieldPermission[],
  };
}

async function executeRun(run: Run) {
  const context = await loadContext(run);
  const config = {
    ...(context.provider.discovery_configuration ?? {}),
    ...(context.account?.configuration ?? {}),
    ...(context.job.adapter_configuration ?? {}),
  } as AdapterConfig;
  if (!config.endpoint_template) throw new WorkerError("ingestion_endpoint_missing");
  const credentials: Credentials = context.account?.credentials_ciphertext ? await decryptJson<Credentials>(context.account.credentials_ciphertext, encryptionKey) : {};
  const permitted = new Set(context.fieldPermissions.filter((f) => f.may_fetch && f.may_store).map((f) => f.field_key));
  const mapping = { ...(context.provider.field_mapping ?? {}), ...(config.field_mapping ?? {}) };
  const maxRecords = Math.min(context.job.max_records, Math.max(0, run.requested_records - run.fetched_records));
  let processed = 0;
  let page = Number(run.next_page ?? run.current_page ?? config.page_start ?? 1);
  const maxPages = Math.max(1, Math.min(Number(config.max_pages_per_run ?? 100), 1000));
  let nextPageToken: string | null = null;

  for (let pageIndex = 0; pageIndex < maxPages && processed < maxRecords; pageIndex++) {
    const variables: Record<string, string> = { page: String(page), limit: String(config.page_size ?? 100), entity_type: context.job.entity_type };
    for (const [key, value] of Object.entries(context.job.filter_definition ?? {})) variables[key] = String(value ?? "");
    const url = assertProviderUrl(interpolate(config.endpoint_template, variables), context.permission);
    for (const [key, value] of Object.entries(config.query ?? {})) url.searchParams.set(key, interpolate(String(value), variables));
    for (const [key, value] of Object.entries(credentials.query ?? {})) url.searchParams.set(key, String(value));
    if (config.page_parameter) url.searchParams.set(config.page_parameter, String(page));
    const headers = new Headers({ accept: "application/json,text/csv,text/html,application/x-ndjson" });
    for (const [key, value] of Object.entries(config.headers ?? {})) headers.set(key, interpolate(String(value), variables));
    for (const [key, value] of Object.entries(credentials.headers ?? {})) headers.set(key, String(value));
    if (credentials.apiKey) headers.set(credentials.apiKeyHeader || "Authorization", credentials.apiKeyHeader ? credentials.apiKey : `Bearer ${credentials.apiKey}`);
    headers.delete("host"); headers.delete("content-length"); headers.delete("cookie");

    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), Math.max(1000, Math.min(Number(config.timeout_ms ?? 30000), 120000)));
    let response: Response;
    try {
      response = await fetch(url, { method: String(config.method ?? "GET").toUpperCase(), headers, redirect: "manual", signal: controller.signal,
        body: String(config.method ?? "GET").toUpperCase() === "POST" ? JSON.stringify(config.request_body ?? context.job.filter_definition) : undefined });
    } catch (error) {
      throw new WorkerError(error instanceof DOMException && error.name === "AbortError" ? "provider_timeout" : "provider_network_error", true, 60, { cause: String(error) });
    } finally { clearTimeout(timer); }
    if (response.status >= 300 && response.status < 400) throw new WorkerError("provider_redirect_forbidden");
    if (response.status === 429 || response.status >= 500) throw new WorkerError(`provider_http_${response.status}`, true, Number(response.headers.get("retry-after") ?? 60));
    if (!response.ok) throw new WorkerError(`provider_http_${response.status}`);
    const text = await response.text();
    if (new TextEncoder().encode(text).length > MAX_RESPONSE_BYTES) throw new WorkerError("provider_response_too_large");
    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    const payloadHash = await sha256(text);
    const encrypted = context.permission.raw_storage_allowed ? await encryptJson({ raw: text }, encryptionKey) : null;
    const { data: rawPayloadId, error: rawError } = await supabase.rpc("record_ingestion_raw_payload", {
      p_ingestion_run_id: run.id, p_external_identifier: `page:${page}`, p_content_type: contentType, p_http_status: response.status,
      p_request_id: response.headers.get("x-request-id"), p_response_headers: safeHeaders(response.headers), p_source_timestamp: response.headers.get("last-modified"),
      p_payload_sha256: payloadHash, p_payload_ciphertext: encrypted, p_storage_path: null, p_metadata: { url: url.origin + url.pathname, page, adapter: context.job.adapter_key },
    });
    if (rawError || !rawPayloadId) throw new WorkerError(`raw_payload_save_failed:${rawError?.message ?? "missing"}`, true, 60);

    let parsedRoot: unknown = text;
    let records: JsonObject[] = [];
    try {
      const format = config.format ?? (contentType.includes("csv") ? "csv" : contentType.includes("html") ? "html_regex" : contentType.includes("ndjson") ? "ndjson" : "json");
      if (format === "json") { parsedRoot = JSON.parse(text); const items = pathValue(parsedRoot, config.items_path ?? config.response_root_path); records = Array.isArray(items) ? items.filter(isRecord) : isRecord(items) ? [items] : []; }
      else if (format === "ndjson") records = text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)).filter(isRecord);
      else if (format === "csv") records = parseCsv(text, config.delimiter ?? ",");
      else records = parseHtmlRegex(text, config);
    } catch (error) {
      await supabase.from("raw_payloads").update({ parse_status: "failed", parse_error: String(error) }).eq("id", rawPayloadId);
      throw new WorkerError("provider_parse_failed", false, 0, { cause: String(error), rawPayloadId });
    }
    if (!records.length) {
      await supabase.from("raw_payloads").update({ parse_status: "failed", parse_error: "no_records" }).eq("id", rawPayloadId);
      throw new WorkerError("provider_no_records_returned");
    }

    const fingerprint = await sha256([...new Set(records.flatMap((r) => Object.keys(r)))].sort().join("|"));
    for (const record of records) {
      if (processed >= maxRecords) break;
      const external = pathValue(record, config.external_id_path) ?? record.external_id ?? record.id ?? record.organization_number ?? record.organizationNumber;
      if (external == null || String(external).trim() === "") continue;
      const facts: Array<{ field_key: string; field_value: unknown; value_hash: string; confidence: number }> = [];
      const canonical: JsonObject = {};
      for (const [field, sourcePath] of Object.entries(mapping)) {
        if (!permitted.has(field)) continue;
        const raw = pathValue(record, sourcePath);
        if (raw == null || raw === "") continue;
        const value = CANONICAL_FIELDS.has(field) ? normalizeCanonical(field, raw) : raw;
        if (value == null) continue;
        facts.push({ field_key: field, field_value: value, value_hash: await sha256(stableJson(value)), confidence: 0.8 });
        if (CANONICAL_FIELDS.has(field)) canonical[field] = value;
      }
      if (!facts.length) continue;
      if (!canonical.canonical_name) canonical.canonical_name = String(record.name ?? record.company_name ?? external);
      const sourceTimestampValue = pathValue(record, config.source_timestamp_path);
      const sourceTimestamp = sourceTimestampValue && !Number.isNaN(Date.parse(String(sourceTimestampValue))) ? new Date(String(sourceTimestampValue)).toISOString() : null;
      const { data: completion, error: completionError } = await supabase.rpc("complete_ingestion_record", {
        p_ingestion_run_id: run.id, p_raw_payload_id: rawPayloadId, p_external_identifier: String(external), p_facts: facts, p_canonical: canonical,
        p_page_fingerprint: fingerprint, p_source_timestamp: sourceTimestamp,
      });
      if (completionError) throw new WorkerError(`complete_ingestion_record_failed:${completionError.message}`, true, 60, { rawPayloadId });
      if (isRecord(completion) && completion.quarantined === true) return { status: "quarantined", rawPayloadId, completion };
      if (isRecord(completion) && typeof completion.masterEntityId === "string") {
        const { error: geographyError } = await supabase.rpc("normalize_master_entity_geography", { p_entity_id: completion.masterEntityId });
        if (geographyError) throw new WorkerError(`geography_normalization_failed:${geographyError.message}`, true, 60, { rawPayloadId, masterEntityId: completion.masterEntityId });
      }
      processed++;
    }

    const nextValue = config.next_page_path ? pathValue(parsedRoot, config.next_page_path) : null;
    nextPageToken = nextValue == null || nextValue === "" ? null : String(nextValue);
    await supabase.from("crawl_checkpoints").update({ last_page: String(page), last_successful_step: "page_completed", remaining_capacity: Math.max(0, maxRecords - processed), updated_at: new Date().toISOString() }).eq("ingestion_run_id", run.id).is("crawl_plan_id", null);
    await supabase.from("ingestion_runs").update({ current_page: String(page), next_page: nextPageToken, parser_fingerprint: fingerprint }).eq("id", run.id);
    if (!nextPageToken && !config.page_parameter) break;
    if (nextPageToken) page = Number.isFinite(Number(nextPageToken)) ? Number(nextPageToken) : page + 1;
    else page++;
    if (records.length < Number(config.page_size ?? records.length)) break;
  }

  const { error: completeError } = await supabase.rpc("complete_ingestion_run", { p_run_id: run.id, p_next_page: nextPageToken, p_metadata: { processed } });
  if (completeError) throw new WorkerError(`complete_ingestion_run_failed:${completeError.message}`, true, 60);
  return { status: "completed", processed, nextPage: nextPageToken };
}

async function failRun(run: Run, error: unknown) {
  const normalized = error instanceof WorkerError ? error : new WorkerError(error instanceof Error ? error.message : String(error), true, 60);
  await supabase.rpc("fail_ingestion_run", { p_run_id: run.id, p_error: normalized.message, p_retryable: normalized.retryable, p_delay_seconds: normalized.delaySeconds, p_raw_payload_id: normalized.details.rawPayloadId ?? null, p_details: normalized.details });
  return { id: run.id, status: normalized.retryable ? "retry_scheduled" : "failed", error: normalized.message };
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return new Response("method_not_allowed", { status: 405 });
  if (!cronSecret || request.headers.get("x-cron-secret") !== cronSecret) return new Response("unauthorized", { status: 401 });
  const body = await request.json().catch(() => ({})) as { limit?: number; workerId?: string; scheduleLimit?: number };
  const workerId = String(body.workerId ?? `ingestion-worker:${crypto.randomUUID()}`).slice(0, 200);
  await supabase.rpc("schedule_due_ingestion_jobs", { p_limit: Math.max(1, Math.min(Number(body.scheduleLimit ?? 20), 100)) });
  const { data, error } = await supabase.rpc("claim_ingestion_runs", { p_worker: workerId, p_limit: Math.max(1, Math.min(Number(body.limit ?? 3), 10)) });
  if (error) return Response.json({ error: error.message }, { status: 500 });
  const runs = (data ?? []) as Run[]; const results: unknown[] = [];
  for (const run of runs) { try { results.push({ id: run.id, ...(await executeRun(run)) }); } catch (runError) { results.push(await failRun(run, runError)); } }
  return Response.json({ workerId, claimed: runs.length, results });
});
