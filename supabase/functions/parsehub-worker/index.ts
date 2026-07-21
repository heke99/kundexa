import { createClient } from "npm:@supabase/supabase-js@2.110.7";
import { decryptJson } from "../_shared/crypto.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const encryptionKey = Deno.env.get("KUNDEXA_ENCRYPTION_KEY")!;
const cronSecret = Deno.env.get("CRON_SECRET")!;
const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
const MAX_RESPONSE_BYTES = 50 * 1024 * 1024;
const MAX_ROWS = 10_000;
const MAX_COLUMNS = 300;
const MAX_CELL_CHARACTERS = 50_000;

type JsonObject = Record<string, unknown>;
type MappingRule = { source?: string | string[]; default?: unknown; separator?: string; transforms?: string[]; required?: boolean };
type Mapping = {
  company?: Record<string, MappingRule>;
  contacts?: { recordsPath?: string; fields?: Record<string, MappingRule> };
  mergePolicy?: string;
};
type ClaimedRun = {
  id: string;
  tenant_id: string;
  parsehub_project_id: string;
  import_profile_id: string | null;
  import_run_id: string | null;
  run_token_ciphertext: string;
  idempotency_key: string;
  attempts: number;
  run_token_hash: string;
};

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function safeErrorCode(error: unknown) {
  const message = error instanceof Error ? error.message : "parsehub_worker_failed";
  return message.replace(/[^a-zA-Z0-9:_-]/g, "_").slice(0, 180);
}
async function sha256(value: string | Uint8Array) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const input = Uint8Array.from(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input.buffer));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function normalizeKey(value: string) {
  return value.trim().toLocaleLowerCase("sv-SE").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}
function boundedValue(value: unknown): string | number | boolean | null | JsonObject | unknown[] {
  if (value == null || typeof value === "boolean" || typeof value === "number") return value as number | boolean | null;
  if (typeof value === "string") return value.slice(0, MAX_CELL_CHARACTERS);
  if (Array.isArray(value)) return value.slice(0, MAX_ROWS).map(boundedValue);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).slice(0, MAX_COLUMNS).map(([key, item]) => [normalizeKey(key) || "field", boundedValue(item)]));
  return String(value).slice(0, MAX_CELL_CHARACTERS);
}
function normalizeRow(value: unknown): JsonObject {
  if (!isRecord(value)) throw new Error("parsehub_record_not_object");
  const entries = Object.entries(value);
  if (entries.length > MAX_COLUMNS) throw new Error("parsehub_too_many_columns");
  return Object.fromEntries(entries.map(([key, item]) => [normalizeKey(key) || "field", boundedValue(item)]));
}

function pathTokens(path: string) {
  if (!path.trim()) return [] as Array<string | number | "*">;
  const tokens: Array<string | number | "*"> = [];
  const pattern = /(?:^|\.)([^.[\]]+)|\[(\*|\d+)\]/g;
  let match: RegExpExecArray | null;
  let consumed = 0;
  while ((match = pattern.exec(path)) !== null) {
    if (match.index !== consumed) throw new Error("json_path_invalid");
    tokens.push(match[1] ?? (match[2] === "*" ? "*" : Number(match[2])));
    consumed = pattern.lastIndex;
  }
  if (consumed !== path.length) throw new Error("json_path_invalid");
  return tokens;
}
function resolvePath(root: unknown, path?: string | null): unknown[] {
  if (!path?.trim()) return [root];
  let values: unknown[] = [root];
  for (const token of pathTokens(path)) {
    const next: unknown[] = [];
    for (const value of values) {
      if (token === "*") {
        if (Array.isArray(value)) next.push(...value);
      } else if (typeof token === "number") {
        if (Array.isArray(value) && token < value.length) next.push(value[token]);
      } else if (isRecord(value) && token in value) next.push(value[token]);
    }
    values = next;
  }
  return values;
}
function resolveFirst(root: unknown, path: string) {
  return resolvePath(root, path)[0];
}
function recordsFromPayload(payload: unknown, path?: string | null) {
  const candidates = resolvePath(payload, path);
  const flattened = candidates.flatMap((value) => Array.isArray(value) ? value : [value]);
  if (!path && isRecord(payload)) {
    const arrays = Object.values(payload).filter(Array.isArray);
    if (arrays.length === 1) return (arrays[0] as unknown[]).slice(0, MAX_ROWS).map(normalizeRow);
  }
  if (!flattened.length || flattened.some((value) => !isRecord(value))) throw new Error(path ? "parsehub_records_path_invalid" : "parsehub_records_path_required");
  if (flattened.length > MAX_ROWS) throw new Error("parsehub_row_limit_exceeded");
  return flattened.map(normalizeRow);
}

