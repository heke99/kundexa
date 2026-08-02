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
  "contracts", "contract_versions", "contract_documents", "contract_recipients", "contract_deliveries",
  "contract_acceptance_requests", "contract_acceptances", "contract_events", "contract_reminder_policies", "contract_reminders", "evidence_packages", "email_delivery_events",
  "signing_envelopes", "signing_recipients", "signing_attempts", "signing_events", "signing_documents", "contract_post_sign_runs", "automation_rules",
  "automation_runs", "webhook_endpoints", "audit_logs", "outbox_jobs", "data_providers", "provider_accounts",
  "provider_permissions", "provider_field_permissions", "ingestion_jobs", "raw_payloads", "master_entities",
  "source_entities", "source_facts", "field_values", "entity_freshness", "enrichment_jobs", "enrichment_errors",
  "segments", "segment_rules", "nix_checks", "contact_permissions", "retention_policies",
  "source_priority_policies", "identity_keys", "merge_decisions", "parser_observations", "segment_refresh_jobs", "tenant_entities", "retention_runs", "data_subject_requests",
  "nix_provider_configurations", "nix_check_jobs", "campaign_contact_candidates",
  "geographic_areas", "geographic_normalization_results", "legal_holds", "data_subject_request_events",
  "import_profiles", "import_profile_versions", "import_field_mappings", "import_merge_conflicts", "parsehub_projects", "parsehub_runs", "import_run_list_targets", "import_change_sets",
  "tenant_invitations", "platform_lists", "platform_list_entries", "platform_list_allocations", "platform_list_allocation_entries",
]) assert.match(sql, new RegExp(`create table(?: if not exists)? public\\.${table}\\b`, "i"), `Missing ${table}`);

