import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
import ts from "typescript";

const root = new URL("../", import.meta.url).pathname;
const migrationDir = join(root, "supabase/migrations");
const migrations = (await readdir(migrationDir)).filter((name) => name.endsWith(".sql")).sort();
assert.ok(migrations.length >= 18, "Expected at least eighteen migrations");
for (let i = 1; i < migrations.length; i++) assert.ok(migrations[i] > migrations[i - 1], "Migrations must be ordered");
const sql = (await Promise.all(migrations.map((name) => readFile(join(migrationDir, name), "utf8")))).join("\n");

for (const table of [
  "tenants", "tenant_memberships", "teams", "offices", "departments", "tenant_legal_entities",
  "customers", "import_runs", "campaigns", "deals", "calls", "sms_messages", "email_messages",
  "contracts", "contract_versions", "contract_acceptances", "evidence_packages", "automation_rules",
  "automation_runs", "webhook_endpoints", "audit_logs", "outbox_jobs", "data_providers", "provider_accounts",
  "provider_permissions", "provider_field_permissions", "ingestion_jobs", "raw_payloads", "master_entities",
  "source_entities", "source_facts", "field_values", "entity_freshness", "enrichment_jobs", "enrichment_errors",
  "segments", "segment_rules", "nix_checks", "contact_permissions", "retention_policies",
]) assert.match(sql, new RegExp(`create table(?: if not exists)? public\\.${table}\\b`, "i"), `Missing ${table}`);

for (const [pattern, message] of [
  [/enable row level security/i, "RLS must be enabled"],
  [/prevent_tenant_move/i, "tenant_id immutability is required"],
  [/prevent_locked_contract_version_update/i, "locked contract versions must be immutable"],
  [/claim_outbox_jobs/i, "transactional outbox claim is required"],
  [/claim_automation_runs/i, "atomic automation leasing is required"],
  [/create_contract_draft_v2/i, "version-bound contract creation is required"],
  [/prepare_contract_delivery/i, "atomic contract delivery is required"],
  [/record_contract_acceptance/i, "atomic acceptance decision is required"],
  [/activate_automation/i, "controlled automation activation is required"],
  [/enqueue_outgoing_webhook_event/i, "outgoing webhook routing is required"],
  [/process_import_run/i, "transactional import execution is required"],
  [/rollback_import_run/i, "import rollback is required"],
  [/evaluate_contact_policy_for_tenant/i, "central contact policy is required"],
  [/reserve_usage_for_tenant/i, "atomic usage reservation is required"],
  [/queue_sms_message_for_tenant/i, "service SMS queue is required"],
  [/queue_email_message_for_tenant/i, "service email queue is required"],
  [/directory_search_for_tenant/i, "licensed local directory search is required"],
  [/claim_enrichment_jobs/i, "enrichment worker leasing is required"],
  [/complete_enrichment_job/i, "atomic source-fact resolution is required"],
  [/fail_enrichment_job/i, "enrichment retry/dead-end handling is required"],
  [/configure_generic_json_provider/i, "atomic provider configuration is required"],
  [/provider_network_allowlists/i, "provider webhook allowlist must be data driven"],
  [/revoke all on function public\.claim_outbox_jobs[\s\S]*from public, ?anon, ?authenticated/i, "outbox worker RPC must be service-only"],
  [/revoke all on function public\.claim_enrichment_jobs[\s\S]*from public, ?anon, ?authenticated/i, "enrichment worker RPC must be service-only"],
]) assert.match(sql, pattern, message);

function normalizeAcceptanceText(value) {
  return value.trim().toLocaleUpperCase("sv-SE").replace(/[.,!?:;]+$/g, "").replace(/\s+/g, " ");
}
function decideAcceptance(input, code, allowCodeLess = false, allowed = ["JA", "OK", "GODKÄNNER", "ACCEPTERAR"], declined = ["NEJ", "AVSTÅR"]) {
  const normalized = normalizeAcceptanceText(input);
  const normalizedCode = normalizeAcceptanceText(code);
  const acceptPhrases = allowed.map(normalizeAcceptanceText);
  const declinePhrases = declined.map(normalizeAcceptanceText);
  if (normalizedCode && acceptPhrases.some((phrase) => normalized === `${phrase} ${normalizedCode}`)) return "accepted";
  if (normalizedCode && declinePhrases.some((phrase) => normalized === `${phrase} ${normalizedCode}`)) return "declined";
  if (allowCodeLess && acceptPhrases.includes(normalized)) return "accepted";
  if (allowCodeLess && declinePhrases.includes(normalized)) return "declined";
  return "manual_review";
}
assert.equal(decideAcceptance("ja K7P4", "K7P4"), "accepted");
assert.equal(decideAcceptance("Godtar X9", "X9", false, ["GODTAR"]), "accepted");
assert.equal(decideAcceptance("ja men bara om priset sänks", "K7P4", true), "manual_review");
assert.equal(decideAcceptance("ja K7P5", "K7P4"), "manual_review");
assert.equal(decideAcceptance("ja", "K7P4"), "manual_review");