function luhn(value: string) {
  let sum = 0;
  for (let index = 0; index < value.length; index++) {
    let digit = Number(value[index]) * (index % 2 === 0 ? 2 : 1);
    if (digit > 9) digit -= 9;
    sum += digit;
  }
  return sum % 10 === 0;
}
function normalizeOrg(value: unknown) {
  let digits = String(value ?? "").trim().toUpperCase().replace(/^SE/, "").replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("16")) digits = digits.slice(2);
  if (digits.length === 12 && digits.endsWith("01")) digits = digits.slice(0, 10);
  if (digits.length !== 10 || !luhn(digits)) return null;
  return digits;
}
function normalizePhone(value: unknown) {
  let raw = String(value ?? "").trim().replace(/[\s().-]/g, "");
  if (!raw) return null;
  if (raw.startsWith("00")) raw = `+${raw.slice(2)}`;
  else if (raw.startsWith("0")) raw = `+46${raw.slice(1)}`;
  else if (raw.startsWith("46")) raw = `+${raw}`;
  if (!/^\+[1-9]\d{6,14}$/.test(raw)) return null;
  return raw;
}
function parseNumber(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const result = Number(String(value ?? "").trim().replace(/\s/g, "").replace(/\.(?=\d{3}(?:\D|$))/g, "").replace(",", ".").replace(/[^\d+\-.]/g, ""));
  return Number.isFinite(result) ? result : null;
}
function parseBoolean(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "ja", "j", "x"].includes(normalized)) return true;
  if (["0", "false", "no", "nej", "n", ""].includes(normalized)) return false;
  return null;
}
function applyTransform(value: unknown, transform: string): unknown {
  if (value == null) return null;
  if (transform === "trim") return String(value).trim();
  if (transform === "lowercase") return String(value).toLocaleLowerCase("sv-SE");
  if (transform === "uppercase") return String(value).toLocaleUpperCase("sv-SE");
  if (transform === "titlecase") return String(value).toLocaleLowerCase("sv-SE").replace(/(^|[\s-])\p{L}/gu, (match) => match.toLocaleUpperCase("sv-SE"));
  if (transform === "string") return String(value);
  if (transform === "number") return parseNumber(value);
  if (transform === "integer") { const number = parseNumber(value); return number == null ? null : Math.trunc(number); }
  if (transform === "boolean") return parseBoolean(value);
  if (transform === "date") { const date = new Date(String(value)); return Number.isNaN(date.valueOf()) ? null : date.toISOString(); }
  if (transform === "percent") { const number = parseNumber(value); return number == null ? null : (Math.abs(number) > 1 ? number : number * 100); }
  if (transform === "phone_e164") return normalizePhone(value);
  if (transform === "organization_number") return normalizeOrg(value);
  throw new Error("mapping_transform_invalid");
}
function valueForRule(row: unknown, rule: MappingRule) {
  const paths = typeof rule.source === "string" ? [rule.source] : rule.source ?? [];
  const values = paths.map((path) => resolveFirst(row, path)).filter((value) => value != null && String(value).trim() !== "");
  if (!values.length) return rule.default ?? null;
  return values.length === 1 ? values[0] : values.map(String).join(rule.separator ?? " ");
}
function mapFields(row: unknown, rules: Record<string, MappingRule>, scope: string) {
  const data: JsonObject = {};
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const [target, rule] of Object.entries(rules)) {
    let value = valueForRule(row, rule);
    for (const transform of rule.transforms ?? []) value = applyTransform(value, transform);
    if (value == null || String(value).trim() === "") {
      if (rule.required) errors.push(`${scope}.${target}:required`);
      data[target] = null;
    } else data[target] = boundedValue(value);
    if ((target.includes("phone") && valueForRule(row, rule) && !value) || (target === "organization_number" && valueForRule(row, rule) && !value)) warnings.push(`${scope}.${target}:invalid`);
  }
  return { data, errors, warnings };
}
function mapRecord(row: JsonObject, mapping: Mapping) {
  const companyResult = mapFields(row, mapping.company ?? {}, "company");
  const company = companyResult.data;
  if (!company.display_name && company.company_name) company.display_name = company.company_name;
  if (!company.company_name && company.display_name) company.company_name = company.display_name;
  if (!company.display_name) companyResult.errors.push("company.display_name:required");
  const contacts: JsonObject[] = [];
  const errors = [...companyResult.errors];
  const warnings = [...companyResult.warnings];
  if (mapping.contacts) {
    const sourceRows = mapping.contacts.recordsPath ? resolvePath(row, mapping.contacts.recordsPath).flatMap((value) => Array.isArray(value) ? value : [value]) : [row];
    for (const source of sourceRows) {
      const result = mapFields(source, mapping.contacts.fields ?? {}, "contact");
      if (!result.data.full_name) result.data.full_name = [result.data.first_name, result.data.last_name].filter(Boolean).join(" ").trim() || null;
      if (result.data.full_name || result.data.phone_e164 || result.data.email) contacts.push(result.data);
      errors.push(...result.errors); warnings.push(...result.warnings);
    }
  }
  const normalized: JsonObject = { ...company, customer_type: "company", contacts, merge_policy: mapping.mergePolicy ?? "safe_upsert" };
  return { normalized, errors, warnings };
}