for (const [pattern, message] of [
  [/enable row level security/i, "RLS must be enabled"],
  [/prevent_tenant_move/i, "tenant_id immutability is required"],
  [/prevent_locked_contract_version_update/i, "locked contract versions must be immutable"],
  [/claim_outbox_jobs/i, "transactional outbox claim is required"],
  [/claim_automation_runs/i, "atomic automation leasing is required"],
  [/create_contract_draft_v2/i, "version-bound contract creation is required"],
  [/create_contract_draft_v3/i, "complete commercial terms and assignment must be bound atomically"],
  [/is_contract_call_eligible/i, "database-enforced source-call eligibility is required"],
  [/register_external_manual_call/i, "audited external call registration is required"],
  [/assert_contract_sendable_v2/i, "central contract sendability validation is required"],
  [/prepare_contract_delivery_v2/i, "atomic version-two contract delivery is required"],
  [/schedule_manual_contract_reminder/i, "manual contract reminders are required"],
  [/enqueue_due_contract_reminders/i, "scheduled contract reminders are required"],
  [/cancel_contract_reminders/i, "pending reminders must be cancellable atomically"],
  [/record_contract_acceptance_v2/i, "document-bound atomic acceptance is required"],
  [/dead_letter_outbox_job/i, "permanent provider failures require dead-letter handling"],
  [/activate_automation/i, "controlled automation activation is required"],
  [/enqueue_outgoing_webhook_event/i, "outgoing webhook routing is required"],
  [/process_import_run/i, "transactional import execution is required"],
  [/prevent_truncated_import_execution/i, "truncated imports must be blocked in the database"],
  [/apply_rinkel_call_event/i, "Rinkel events require a canonical database reducer"],
  [/correlate_rinkel_incoming_event/i, "incoming Rinkel correlation must be transactional"],
  [/correlate_rinkel_outgoing_event/i, "outgoing Rinkel correlation must be transactional"],
  [/protect_rinkel_call_projection/i, "Rinkel call state must be monotonic"],
  [/apply_resend_delivery_event/i, "Resend events require an immutable monotonic reducer"],
  [/finalize_signing_envelope/i, "multi-recipient signing requires atomic finalization"],
  [/sync_contract_recipient_from_acceptance/i, "legacy acceptance must update the canonical recipient state"],
  [/protect_contract_signing_projection/i, "contracts must not become signed before all required recipients and final evidence exist"],
  [/mark_acceptance_opened/i, "acceptance opening must be idempotent and transactional"],
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
  [/claim_next_list_member_with_contacts/i, "dialer claims must expose selectable contact targets"],
  [/queue_list_outbound_call/i, "list calls must extend the canonical call queue"],
  [/queue_list_outbound_call_target/i, "contact-person calls must extend the canonical call queue"],
  [/apply_import_row_normalization/i, "mapped import rows require a safe batch update RPC"],
  [/claim_parsehub_runs/i, "ParseHub runs require atomic worker leasing"],
  [/complete_dialer_work/i, "dialer after-work must be transactional"],
  [/complete_manual_call_work/i, "manual dialer after-work must be transactional"],
  [/claim_customer_callback/i, "global callbacks must be claimed atomically"],
  [/schedule_customer_callback/i, "personal and global callbacks are required"],
  [/capture_note_revision/i, "note edit history is required"],
  [/create_platform_tenant/i, "platform tenant provisioning is required"],
  [/register_tenant_invitation/i, "audited tenant invitations are required"],
  [/activate_current_user_invitation/i, "invited users must activate the intended tenant"],
  [/list_current_user_tenants/i, "users must only enumerate their own active tenant memberships"],
  [/switch_active_tenant/i, "multi-tenant users need an audited tenant switch"],
  [/can_manage_team/i, "team-lead scoped administration is required"],
  [/update_managed_team/i, "team status and settings must use an audited RPC"],
  [/update_tenant_member/i, "tenant member role, status and reassignment must use an audited RPC"],
  [/membership_scoped_select/i, "team leaders must only read members in teams they manage"],
  [/profiles_scoped_select/i, "tenant profile visibility must follow tenant and team scope"],
  [/drop policy if exists membership_admin_all/i, "direct tenant-membership writes must be removed"],
  [/drop policy if exists memberships_team_manager_select/i, "legacy overlapping membership visibility policy must be removed"],
  [/drop policy if exists profiles_team_manager_select/i, "legacy overlapping profile visibility policy must be removed"],
  [/drop policy if exists teams_admin_write/i, "direct team writes must be removed"],
  [/allocation_name_required/i, "platform allocations require a non-empty tenant list name"],
  [/team_list_name_required/i, "team splits require a non-empty list name"],
  [/allocate_platform_list_to_tenant/i, "central lists must materialize safely into tenant CRM"],
  [/split_customer_list_to_team/i, "tenant lists must be divisible into team work queues"],
  [/revoke_platform_list_allocation/i, "central allocations must be revocable without deleting history"],
  [/release_expired_platform_allocations/i, "time-limited allocations must expire safely"],
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
  "supabase/functions/rinkel-platform-worker/index.ts",
  "supabase/functions/compliance-worker/index.ts",
  "supabase/functions/_shared/crypto.ts",
  "supabase/functions/_shared/reminder-time.ts",
  "supabase/functions/_shared/rinkel.ts",
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
for (const job of ["sms.send", "call.start", "email.send", "recording.download", "evidence.generate", "contract.confirmation", "contract.signed.confirmation", "contract.reminder.dispatch", "webhook.deliver"]) {
  assert.match(outboxWorker, new RegExp(job.replace(".", "\\.")), `Outbox worker does not support ${job}`);
}
assert.match(outboxWorker, /permanent_legacy_46elks_voice_job_disabled_use_rinkel/, "Legacy voice jobs must be dead-lettered without provider execution");
assert.doesNotMatch(outboxWorker, /post46Elks\("calls"/, "46elks must not remain an executable voice provider");
assert.doesNotMatch(outboxWorker, /voice_start/, "The outbox worker must not retain the legacy 46elks voice bridge");
assert.doesNotMatch(outboxWorker, /increment_usage/, "Worker must not double-count usage after database reservation");
assert.match(outboxWorker, /contract-confirmation\//, "Contract acceptance confirmations require stable business idempotency keys");
assert.match(outboxWorker, /contract-signed\//, "Final signed-document confirmations require stable business idempotency keys");
assert.match(outboxWorker, /from\("outbox_jobs"\)\.upsert/, "Contract confirmations must still be dispatched through the durable outbox");
assert.match(outboxWorker, /onConflict: "tenant_id,idempotency_key"/, "Worker-created confirmation records must be idempotent");
assert.match(outboxWorker, /document_id/, "Email attachments must use private document references");
assert.match(outboxWorker, /sha256Bytes/, "Worker must verify attachment hashes before sending");
assert.match(outboxWorker, /Idempotency-Key/, "Resend requests require stable provider idempotency");
assert.match(outboxWorker, /https:\/\/api\.resend\.com\/emails/, "Worker must use the Resend email endpoint");
assert.match(outboxWorker, /enqueue_due_contract_reminders/, "Worker must atomically enqueue due reminders");
assert.match(outboxWorker, /inQuietHours/, "Reminder delivery must respect tenant quiet hours");
assert.doesNotMatch(outboxWorker, /async function processRinkelEvent/, "Legacy tenant Rinkel event processing must be removed from the general outbox worker");
assert.doesNotMatch(outboxWorker, /async function processRinkelEnrichment/, "Legacy tenant Rinkel enrichment must be removed from the general outbox worker");

const resendWebhook = await readFile(join(root, "src/app/api/webhooks/resend/[token]/route.ts"), "utf8");
for (const pattern of [/request\.text\(\)/, /svix-id/, /svix-timestamp/, /svix-signature/, /timingSafeEqual/, /provider_webhook_events/, /provider_message_id/, /resendStatusForEvent/, /isPermanentResendFailure/, /mapped === "delivered"/, /\["complained", "suppressed"\]\.includes\(mapped\)/]) {
  assert.match(resendWebhook, pattern, `Resend webhook invariant missing: ${pattern}`);
}
const contractActions = await readFile(join(root, "src/app/actions/contracts.ts"), "utf8");
for (const pattern of [/source_call_id/, /assertContractCallEligibility/, /ensureCanonicalContractDocument/, /prepare_contract_delivery_v2/, /schedule_manual_contract_reminder/, /cancel_contract_reminders/]) {
  assert.match(contractActions, pattern, `Contract action invariant missing: ${pattern}`);
}
const publicContractActions = await readFile(join(root, "src/app/actions/public-contract.ts"), "utf8");
assert.match(publicContractActions, /record_contract_acceptance_v2/, "Public acceptance must use the document-bound atomic RPC");
assert.match(publicContractActions, /canonical_document_sha256/, "Public acceptance must bind the exact canonical PDF hash");
const contractWizard = await readFile(join(root, "src/app/(dashboard)/app/contracts/new/page.tsx"), "utf8");
assert.match(contractWizard, /Registrera tidigare samtal/, "Manual contract wizard must support audited external calls");
assert.match(contractWizard, /source_call_id/, "Manual contract wizard must select a source call");

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
assert.match(maintenanceWorker, /release_expired_platform_allocations/, "Maintenance worker must release expired platform list allocations");
assert.match(maintenanceWorker, /rinkel\.reconcile_platform/, "Maintenance worker must schedule central Rinkel reconciliation");
assert.match(maintenanceWorker, /rinkel\.retention/, "Maintenance worker must schedule Rinkel retention");
const complianceWorker = await readFile(join(root, "supabase/functions/compliance-worker/index.ts"), "utf8");
for (const pattern of [/queue_due_nix_checks/, /claim_nix_check_jobs/, /complete_nix_check_job/, /fail_nix_check_job/, /redirect: "manual"/, /nix_private_network_forbidden/, /decryptJson/]) assert.match(complianceWorker, pattern, `Compliance worker invariant missing: ${pattern}`);

const apiAuth = await readFile(join(root, "src/lib/api-auth.ts"), "utf8");
assert.match(apiAuth, /identity\.source === "api_key" \? createAdminClient\(\) : createClient\(\)/, "Session API calls must retain RLS");

const rinkelClient = await readFile(join(root, "supabase/functions/_shared/rinkel.ts"), "utf8");
assert.match(rinkelClient, /"x-rinkel-api-key"/, "Rinkel client must use the documented authentication header");
assert.match(rinkelClient, /retrySafe && method === "GET" \? 3 : 1/, "Only safe Rinkel GET calls may retry");
assert.match(rinkelClient, /\/call-recordings\/.*\/stream/, "Rinkel recordings need fresh temporary stream URLs");
assert.match(rinkelClient, /\(\?:v1\\\/\)\?call-recordings/, "Rinkel recording references must accept webhook URLs with and without /v1");
const rinkelWebhook = await readFile(join(root, "src/app/api/webhooks/rinkel/[secret]/[event]/route.ts"), "utf8");
const rinkelWebhookSecurity = await readFile(join(root, "src/lib/webhooks/rinkel.ts"), "utf8");
assert.match(rinkelWebhookSecurity, /process\.env\.VERCEL === "1"/, "Rinkel IP extraction must trust Vercel's controlled forwarding header only on Vercel");
assert.match(rinkelWebhookSecurity, /RINKEL_TRUST_X_REAL_IP/, "Non-Vercel x-real-ip trust must be explicit and disabled by default");
for (const pattern of [/verifyRinkelNetwork/, /authenticatePlatformRinkelWebhook/, /parseRinkelWebhookRequest/, /platform_rinkel_webhook_events/, /rinkel\.process_event/, /ignoreDuplicates: true/]) {
  assert.match(rinkelWebhook, pattern, `Rinkel webhook invariant missing: ${pattern}`);
}
const rinkelCalls = await readFile(join(root, "src/app/api/v1/calls/route.ts"), "utf8");
assert.match(rinkelCalls, /rinkel_reserve_platform_outbound_call/, "Rinkel calls require a central atomic local reservation before provider dial");
assert.match(rinkelCalls, /createPlatformRinkelClient/, "Rinkel calls must use the environment-owned platform credential");
assert.match(rinkelCalls, /client\.dial/, "Rinkel calls must use the canonical provider client");
assert.doesNotMatch(rinkelCalls, /fetch\([^)]*api\.rinkel/, "Rinkel route must not bypass the canonical provider client");
const rinkelMigration = await readFile(join(root, "supabase/migrations/202607300002_central_rinkel_platform.sql"), "utf8");
assert.match(rinkelMigration, /RINKEL_WEBHOOKS_NOT_READY/, "Automatic Rinkel calls need a database-enforced webhook health gate");
assert.match(rinkelMigration, /revoke all on public\.platform_integrations,public\.platform_rinkel_users,public\.platform_rinkel_numbers/, "Raw central Rinkel provider data must not be table-readable by authenticated clients");
assert.match(rinkelMigration, /get_tenant_rinkel_resources/, "Tenants require an explicitly filtered Rinkel resource projection");
assert.doesNotMatch(rinkelMigration, /call_attempts_operator_write/, "Authenticated clients must not mutate provider call attempts directly");
assert.doesNotMatch(rinkelMigration, /call_transcripts_tenant_select/, "Transcript access must follow canonical call access, not tenant-wide visibility");
assert.match(rinkelMigration, /public\.can_access_call\(call_id\)/, "Call artifacts must inherit canonical call access");
const rinkelPlatformWorker = await readFile(join(root, "supabase/functions/rinkel-platform-worker/index.ts"), "utf8");
assert.match(rinkelPlatformWorker, /RINKEL_INCOMING_ALLOCATION_CONFLICT/, "Ambiguous incoming calls must be quarantined");
assert.match(rinkelPlatformWorker, /RINKEL_OUTGOING_CORRELATION_CONFLICT/, "Ambiguous outgoing calls must be quarantined");
const rinkelActions = await readFile(join(root, "src/app/actions/rinkel.ts"), "utf8");
assert.match(rinkelActions, /transcription:\s*false/, "Connection tests must not infer transcription from webhook access");
assert.match(rinkelActions, /ai_insights:\s*false/, "Connection tests must not infer AI Insights from webhook access");
assert.doesNotMatch(rinkelActions, /credentials_ciphertext|decryptJson|encryptJson/, "Rinkel actions must never use tenant credentials");
assert.match(rinkelActions, /replace_rinkel_user_mapping_v2/, "Rinkel seller mapping replacement must be transactional");
assert.match(rinkelMigration, /create or replace function public\.replace_rinkel_user_mapping_v2/, "Central Rinkel mapping replacement RPC is missing");
assert.match(rinkelMigration, /credentials_ciphertext=null/, "Legacy tenant Rinkel credentials must be cleared during cutover");
assert.match(rinkelPlatformWorker, /transcription_status:\s*"available"/, "Observed transcriptions must update canonical call capability state");
assert.match(apiAuth, /api_key_actor_insufficient_permission/, "API keys must retain the creating actor role permission boundary");
const contractApi = await readFile(join(root, "src/app/api/v1/contracts/route.ts"), "utf8");
assert.match(contractApi, /getCorrelationId/, "Contract API responses require a correlation identifier");
const directoryLib = await readFile(join(root, "src/lib/directory.ts"), "utf8");
assert.match(directoryLib, /shared_entity_refresh_managed_by_license_owner/, "Cross-tenant catalogue refresh must not mutate shared master data under another licence");
const discoveryRoute = await readFile(join(root, "src/app/api/v1/directory/discover/route.ts"), "utf8");
assert.match(discoveryRoute, /authenticateRequest\(request,\s*"directory:refresh"\)/, "Directory discovery must use the canonical directory:refresh scope");
assert.doesNotMatch(discoveryRoute, /enrichment:write/, "Legacy unreachable discovery scope must not return");

for (const relative of [
  "src/app/api/v1/directory/search/route.ts",
  "src/app/api/v1/imports/file/route.ts",
  "src/lib/imports/file-parser.ts",
  "src/lib/imports/malware-scan.ts",
  "src/lib/imports/normalize-row.ts",
  "src/lib/imports/json-path.ts",
  "src/lib/imports/organization-number.ts",
  "src/lib/imports/field-mapping.ts",
  "src/lib/imports/import-profile.ts",
  "src/components/import-field-mapping-editor.tsx",
  "src/components/import-profile-manager.tsx",
  "src/components/parsehub-project-manager.tsx",
  "src/app/(dashboard)/app/imports/profiles/page.tsx",
  "src/app/(dashboard)/app/imports/parsehub/page.tsx",
  "src/app/api/v1/import-profiles/route.ts",
  "src/app/api/v1/integrations/parsehub/projects/route.ts",
  "src/app/api/v1/integrations/parsehub/webhook/route.ts",
  "supabase/functions/parsehub-worker/index.ts",
  "scripts/import-core-tests.ts",
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
  "src/app/actions/auth.ts",
  "src/app/actions/organization.ts",
  "src/app/actions/platform-lists.ts",
  "src/app/api/v1/platform/lists/import/route.ts",
  "src/app/(dashboard)/app/platform/lists/page.tsx",
  "src/app/(dashboard)/app/teams/page.tsx",
  "src/app/(dashboard)/app/users/page.tsx",
  "src/components/app-shell/topbar.tsx",
  "src/lib/signing/provider.ts",
  "src/lib/signing/policy.ts",
  "src/lib/supabase/runtime-database.types.ts",
  "src/app/auth/callback/route.ts",
]) assert.ok((await stat(join(root, relative))).size > 100, `Missing implementation ${relative}`);

const authActions = await readFile(join(root, "src/app/actions/auth.ts"), "utf8");
assert.match(authActions, /signInWithPassword[\s\S]*activate_current_user_invitation/, "Existing users must accept pending tenant invitations when signing in");
const tenantAuthCallback = await readFile(join(root, "src/app/auth/callback/route.ts"), "utf8");
assert.match(tenantAuthCallback, /exchangeCodeForSession[\s\S]*activate_current_user_invitation/, "Email and OAuth callbacks must activate the intended tenant invitation");
const platformImportRoute = await readFile(join(root, "src/app/api/v1/platform/lists/import/route.ts"), "utf8");
assert.match(platformImportRoute, /employee_count: nullableInteger/, "Employee counts in central imports must be integers");

const importRoute = await readFile(join(root, "src/app/api/v1/imports/file/route.ts"), "utf8");
assert.match(importRoute, /scanImportFile/, "Import files must be security scanned before parsing and storage");
assert.ok(importRoute.indexOf("const scan = await scanImportFile") < importRoute.indexOf("const parsed = await parseImportFile"), "Malware scan must run before parser execution");
assert.match(importRoute, /parsed\.truncated/, "Truncated imports must be blocked before storage and execution");
assert.match(importRoute, /preview.*validationFingerprint|commit.*validationFingerprint/s, "Preview and commit require separate idempotency namespaces");
const importParser = await readFile(join(root, "src/lib/imports/file-parser.ts"), "utf8");
for (const format of ["ExcelJS", "parseXlsx", "parseXmlRows", "ndjson", "Papa.parse", "resolveRecordsPath", "MAX_XLSX_COMPRESSION_RATIO"]) assert.match(importParser, new RegExp(format), `Import parser must support ${format}`);
assert.doesNotMatch(importParser, /function parseZipEntries|inflateRawSync|sharedStrings\.xml/, "XLSX parsing must use the maintained ExcelJS library rather than a handwritten ZIP/XML parser");
const importMappingEditor = await readFile(join(root, "src/components/import-field-mapping-editor.tsx"), "utf8");
for (const pattern of [/company\.organization_number/, /contact\.phone_e164/, /entityType/, /fixed_person/, /from_field/, /mergePolicy/, /mapping_json/, /Transformkedja/]) assert.match(importMappingEditor, pattern, `Dynamic import mapping UI invariant missing: ${pattern}`);
const parseHubWorker = await readFile(join(root, "supabase/functions/parsehub-worker/index.ts"), "utf8");
for (const pattern of [/x-cron-secret/, /claim_parsehub_runs/, /decryptJson/, /runs\/\$\{encodeURIComponent\(runToken\)\}\/data/, /process_parsehub_import_run/]) assert.match(parseHubWorker, pattern, `ParseHub worker invariant missing: ${pattern}`);
const projectionSql = sql.match(/create or replace function public\.directory_entity_projection_for_tenant[\s\S]*?\$\$;/i)?.[0] ?? "";
assert.match(projectionSql, /directory_visible_fields_for_tenant/, "Directory projection must be based on licensed visible fields");
assert.doesNotMatch(projectionSql, /current_master/, "Directory projection must not expose the internal master payload");

const templatesAction = await readFile(join(root, "src/app/actions/contracts.ts"), "utf8");
assert.match(templatesAction, /renderStrictTemplate/, "Contract creation must render the approved version, not hard-coded terms");
assert.match(templatesAction, /create_contract_draft_v3/, "Contract creation must bind template, price, legal snapshots, commercial terms and assignment atomically");

const callRealtime = await readFile(join(root, "src/hooks/use-call-realtime.ts"), "utf8");
for (const pattern of [/fetchCurrentStatus/, /schedulePoll/, /scheduleReconnect/, /visibilitychange/, /SUBSCRIBED/, /reconciliation_required/]) {
  assert.match(callRealtime, pattern, `Dialer recovery invariant missing: ${pattern}`);
}
const productionRinkelWorker = await readFile(join(root, "supabase/functions/rinkel-platform-worker/index.ts"), "utf8");
assert.match(productionRinkelWorker, /pending_correlation/, "Uncorrelated Rinkel lifecycle events must remain retryable");
assert.match(productionRinkelWorker, /correlate_rinkel_incoming_event/, "Incoming Rinkel correlation must use the atomic database RPC");
assert.match(productionRinkelWorker, /correlate_rinkel_outgoing_event/, "Outgoing Rinkel correlation must use the atomic database RPC");
assert.match(productionRinkelWorker, /apply_rinkel_call_event/, "Rinkel lifecycle projection must use the canonical reducer");
assert.match(productionRinkelWorker, /select\("id"\)\.maybeSingle\(\)/, "Rinkel event processing must claim an event atomically");
const resendWebhookProjection = await readFile(join(root, "src/app/api/webhooks/resend/[token]/route.ts"), "utf8");
assert.match(resendWebhookProjection, /apply_resend_delivery_event/, "Resend webhook delivery state must use the monotonic reducer");
const signingProvider = await readFile(join(root, "src/lib/signing/provider.ts"), "utf8");
for (const method of ["createEnvelope", "createSignerSession", "fetchFinalDocument", "verifyWebhook"]) assert.match(signingProvider, new RegExp(method), `Signing provider contract missing ${method}`);
const proxySource = await readFile(join(root, "src/lib/supabase/proxy.ts"), "utf8");
assert.match(proxySource, /Content-Security-Policy/, "A nonce-based CSP is required");
const topbarSource = await readFile(join(root, "src/components/app-shell/topbar.tsx"), "utf8");
assert.doesNotMatch(topbarSource, /Global sökning/, "Non-functional global search must not be rendered");
const generatedSchemaVerifier = await readFile(join(root, "scripts/verify-generated-schema.mjs"), "utf8");
assert.match(generatedSchemaVerifier, /finalize_signing_envelope/, "Generated schema verification must include the hardening migration contract");
assert.match(proxySource, /Strict-Transport-Security/, "HSTS is required");
const runtimeTypes = await readFile(join(root, "src/lib/supabase/runtime-database.types.ts"), "utf8");
assert.match(runtimeTypes, /RuntimeDatabase/, "Supabase clients must use the generated schema contract with migration compatibility");
assert.match(sql, /contract\.signed\.confirmation/, "Post-sign completion must enqueue the final signed-document confirmation through the canonical outbox");

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
assert.equal(packageJson.dependencies["pdf-lib"], "1.17.1");
assert.match(packageJson.scripts.test, /test:contracts/, "Contract delivery unit tests must be part of the canonical test command");
assert.equal(packageJson.engines.node, "22.x");
assert.equal(packageJson.overrides.postcss, "8.5.19");
assert.equal(packageJson.scripts["functions:deploy"], "node scripts/deploy-functions.mjs");
assert.equal(packageJson.scripts["geography:import"], "node scripts/import-geography.mjs");
const deployFunctions = await readFile(join(root, "scripts/deploy-functions.mjs"), "utf8");
for (const worker of ["process-outbox", "rinkel-platform-worker", "automation-runner", "data-worker", "ingestion-worker", "maintenance-worker", "compliance-worker", "parsehub-worker"]) assert.match(deployFunctions, new RegExp(worker), `Deployment must include ${worker}`);
assert.match(packageJson.scripts.verify, /typecheck:edge/, "Full verification must type-check Edge Functions");

console.log(`Verified ${migrations.length} migrations, monotonic Rinkel/Resend projections, non-truncating imports, multi-recipient signing, dialer recovery, canonical contracts, tenant isolation and worker deployment.`);