const edgeFiles = [
  "supabase/functions/process-outbox/index.ts",
  "supabase/functions/automation-runner/index.ts",
  "supabase/functions/data-worker/index.ts",
  "supabase/functions/_shared/crypto.ts",
];
for (const relative of edgeFiles) {
  const file = join(root, relative);
  assert.ok((await stat(file)).size > 100, `${relative} is unexpectedly empty`);
  const source = await readFile(file, "utf8");
  const transpiled = ts.transpileModule(source, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  const errors = (transpiled.diagnostics ?? []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  assert.equal(errors.length, 0, `${relative} contains TypeScript syntax errors`);
}

const outboxWorker = await readFile(join(root, "supabase/functions/process-outbox/index.ts"), "utf8");
for (const job of ["sms.send", "call.start", "email.send", "recording.download", "evidence.generate", "contract.confirmation", "webhook.deliver"]) {
  assert.match(outboxWorker, new RegExp(job.replace(".", "\\.")), `Outbox worker does not support ${job}`);
}
assert.doesNotMatch(outboxWorker, /increment_usage/, "Worker must not double-count usage after database reservation");
assert.match(outboxWorker, /queue_email_message_for_tenant/, "Contract confirmation email must use atomic service queue");
assert.match(outboxWorker, /queue_sms_message_for_tenant/, "Contract confirmation SMS must use atomic service queue");

const automationWorker = await readFile(join(root, "supabase/functions/automation-runner/index.ts"), "utf8");
for (const action of ["create_activity", "block_contact", "update_status", "assign_customer", "send_sms", "send_email"]) {
  assert.match(automationWorker, new RegExp(action), `Automation worker does not support ${action}`);
}
assert.match(automationWorker, /queue_sms_message_for_tenant/, "Automation SMS must pass the central database policy");
assert.match(automationWorker, /queue_email_message_for_tenant/, "Automation email must pass the central database policy");
assert.doesNotMatch(automationWorker, /from\("sms_messages"\)\.upsert/, "Automation must not split message and outbox transactions");

const dataWorker = await readFile(join(root, "supabase/functions/data-worker/index.ts"), "utf8");
for (const pattern of [/claim_enrichment_jobs/, /complete_enrichment_job/, /fail_enrichment_job/, /allowed_domains/, /redirect: "manual"/, /provider_private_network_forbidden/, /encryptJson\(payload/]) {
  assert.match(dataWorker, pattern, `Data worker invariant missing: ${pattern}`);
}

const apiAuth = await readFile(join(root, "src/lib/api-auth.ts"), "utf8");
assert.match(apiAuth, /identity\.source === "api_key" \? createAdminClient\(\) : createClient\(\)/, "Session API calls must retain RLS");
const directoryLib = await readFile(join(root, "src/lib/directory.ts"), "utf8");
assert.match(directoryLib, /shared_entity_refresh_managed_by_license_owner/, "Cross-tenant catalogue refresh must not mutate shared master data under another licence");

for (const relative of [
  "src/app/api/v1/directory/search/route.ts",
  "src/app/api/v1/directory/entities/[id]/route.ts",
  "src/app/api/v1/directory/entities/[id]/refresh/route.ts",
  "src/app/api/v1/enrichment/jobs/route.ts",
  "src/app/api/v1/segments/route.ts",
  "src/app/api/v1/segments/preview/route.ts",
  "src/lib/domain/template.ts",
]) assert.ok((await stat(join(root, relative))).size > 100, `Missing implementation ${relative}`);

const templatesAction = await readFile(join(root, "src/app/actions/contracts.ts"), "utf8");
assert.match(templatesAction, /renderStrictTemplate/, "Contract creation must render the approved version, not hard-coded terms");
assert.match(templatesAction, /create_contract_draft_v2/, "Contract creation must bind template, price and legal snapshots atomically");

const nextConfig = await readFile(join(root, "next.config.ts"), "utf8");
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
assert.doesNotMatch(nextConfig, /outputFileTracingExcludes/, "Production tracing must not exclude framework runtime files");
if (/ignoreBuildErrors\s*:\s*true/.test(nextConfig)) {
  assert.match(packageJson.scripts.build, /^npm run typecheck && npm run build:next$/, "Next's duplicate checker may only be disabled when the public build hard-fails on the canonical typecheck first");
  assert.equal(packageJson.scripts["build:next"], "node scripts/build-next.mjs", "The internal build command must use the deterministic Next wrapper");
  const buildNext = await readFile(join(root, "scripts/build-next.mjs"), "utf8");
  assert.match(buildNext, /NEXT_TELEMETRY_DISABLED/, "The deterministic build wrapper must disable network telemetry");
  assert.match(buildNext, /NEXT_PRIVATE_BUILD_WORKER/, "The deterministic build wrapper must pin the build worker");
}

assert.equal(packageJson.dependencies.next, "16.2.10");
assert.equal(packageJson.dependencies["@supabase/ssr"], "0.12.3");
assert.equal(packageJson.dependencies["@supabase/supabase-js"], "2.110.7");
assert.equal(packageJson.engines.node, ">=22.0.0");
assert.equal(packageJson.overrides.postcss, "8.5.19");
assert.equal(packageJson.scripts["functions:deploy"], "node scripts/deploy-functions.mjs");
const deployFunctions = await readFile(join(root, "scripts/deploy-functions.mjs"), "utf8");
for (const worker of ["process-outbox", "automation-runner", "data-worker"]) assert.match(deployFunctions, new RegExp(worker), `Deployment must include ${worker}`);
assert.match(packageJson.scripts.verify, /typecheck:edge/, "Full verification must type-check Edge Functions");

console.log(`Verified ${migrations.length} migrations, central tenant/contact policy, contracts, imports, communications, provider licensing, local directory, enrichment worker and API scopes.`);