async function fetchParseHubData(runToken: string, apiKey: string) {
  const url = new URL(`https://www.parsehub.com/api/v2/runs/${encodeURIComponent(runToken)}/data`);
  url.searchParams.set("api_key", apiKey);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  try {
    const response = await fetch(url, { headers: { accept: "application/json", "user-agent": "Kundexa-ParseHub/1.0" }, signal: controller.signal });
    if (response.status === 429 || response.status >= 500) throw new Error(`parsehub_retryable_${response.status}`);
    if (!response.ok) throw new Error(`parsehub_http_${response.status}`);
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > MAX_RESPONSE_BYTES) throw new Error("parsehub_response_too_large");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new Error("parsehub_response_too_large");
    return { bytes, payload: JSON.parse(new TextDecoder().decode(bytes)) as unknown };
  } finally {
    clearTimeout(timeout);
  }
}

async function processRun(run: ClaimedRun) {
  const projectResult = await supabase.from("parsehub_projects").select("id,tenant_id,provider_account_id,import_profile_id,project_name,source_website,active").eq("id", run.parsehub_project_id).single();
  if (projectResult.error || !projectResult.data?.active) throw new Error("parsehub_project_inactive");
  const project = projectResult.data;
  if (!project.import_profile_id || !project.provider_account_id) throw new Error("parsehub_project_incomplete");
  const profileResult = await supabase.from("import_profiles").select("id,name,current_version,records_path,target_list_id,automatic_commit,active,created_by").eq("id", project.import_profile_id).eq("tenant_id", run.tenant_id).single();
  if (profileResult.error || !profileResult.data?.active) throw new Error("parsehub_profile_inactive");
  const profile = profileResult.data;
  const versionResult = await supabase.from("import_profile_versions").select("id,version,config,field_mapping").eq("tenant_id", run.tenant_id).eq("import_profile_id", profile.id).eq("version", profile.current_version).single();
  if (versionResult.error || !versionResult.data) throw new Error("parsehub_profile_version_missing");
  const accountResult = await supabase.from("provider_accounts").select("credentials_ciphertext,status").eq("tenant_id", run.tenant_id).eq("id", project.provider_account_id).single();
  if (accountResult.error || accountResult.data?.status !== "active" || !accountResult.data.credentials_ciphertext) throw new Error("parsehub_account_inactive");
  const { runToken } = await decryptJson<{ runToken: string }>(run.run_token_ciphertext, encryptionKey);
  const { apiKey } = await decryptJson<{ apiKey: string }>(accountResult.data.credentials_ciphertext, encryptionKey);
  if (!runToken || !apiKey) throw new Error("parsehub_credentials_invalid");

  const downloaded = await fetchParseHubData(runToken, apiKey);
  const responseHash = await sha256(downloaded.bytes);
  const records = recordsFromPayload(downloaded.payload, profile.records_path);
  const mapping = versionResult.data.field_mapping as Mapping;
  const storagePath = `${run.tenant_id}/parsehub/${run.id}-${responseHash}.json`;
  const upload = await supabase.storage.from("imports").upload(storagePath, downloaded.bytes, { contentType: "application/json", upsert: false });
  if (upload.error && !upload.error.message.toLowerCase().includes("already exists")) throw new Error("parsehub_storage_failed");

  const importKey = `parsehub:${run.idempotency_key}:${versionResult.data.id}:${profile.target_list_id ?? "crm"}`;
  const existing = await supabase.from("import_runs").select("id,status").eq("tenant_id", run.tenant_id).eq("idempotency_key", importKey).maybeSingle();
  if (existing.error) throw new Error("parsehub_import_lookup_failed");
  let importRunId = existing.data?.id ?? null;
  if (!importRunId) {
    const created = await supabase.from("import_runs").insert({
      tenant_id: run.tenant_id,
      name: `ParseHub – ${project.project_name}`,
      source_type: "json",
      source_file_path: storagePath,
      status: "validating",
      uploaded_by: profile.created_by,
      total_rows: records.length,
      simulation: !profile.automatic_commit,
      file_mime_type: "application/json",
      file_size_bytes: downloaded.bytes.byteLength,
      scan_status: "clean",
      scan_provider: "parsehub_https_json",
      scan_sha256: responseHash,
      scan_completed_at: new Date().toISOString(),
      file_sha256: responseHash,
      idempotency_key: importKey,
      import_profile_id: profile.id,
      import_profile_version_id: versionResult.data.id,
      profile_version: versionResult.data.version,
      profile_snapshot: { profile: { id: profile.id, name: profile.name }, version: versionResult.data.version, config: versionResult.data.config, mapping },
      field_mapping: mapping,
      source_provider: "parsehub",
      source_website: project.source_website,
      source_project: project.project_name,
      source_run_id: run.run_token_hash,
      source_retrieved_at: new Date().toISOString(),
      records_path: profile.records_path,
      target_list_id: profile.target_list_id,
      validation_report: { response_sha256: responseHash, parsehub_run_id: run.id },
    }).select("id").single();
    if (created.error || !created.data) throw new Error("parsehub_import_create_failed");
    importRunId = created.data.id;

    let valid = 0; let warningCount = 0; let errorCount = 0;
    const mappedRows = records.map((record, index) => {
      const result = mapRecord(record, mapping);
      if (result.errors.length) errorCount++; else if (result.warnings.length) warningCount++; else valid++;
      return {
        tenant_id: run.tenant_id,
        import_run_id: importRunId,
        row_number: index + 1,
        raw_data: record,
        normalized_data: result.normalized,
        decision: result.errors.length ? "error" : result.warnings.length ? "warning" : "ready",
        row_status: result.errors.length ? "invalid" : result.warnings.length ? "warning" : "valid",
        error_code: result.errors[0] ?? null,
        errors: result.errors.map((code) => ({ code })),
        warning_codes: result.warnings,
        source_external_id: typeof result.normalized.source_external_id === "string" ? result.normalized.source_external_id : null,
      };
    });
    for (let offset = 0; offset < mappedRows.length; offset += 500) {
      const inserted = await supabase.from("import_rows").insert(mappedRows.slice(offset, offset + 500));
      if (inserted.error) throw new Error("parsehub_rows_insert_failed");
    }
    const finalStatus = errorCount === mappedRows.length ? "mapping_required" : "preview_ready";
    const updated = await supabase.from("import_runs").update({
      status: finalStatus,
      error_count: errorCount,
      warning_count: warningCount,
      validation_report: { valid_rows: valid, warning_rows: warningCount, error_rows: errorCount, response_sha256: responseHash, parsehub_run_id: run.id },
    }).eq("id", importRunId);
    if (updated.error) throw new Error("parsehub_import_finalize_failed");
  }

  const linked = await supabase.from("parsehub_runs").update({ import_run_id: importRunId, response_sha256: responseHash, response_size_bytes: downloaded.bytes.byteLength, source_retrieved_at: new Date().toISOString() }).eq("id", run.id);
  if (linked.error) throw new Error("parsehub_run_link_failed");
  if (profile.automatic_commit) {
    const committed = await supabase.rpc("process_parsehub_import_run", { p_parsehub_run_id: run.id });
    if (committed.error) throw new Error(`parsehub_auto_commit_failed:${committed.error.code ?? "rpc"}`);
  }
  const completed = await supabase.from("parsehub_runs").update({ status: "completed", run_completed_at: new Date().toISOString(), locked_at: null, locked_by: null, last_error_code: null, next_attempt_at: null }).eq("id", run.id);
  if (completed.error) throw new Error("parsehub_run_complete_failed");
  return { runId: run.id, importRunId, rows: records.length, automaticCommit: profile.automatic_commit };
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return new Response("method_not_allowed", { status: 405 });
  if (!cronSecret || request.headers.get("x-cron-secret") !== cronSecret) return new Response("unauthorized", { status: 401 });
  const worker = `parsehub-${crypto.randomUUID()}`;
  const claim = await supabase.rpc("claim_parsehub_runs", { p_worker: worker, p_limit: 5 });
  if (claim.error) return Response.json({ error: "claim_failed" }, { status: 500 });
  const results: unknown[] = [];
  for (const run of (claim.data ?? []) as ClaimedRun[]) {
    try {
      results.push(await processRun(run));
    } catch (error) {
      const code = safeErrorCode(error);
      const retryable = code.includes("retryable") || code.includes("fetch") || code.includes("timeout") || code.includes("storage") || code.includes("insert");
      const exhausted = run.attempts >= 8;
      const delaySeconds = Math.min(3600, 30 * (2 ** Math.max(0, run.attempts - 1)));
      await supabase.from("parsehub_runs").update({
        status: retryable && !exhausted ? "queued" : "failed",
        last_error_code: code,
        next_attempt_at: retryable && !exhausted ? new Date(Date.now() + delaySeconds * 1000).toISOString() : null,
        locked_at: null,
        locked_by: null,
      }).eq("id", run.id);
      results.push({ runId: run.id, error: code, retry: retryable && !exhausted });
    }
  }
  return Response.json({ worker, claimed: (claim.data ?? []).length, results });
});
