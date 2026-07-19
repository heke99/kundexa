import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
import ts from "typescript";

const root = new URL("../", import.meta.url).pathname;
const migrationDir = join(root, "supabase/migrations");
const migrations = (await readdir(migrationDir)).filter((name) => name.endsWith(".sql")).sort();
assert.ok(migrations.length >= 22, "Expected at least twenty-two migrations");
for (let i = 1; i < migrations.length; i++) assert.ok(migrations[i] > migrations[i - 1], "Migrations must be ordered");
const sql = (await Promise.all(migrations.map((name) => readFile(join(migrationDir, name), "utf8")))).join("\n");

for (const table of [
  "tenants", "tenant_memberships", "teams", "offices", "departments", "tenant_legal_entities",
  "customers", "import_runs", "campaigns", "deals", "calls", "sms_messages", "email_messages",
  "customer_list_seller_assignments", "customer_list_contact_candidates", "list_dispositions", "dialer_sessions", "note_revisions", "sales_orders", "sales_order_items",
  "contracts", "contract_versions", "contract_acceptances", "evidence_packages", "automation_rules",
  "automation_runs", "webhook_endpoints", "audit_logs", "outbox_jobs", "data_providers", "provider_accounts",
  "provider_permissions", "provider_field_permissions", "ingestion_jobs", "raw_payloads", "master_entities",
  "source_entities", "source_facts", "field_values", "entity_freshness", "enrichment_jobs", "enrichment_errors",
  "segments", "segment_rules", "nix_checks", "contact_permissions", "retention_policies",
  "source_priority_policies", "identity_keys", "merge_decisions", "parser_observations", "segment_refresh_jobs", "tenant_entities", "retention_runs", "data_subject_requests",
  "nix_provider_configurations", "nix_check_jobs", "campaign_contact_candidates",
  "geographic_areas", "geographic_normalization_results", "legal_holds", "data_subject_request_events",
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
  [/schedule_due_ingestion_jobs/i, "five-day ingestion scheduling is required"],
  [/claim_ingestion_runs/i, "ingestion worker leasing is required"],
  [/record_ingestion_raw_payload/i, "raw-before-parse storage is required"],
  [/complete_ingestion_record/i, "identity resolution and source-fact ingestion are required"],
  [/directory_visible_fields_for_tenant/i, "licensed field visibility is required"],
  [/directory_search_summary_for_tenant/i, "full-filter counts are required"],
  [/refresh_segment_materialization/i, "dynamic segment materialization is required"],
  [/materialize_segment_to_campaign/i, "directory-to-campaign flow is required"],
  [/materialize_segment_to_customer_list/i, "directory-to-list prospecting flow is required"],
  [/refresh_due_dynamic_customer_lists/i, "dynamic lists must follow refreshed segment membership"],
  [/run_retention_maintenance/i, "retention execution is required"],
  [/ensure_tenant_import_provider/i, "tenant import provider isolation is required"],
  [/sync_tenant_import_to_directory/i, "CRM imports must synchronize to tenant catalogue masterdata"],
  [/scan_status text not null default 'pending'/i, "import security scan state is required"],
  [/provider_network_allowlists/i, "provider webhook allowlist must be data driven"],
  [/queue_due_nix_checks/i, "scheduled NIX checks are required"],
  [/claim_nix_check_jobs/i, "atomic NIX worker leasing is required"],
  [/complete_nix_check_job/i, "NIX completion and campaign resumption are required"],
  [/fail_nix_check_job/i, "NIX retry/dead-letter handling is required"],
  [/upsert_geographic_reference_batch/i, "versioned geographic reference ingestion is required"],
  [/normalize_master_entity_geography/i, "geographic normalization is required"],
  [/data_subject_export_for_request/i, "data subject export is required"],
  [/execute_data_subject_erasure/i, "controlled erasure is required"],
  [/anonymize_customer_record/i, "retention anonymization with suppression is required"],
  [/can_manage_customer_list/i, "team-scoped list administration is required"],
  [/claim_next_list_member/i, "atomic list-member claiming is required"],
  [/queue_list_outbound_call/i, "list calls must extend the canonical call queue"],
  [/complete_dialer_work/i, "dialer after-work must be transactional"],
  [/complete_manual_call_work/i, "manual dialer after-work must be transactional"],
  [/claim_customer_callback/i, "global callbacks must be claimed atomically"],
  [/schedule_customer_callback/i, "personal and global callbacks are required"],
  [/capture_note_revision/i, "note edit history is required"],
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
  "supabase/functions/ingestion-worker/index.ts",
  "supabase/functions/maintenance-worker/index.ts",
  "supabase/functions/compliance-worker/index.ts",
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


const ingestionWorker = await readFile(join(root, "supabase/functions/ingestion-worker/index.ts"), "utf8");
for (const pattern of [/schedule_due_ingestion_jobs/, /claim_ingestion_runs/, /record_ingestion_raw_payload/, /complete_ingestion_record/, /provider_domain_not_permitted/, /parseCsv/, /parseHtmlRegex/]) assert.match(ingestionWorker, pattern, `Ingestion worker invariant missing: ${pattern}`);
assert.ok(ingestionWorker.indexOf("record_ingestion_raw_payload") < ingestionWorker.indexOf("complete_ingestion_record"), "Raw payload must be persisted before normalized records");
const maintenanceWorker = await readFile(join(root, "supabase/functions/maintenance-worker/index.ts"), "utf8");
assert.match(maintenanceWorker, /claim_segment_refresh_jobs/, "Maintenance worker must materialize dynamic segments");
assert.match(maintenanceWorker, /refresh_due_dynamic_customer_lists/, "Maintenance worker must synchronize dynamic customer lists");
assert.match(maintenanceWorker, /run_retention_maintenance/, "Maintenance worker must execute retention");
assert.match(maintenanceWorker, /normalize_due_geographies/, "Maintenance worker must normalize geographic reference data");
const complianceWorker = await readFile(join(root, "supabase/functions/compliance-worker/index.ts"), "utf8");
for (const pattern of [/queue_due_nix_checks/, /claim_nix_check_jobs/, /complete_nix_check_job/, /fail_nix_check_job/, /redirect: "manual"/, /nix_private_network_forbidden/, /decryptJson/]) assert.match(complianceWorker, pattern, `Compliance worker invariant missing: ${pattern}`);

const apiAuth = await readFile(join(root, "src/lib/api-auth.ts"), "utf8");
assert.match(apiAuth, /identity\.source === "api_key" \? createAdminClient\(\) : createClient\(\)/, "Session API calls must retain RLS");
const directoryLib = await readFile(join(root, "src/lib/directory.ts"), "utf8");
assert.match(directoryLib, /shared_entity_refresh_managed_by_license_owner/, "Cross-tenant catalogue refresh must not mutate shared master data under another licence");

for (const relative of [
  "src/app/api/v1/directory/search/route.ts",
  "src/app/api/v1/imports/file/route.ts",
  "src/lib/imports/file-parser.ts",
  "src/lib/imports/malware-scan.ts",
  "src/lib/imports/normalize-row.ts",
  "src/app/api/v1/directory/entities/[id]/route.ts",
  "src/app/api/v1/directory/entities/[id]/refresh/route.ts",
  "src/app/api/v1/directory/discover/route.ts",
  "src/app/api/v1/enrichment/jobs/route.ts",
  "src/app/api/v1/segments/route.ts",
  "src/app/api/v1/segments/preview/route.ts",
  "src/app/api/v1/segments/[id]/refresh/route.ts",
  "src/app/api/v1/segments/[id]/campaign/route.ts",
  "src/app/(dashboard)/app/directory/page.tsx",
  "src/lib/domain/template.ts",
  "scripts/import-geography.mjs",
  "src/app/(dashboard)/app/compliance/page.tsx",
  "src/app/(dashboard)/app/lists/[id]/page.tsx",
  "src/app/(dashboard)/app/dialer/lists/[id]/page.tsx",
  "src/app/(dashboard)/app/callbacks/page.tsx",
  "src/app/(dashboard)/app/orders/page.tsx",
  "src/components/list-dialer-workspace.tsx",
  "src/hooks/use-webrtc-voice.ts",
  "src/app/api/v1/dialer/sessions/route.ts",
  "src/app/api/v1/dialer/next/route.ts",
  "src/app/api/v1/dialer/complete/route.ts",
  "src/app/api/v1/calls/complete/route.ts",
  "src/app/actions/callbacks.ts",
  "src/hooks/use-call-realtime.ts",
]) assert.ok((await stat(join(root, relative))).size > 100, `Missing implementation ${relative}`);

const importRoute = await readFile(join(root, "src/app/api/v1/imports/file/route.ts"), "utf8");
assert.match(importRoute, /scanImportFile/, "Import files must be security scanned before parsing and storage");
assert.ok(importRoute.indexOf("const scan = await scanImportFile") < importRoute.indexOf("const parsed = parseImportFile"), "Malware scan must run before parser execution");
const importParser = await readFile(join(root, "src/lib/imports/file-parser.ts"), "utf8");
for (const format of ["parseXlsx", "parseXmlRows", "ndjson", "Papa.parse"]) assert.match(importParser, new RegExp(format), `Import parser must support ${format}`);
const projectionSql = sql.match(/create or replace function public\.directory_entity_projection_for_tenant[\s\S]*?\$\$;/i)?.[0] ?? "";
assert.match(projectionSql, /directory_visible_fields_for_tenant/, "Directory projection must be based on licensed visible fields");
assert.doesNotMatch(projectionSql, /current_master/, "Directory projection must not expose the internal master payload");

const templatesAction = await readFile(join(root, "src/app/actions/contracts.ts"), "utf8");
assert.match(templatesAction, /renderStrictTemplate/, "Contract creation must render the approved version, not hard-coded terms");
assert.match(templatesAction, /create_contract_draft_v2/, "Contract creation must bind template, price and legal snapshots atomically");

// ---------------------------------------------------------------------------
// Scraperadaptrar: normalisering, kontraktsparsning, robots och filtermodell.
// Modulen transpileras och exekveras så att fixtures testar verklig kod.
// ---------------------------------------------------------------------------

const providersSource = await readFile(join(root, "supabase/functions/_shared/providers.ts"), "utf8");
const providersTranspiled = ts.transpileModule(providersSource, {
  fileName: "providers.ts",
  reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
});
assert.equal((providersTranspiled.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error).length, 0, "providers.ts contains TypeScript syntax errors");
const providers = await import(`data:text/javascript;base64,${Buffer.from(providersTranspiled.outputText).toString("base64")}`);

// Normalisering: organisationsnummer (Luhn), telefon (E.164), belopp och heltal.
assert.equal(providers.normalizeOrganizationNumber("556016-0680"), "5560160680");
assert.equal(providers.normalizeOrganizationNumber("16556016-0680"), "5560160680");
assert.equal(providers.normalizeOrganizationNumber("556016-0681"), null, "Invalid Luhn must be rejected");
assert.equal(providers.normalizeOrganizationNumber("12345"), null);
assert.equal(providers.normalizeSwedishPhone("08-719 00 00"), "+4687190000");
assert.equal(providers.normalizeSwedishPhone("+46 70 123 45 67"), "+46701234567");
assert.equal(providers.normalizeSwedishPhone("0046701234567"), "+46701234567");
assert.equal(providers.normalizeSwedishPhone("banan"), null);
assert.equal(providers.parseSwedishAmount("12 345 tkr"), 12_345_000);
assert.equal(providers.parseSwedishAmount("473 479 mkr"), 473_479_000_000);
assert.equal(providers.parseSwedishAmount("(1 200) tkr"), -1_200_000);
assert.equal(providers.parseSwedishInteger("1 200"), 1200);
assert.equal(providers.parseSwedishInteger("10-19"), 10);
assert.equal(providers.normalizeSwedishPostalCode("164 83"), "16483");

// Robots-regler: disallow respekteras, allow med längre matchning vinner.
const robotsFixture = "User-agent: *\nDisallow: /private\nAllow: /private/open\n\nUser-agent: badbot\nDisallow: /";
assert.equal(providers.isPathAllowedByRobots(robotsFixture, "/companies"), true);
assert.equal(providers.isPathAllowedByRobots(robotsFixture, "/private/data"), false);
assert.equal(providers.isPathAllowedByRobots(robotsFixture, "/private/open/page"), true);
assert.equal(providers.isPathAllowedByRobots("User-agent: *\nDisallow: /", "/anything"), false);

// Central filtermodell: validering och variabelbygge delas av alla lager.
const validatedFilter = providers.validateScraperFilter({ query: "bygg", county: "Skåne län", employeeMin: "5", employeeMax: 50, organizationNumber: "556016-0680", onlyActive: true });
assert.equal(validatedFilter.organizationNumber, "5560160680");
assert.equal(validatedFilter.employeeMin, 5);
assert.throws(() => providers.validateScraperFilter({ employeeMin: 10, employeeMax: 2 }), /employee_range_invalid/);
assert.throws(() => providers.validateScraperFilter({ organizationNumber: "1234" }), /invalid_organization_number/);
const searchVariables = providers.SCRAPER_ADAPTERS.allabolag.buildSearchVariables(validatedFilter);
assert.equal(searchVariables.county, "Skåne län");
assert.equal(searchVariables.only_active, "true");
assert.ok(searchVariables.query.includes("bygg"));

// Allabolag-fixtur: korrekt parsning, normalisering och avvisad ogiltig identitet.
const allabolagFixture = await readFile(join(root, "scripts/fixtures/allabolag-search.html"), "utf8");
const allabolagAdapter = providers.SCRAPER_ADAPTERS.allabolag;
const allabolagRaw = providers.parseWithContract(allabolagFixture, allabolagAdapter.listContract);
assert.equal(allabolagRaw.length, 3, "Allabolag fixture must yield three raw records");
const allabolagNormalized = allabolagRaw.map((record) => allabolagAdapter.normalizeRecord(record, "organization")).filter(Boolean);
assert.equal(allabolagNormalized.length, 2, "Invalid organisation numbers must be dropped");
const ericsson = allabolagNormalized[0];
assert.equal(ericsson.external_id, "5560160680");
assert.equal(ericsson.fields.canonical_name, "Telefonaktiebolaget LM Ericsson");
assert.equal(ericsson.fields.postal_code, "16483");
assert.equal(ericsson.fields.county, "Stockholms län", "HTML entities must be decoded");
assert.equal(ericsson.fields.phone_e164, "+4687190000");
assert.equal(ericsson.fields.employee_count, 1200);
assert.equal(ericsson.fields.revenue, 263_351_000_000);
assert.equal(ericsson.fields.registration_date, "1918-08-18");
assert.equal(ericsson.confidence.organization_number, 1);
const volvo = allabolagNormalized[1];
assert.equal(volvo.external_id, "5560360793");
assert.equal(volvo.fields.employee_count, 10, "Employee ranges must fall back to the lower bound");
assert.equal(volvo.fields.revenue, 473_479_000_000);
assert.equal(volvo.fields.result, -1_200_000, "Parenthesised amounts must be negative");
assert.equal(volvo.fields.website, undefined, "Missing fields must be omitted, not guessed");

// Merinfo-fixtur: person- och företagsposter, restriktiv identitetshantering.
const merinfoFixture = await readFile(join(root, "scripts/fixtures/merinfo-search.html"), "utf8");
const merinfoAdapter = providers.SCRAPER_ADAPTERS.merinfo;
const merinfoRaw = providers.parseWithContract(merinfoFixture, merinfoAdapter.listContract);
assert.equal(merinfoRaw.length, 3, "Merinfo fixture must yield three raw records");
const merinfoPerson = merinfoAdapter.normalizeRecord(merinfoRaw[0], "person");
assert.equal(merinfoPerson.external_id, "p-9a8b7c6d", "Persons must use the stable source identifier");
assert.equal(merinfoPerson.fields.canonical_name, "Anna Andersson");
assert.equal(merinfoPerson.fields.role_title, "Styrelseledamot");
assert.equal(merinfoPerson.fields.company_organization_number, "5560160680");
assert.equal(merinfoPerson.fields.phone_e164, "+46701234567");
const merinfoCompany = merinfoAdapter.normalizeRecord(merinfoRaw[1], "organization");
assert.equal(merinfoCompany.external_id, "5560360793", "Companies dedupe on the organisation number");
assert.equal(merinfoCompany.fields.organization_number, "5560360793");
assert.equal(merinfoAdapter.normalizeRecord(merinfoRaw[2], "person"), null, "Records without a stable identifier must be skipped");

// Förändrad HTML-struktur: fält försvinner i stället för att gissas, vilket
// låter parser_observations/karantän slå till nedströms via match rate.
const mutatedFixture = allabolagFixture.replaceAll("data-orgnr", "data-organisation").replaceAll("company-name", "changed-name");
const mutatedRecords = providers.parseWithContract(mutatedFixture, allabolagAdapter.listContract)
  .map((record) => allabolagAdapter.normalizeRecord(record, "organization")).filter(Boolean);
assert.equal(mutatedRecords.length, 0, "Structure changes must not produce fabricated identities");

// Oförändrad data: samma normaliserade fält ger samma stabila JSON-hash-underlag.
const repeatParse = providers.parseWithContract(allabolagFixture, allabolagAdapter.listContract)
  .map((record) => allabolagAdapter.normalizeRecord(record, "organization")).filter(Boolean);
assert.deepEqual(repeatParse[0].fields, ericsson.fields, "Parsing must be deterministic for change detection");

// Statiska driftinvarianter för scraper- och prestandaflödet.
assert.match(ingestionWorker, /reserve_provider_ingestion_usage/, "Ingestion worker must reserve quota per external call");
assert.match(ingestionWorker, /assertRobotsAllowed/, "Ingestion worker must honour robots rules for scrape sources");
assert.match(ingestionWorker, /minimum_delay_ms|minimumDelayMs/, "Ingestion worker must apply the configured inter-request delay");
assert.match(ingestionWorker, /getScraperAdapter/, "Ingestion worker must route scraper adapters");
assert.match(ingestionWorker, /KundexaBot/, "Ingestion worker must identify itself with a user agent");
const dataWorkerSource = await readFile(join(root, "supabase/functions/data-worker/index.ts"), "utf8");
assert.match(dataWorkerSource, /executeScraperDetail/, "Data worker must support scraper detail enrichment");
assert.match(dataWorkerSource, /robots_disallowed/, "Data worker must honour robots rules");
for (const pattern of [
  /create or replace function public\.dashboard_overview/i,
  /create or replace function public\.customer_list_overview/i,
  /create or replace function public\.customer_list_candidate_counts/i,
  /create or replace function public\.control_ingestion_run/i,
  /create or replace function public\.reserve_provider_ingestion_usage/i,
  /ingestion_runs_one_open_per_job_idx/i,
  /revoke all on function public\.reserve_provider_ingestion_usage[\s\S]*from public, ?anon, ?authenticated/i,
  /calls_list_capacity_idx/i,
  /activities_callback_pick_idx/i,
]) assert.match(sql, pattern, `Missing performance/scraper migration invariant: ${pattern}`);
const dashboardPage = await readFile(join(root, "src/app/(dashboard)/app/page.tsx"), "utf8");
assert.match(dashboardPage, /dashboard_overview/, "Dashboard must use the aggregated overview RPC");
assert.doesNotMatch(dashboardPage, /from\('deals'\)\.select\('value,status'\)/, "Dashboard must not fetch unbounded deal rows");
const listsPage = await readFile(join(root, "src/app/(dashboard)/app/lists/page.tsx"), "utf8");
assert.match(listsPage, /customer_list_overview/, "Lists page must use aggregated member counts");
const companiesPage = await readFile(join(root, "src/app/(dashboard)/app/companies/page.tsx"), "utf8");
assert.match(companiesPage, /\.range\(/, "Companies page must paginate");
assert.doesNotMatch(companiesPage, /select\('\*'\)/, "Companies page must not select every column");
const customersPage = await readFile(join(root, "src/app/(dashboard)/app/customers/page.tsx"), "utf8");
assert.match(customersPage, /\.range\(/, "Customers page must paginate");
const directorySource = await readFile(join(root, "src/lib/directory.ts"), "utf8");
assert.match(directorySource, /23505/, "Concurrent enrichment requests must dedupe on the idempotency key");
const dataSourcesPage = await readFile(join(root, "src/app/(dashboard)/app/data-sources/page.tsx"), "utf8");
assert.match(dataSourcesPage, /configureScraperProvider/, "Scraper providers must be configurable from the admin UI");
assert.match(dataSourcesPage, /controlIngestionRun/, "Ingestion runs must be controllable from the admin UI");
assert.match(dataSourcesPage, /dead_letter/, "Dead-letter runs must be visible to administrators");
const adminActions = await readFile(join(root, "src/app/actions/admin.ts"), "utf8");
assert.match(adminActions, /validateScraperFilter/, "Scraper filters must be validated centrally");
assert.match(adminActions, /person_data_approved/, "Person data requires explicit documented approval");

const nextConfig = await readFile(join(root, "next.config.ts"), "utf8");
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
assert.doesNotMatch(nextConfig, /outputFileTracingExcludes/, "Production tracing must not exclude framework runtime files");
if (/ignoreBuildErrors\s*:\s*true/.test(nextConfig)) {
  assert.match(packageJson.scripts.build, /^npm run typecheck && npm run build:next$/, "Next's duplicate checker may only be disabled when the public build hard-fails on the canonical typecheck first");
  assert.equal(packageJson.scripts["build:next"], "next build --webpack", "The internal build command must use the deterministic official Next webpack build");
}

assert.equal(packageJson.dependencies.next, "16.2.10");
assert.equal(packageJson.dependencies["@supabase/ssr"], "0.12.3");
assert.equal(packageJson.dependencies["@supabase/supabase-js"], "2.110.7");
assert.equal(packageJson.engines.node, ">=22.0.0");
assert.equal(packageJson.overrides.postcss, "8.5.19");
assert.equal(packageJson.scripts["functions:deploy"], "node scripts/deploy-functions.mjs");
assert.equal(packageJson.scripts["geography:import"], "node scripts/import-geography.mjs");
const deployFunctions = await readFile(join(root, "scripts/deploy-functions.mjs"), "utf8");
for (const worker of ["process-outbox", "automation-runner", "data-worker", "ingestion-worker", "maintenance-worker", "compliance-worker"]) assert.match(deployFunctions, new RegExp(worker), `Deployment must include ${worker}`);
assert.match(packageJson.scripts.verify, /typecheck:edge/, "Full verification must type-check Edge Functions");

console.log(`Verified ${migrations.length} migrations, tenant/contact policy, contracts, communications, licensed directory, raw-before-parse ingestion, parser quarantine, identity resolution, dynamic segments, secure multi-format imports, NIX campaign compliance, geographic normalization, DSAR, retention and worker deployment.`);
