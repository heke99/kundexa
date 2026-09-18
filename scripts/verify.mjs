import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
import ts from "typescript";

const root = new URL("../", import.meta.url).pathname;
const migrationDir = join(root, "supabase/migrations");
const migrations = (await readdir(migrationDir)).filter((name) => name.endsWith(".sql")).sort();
assert.ok(migrations.length >= 22, "Expected at least twenty-two migrations");
const migrationVersions = migrations.map((name) => name.match(/^(\d+)_/)?.[1] ?? "");
assert.ok(migrationVersions.every(Boolean), "Every migration filename must start with a numeric version");
assert.equal(new Set(migrationVersions).size, migrationVersions.length, "Migration versions must be unique");
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
  [/record_contract_acceptance_v3/i, "generation-bound policy-aware atomic acceptance is required"],
  [/dead_letter_outbox_job/i, "permanent provider failures require dead-letter handling"],
  [/activate_automation/i, "controlled automation activation is required"],
  [/enqueue_outgoing_webhook_event/i, "outgoing webhook routing is required"],
  [/process_import_run/i, "transactional import execution is required"],
  [/prevent_truncated_import_execution/i, "truncated imports must be blocked in the database"],
  [/ingest_sinch_voice_event/i, "provider voice events require a canonical database reducer"],
  [/protect_call_projection/i, "call state must be monotonic whoever reports it"],
  [/reserve_outbound_call/i, "a seat and a call row must exist before anything is dialled"],
  [/finalize_dial/i, "the provider dial outcome must be written atomically"],
  [/release_stale_dial_attempts/i, "an attempt that never got a provider answer must be releasable"],
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
  "supabase/functions/compliance-worker/index.ts",
  "supabase/functions/_shared/crypto.ts",
  "supabase/functions/_shared/reminder-time.ts",
  "supabase/functions/_shared/sms-provider.ts",
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
assert.match(outboxWorker, /permanent_legacy_queued_voice_job_disabled_use_webphone/, "Legacy voice jobs must be dead-lettered without provider execution");
assert.doesNotMatch(outboxWorker, /46elks|api\.46elks\.com/i, "The outbox worker must not name a removed provider, let alone call it");
assert.doesNotMatch(outboxWorker, /voice_start/, "The outbox worker must not retain a queued voice bridge");
// Utskicket får inte känna leverantören. Den dagen porten kringgås är bytet dyrt igen.
assert.doesNotMatch(outboxWorker, /sms\.api\.sinch\.com|xms\/v1/, "SMS delivery must go through the provider port, not a hard-coded endpoint");
assert.match(outboxWorker, /smsProviderFor|getSmsProvider/, "SMS delivery must resolve its provider through the neutral port");
assert.match(outboxWorker, /provider\.findSubmitted\(String\(sms\.id\)\)/, "A retry must look the message up by our own reference, never by approximate time and content");
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
assert.doesNotMatch(outboxWorker, /async function processRinkel/, "Legacy tenant provider processing must be removed from the general outbox worker");

const resendWebhook = await readFile(join(root, "src/app/api/webhooks/resend/[token]/route.ts"), "utf8");
for (const pattern of [/request\.text\(\)/, /svix-id/, /svix-timestamp/, /svix-signature/, /timingSafeEqual/, /provider_webhook_events/, /provider_message_id/, /resendStatusForEvent/, /apply_resend_delivery_event/, /webhook_event_replay_lookup_failed/, /\["processed", "ignored"\]\.includes\(existingEvent\.status\)/]) {
  assert.match(resendWebhook, pattern, `Resend webhook invariant missing: ${pattern}`);
}
for (const pattern of [/v_permanent boolean:=p_status in \('failed','bounced','complained','suppressed','cancelled','dead_letter'\)/, /if p_status='delivered' then/, /p_status in \('complained','suppressed'\)/, /perform public\.cancel_contract_reminders/, /do_not_email=true/]) {
  assert.match(sql, pattern, `Atomic Resend projection invariant missing from migrations: ${pattern}`);
}
assert.doesNotMatch(resendWebhook, /from\("contract_events"\)\.insert|from\("contracts"\)\.update|cancel_contract_reminders|do_not_email/, "Resend webhook must not duplicate database projections outside apply_resend_delivery_event");
const contractActions = await readFile(join(root, "src/app/actions/contracts.ts"), "utf8");
for (const pattern of [/source_call_id/, /assertContractCallEligibility/, /ensureCanonicalContractDocument/, /prepare_contract_delivery_v2/, /schedule_manual_contract_reminder/, /cancel_contract_reminders/]) {
  assert.match(contractActions, pattern, `Contract action invariant missing: ${pattern}`);
}
const publicContractActions = await readFile(join(root, "src/app/actions/public-contract.ts"), "utf8");
assert.match(publicContractActions, /record_contract_acceptance_v3/, "Public acceptance must use the generation-bound policy-aware atomic RPC");
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
assert.match(maintenanceWorker, /telephony\.retention/, "Maintenance worker must schedule telephony retention");
assert.doesNotMatch(maintenanceWorker, /rinkel/i, "The maintenance worker must not name a removed provider");
const complianceWorker = await readFile(join(root, "supabase/functions/compliance-worker/index.ts"), "utf8");
for (const pattern of [/queue_due_nix_checks/, /claim_nix_check_jobs/, /complete_nix_check_job/, /fail_nix_check_job/, /redirect: "manual"/, /nix_private_network_forbidden/, /decryptJson/]) assert.match(complianceWorker, pattern, `Compliance worker invariant missing: ${pattern}`);

const apiAuth = await readFile(join(root, "src/lib/api-auth.ts"), "utf8");
assert.match(apiAuth, /identity\.source === "api_key" \? createAdminClient\(\) : createClient\(\)/, "Session API calls must retain RLS");

const dialRoute = await readFile(join(root, "src/app/api/v1/calls/route.ts"), "utf8");
// The seat and the call row must exist before anything can be dialled. That has
// not changed with the provider; what changed is who dials. The browser places
// the call now, so the route reserves and stops -- and must not grow a dial of
// its own, which would put a call outside the seat that guards it.
assert.match(dialRoute, /reserve_outbound_call/, "The dial route requires an atomic local reservation before the call can be placed");
assert.doesNotMatch(dialRoute, /fetch\(/, "The dial route must not call a provider directly; the browser places the call");
assert.doesNotMatch(dialRoute, /callPhoneNumber|callouts\./, "The dial route must not place calls; that is the webphone's job");
assert.match(dialRoute, /provider_status,provider_outcome,provider_cause/, "Call APIs must expose technical provider state separately from CRM disposition");
const smsPort = await readFile(join(root, "supabase/functions/_shared/sms-provider.ts"), "utf8");
assert.match(smsPort, /client_reference: request\.clientReference/, "Our own reference must reach the provider, or a retry cannot find the message it already sent");
assert.match(smsPort, /delivery_report: "per_recipient"/, "Delivery reports must be requested, since a contract SMS without one is unverifiable");
assert.match(smsPort, /permanent_sms_provider_not_configured/, "Missing credentials must be a permanent, named failure rather than a retry loop");
assert.match(smsPort, /permanent_sms_provider_unknown/, "An unknown provider name must refuse rather than silently fall back to another account");
assert.match(smsPort, /cost: null/, "Cost must be null when the provider does not report it, never invented");
const smsWebhookPort = await readFile(join(root, "src/lib/messaging/provider.ts"), "utf8");
assert.match(smsWebhookPort, /webhook_token_hash !== sha256\(token \+ env\.KUNDEXA_WEBHOOK_PEPPER\)/, "Inbound SMS must be authenticated per number, not per account");
assert.match(smsWebhookPort, /type !== "mo_text"/, "A delivery report must not be parsed as an inbound reply to a contract");
const smsInboundRoute = await readFile(join(root, "src/app/api/webhooks/sms/inbound/route.ts"), "utf8");
for (const pattern of [/adapter\.parseInbound\(request\)/, /record_contract_acceptance_v3/, /if \(eventError\) throw eventError/, /if \(recipientsError\) throw recipientsError/, /if \(acceptanceRequestsError\) throw acceptanceRequestsError/, /status: 403/, /status: 500/]) {
  assert.match(smsInboundRoute, pattern, `Inbound SMS invariant missing: ${pattern}`);
}
assert.doesNotMatch(smsInboundRoute, /sinch|46elks/i, "The inbound SMS route must not name a provider; that belongs in the adapter");
const smsDeliveryRoute = await readFile(join(root, "src/app/api/webhooks/sms/delivery/route.ts"), "utf8");
assert.match(smsDeliveryRoute, /fromNumber \? await authenticateSmsNumber\(fromNumber, token\) : null/, "A leaked delivery URL must not be usable for another number");
assert.doesNotMatch(smsDeliveryRoute, /sinch|46elks/i, "The delivery route must not name a provider; that belongs in the adapter");
const bootstrapPlatformOwner = await readFile(join(root, "scripts/bootstrap-platform-owner.mjs"), "utf8");
assert.match(bootstrapPlatformOwner, /platform_owner\.bootstrapped/, "Initial platform owner bootstrap must be audited");
assert.match(bootstrapPlatformOwner, /SUPABASE_SERVICE_ROLE_KEY/, "Platform owner bootstrap must run server-side with the service role");
const platformAuth = await readFile(join(root, "src/lib/auth.ts"), "utf8");
const platformAuthBody = platformAuth.slice(platformAuth.indexOf("export const getPlatformContext"));
assert.match(platformAuthBody, /from\("platform_memberships"\)/, "Platform context must authorize against platform membership directly");
assert.doesNotMatch(platformAuthBody, /getAppContext\(/, "Platform context must not depend on tenant app context");
assert.doesNotMatch(platformAuthBody, /active_tenant_id/, "Platform context must not depend on active_tenant_id");
const appLayout = await readFile(join(root, "src/app/(dashboard)/app/layout.tsx"), "utf8");
assert.match(appLayout, /x-kundexa-path/, "Shared app layout must distinguish platform and tenant surfaces");
assert.match(appLayout, /const platform = await getPlatformContext\(\)/, "Platform surfaces must use the independent platform context in the layout");
const supabaseProxy = await readFile(join(root, "src/lib/supabase/proxy.ts"), "utf8");
assert.match(supabaseProxy, /requestHeaders\.set\("x-kundexa-path", request\.nextUrl\.pathname\)/, "Proxy must overwrite the internal path hint used by the shared layout");
assert.doesNotMatch(bootstrapPlatformOwner, /Slutför tenant-onboarding innan \/app\/platform\/telephony/, "Platform owner bootstrap must not require tenant onboarding");
// Nummertilldelning. Den ersatte leverantörens allokeringsmodell och är nu en
// rad i `phone_numbers` plus ett val per företag, team, lista eller kampanj.
const callerIdMigration = await readFile(join(root, "supabase/migrations/202609170001_neutral_caller_id_selection.sql"), "utf8");
for (const pattern of [/teams/, /campaigns/, /customer_lists/, /telephony_policies/, /caller_id_phone_number_id/, /default_caller_id_phone_number_id/]) {
  assert.match(callerIdMigration, pattern, `Caller-ID assignment invariant missing: ${pattern}`);
}
const callerIdOptionsMigration = await readFile(join(root, "supabase/migrations/202609170008_caller_id_options.sql"), "utf8");
assert.match(callerIdOptionsMigration, /n\.supports_voice/, "A number without voice support must never be offered as a caller ID");
assert.match(callerIdOptionsMigration, /order by \(n\.id = v_default\) desc/, "The resolved default must be first, or the dialer preselects a different number than the call would use");
const telephonyActions = await readFile(join(root, "src/app/actions/telephony.ts"), "utf8");
assert.match(telephonyActions, /export async function saveCallerIdDefault/, "An administrator must be able to change the outgoing number without a deploy");
assert.match(telephonyActions, /supports_voice/, "Assigning a caller ID must verify the number can actually carry a call");
// Nummerhyra. Ett anrop kostar pengar varje månad tills någon säger upp numret,
// så ordningen och ärligheten i den här vägen är inte kosmetisk.
const numberPort = await readFile(join(root, "src/lib/telephony/numbers/provider.ts"), "utf8");
assert.doesNotMatch(numberPort, /release|cancel|delete/i, "The number port must not offer to give a number up; that decision has an invoice and a notice period behind it");
const numberAdapter = await readFile(join(root, "src/lib/telephony/numbers/sinch.ts"), "utf8");
assert.match(numberAdapter, /smsConfiguration/, "A rented number must be bound to our messaging account at rent time, or it costs money while receiving nothing");
// Fältnamnen är avlästa ur leverantörens OpenAPI-spec. De tre nedan var fel när
// de skrevs ur minnet, och två av dem hade felat tyst: en söksida som ignoreras
// och ett pris som alltid visas som okänt.
assert.match(numberAdapter, /voiceConfiguration = \{ type: "RTC", appId/, "voiceConfiguration is a union discriminated on type; without it the payload is ambiguous");
assert.match(numberAdapter, /\bsize: String\(/, "The available-number search takes `size`, not `pageSize`; the wrong name is silently ignored");
// Kommentarerna får nämna det gamla namnet -- de är protokollet över vad som var
// fel. Koden får inte.
const numberAdapterCode = numberAdapter.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
assert.match(numberAdapterCode, /readMoney\(number\.monthlyPrice\)/, "The monthly price must be read from the field the provider actually sends");
assert.doesNotMatch(numberAdapterCode, /monthlyCost/, "The provider reports `monthlyPrice`; reading the other name shows every number as priceless");
assert.match(numberAdapter, /supportingDocumentationRequired/, "A number needing identity documents cannot be rented in one call and must not be offered as if it could");
assert.match(numberAdapter, /async findActive\(/, "Renting is billable, so owning the number must be checkable before a retry");
const numberSearchRouteSource = await readFile(join(root, "src/app/api/v1/telephony/numbers/available/route.ts"), "utf8");
assert.match(numberSearchRouteSource, /number_provider_not_configured/, "Missing provider credentials must be a named refusal, not an empty result list");
// Hyrningen flyttade till plattformen när kostnaden visade sig ligga där.
// Regeln om ordningen följde med -- den handlar om pengar, inte om filplacering.
const platformActionsSource = await readFile(join(root, "src/app/actions/platform.ts"), "utf8");
const rentBody = platformActionsSource.slice(platformActionsSource.indexOf("export async function rentPhoneNumberForTenant"));
// Hyr först, spara sedan. Omvänd ordning lämnar ett nummer i databasen som
// ingen äger när leverantören säger nej.
assert.ok(rentBody.indexOf("provider.rent(") < rentBody.indexOf('from("phone_numbers").insert'),
  "The number must be rented before the row is written, or a refused rental leaves a number nobody owns");
assert.ok(rentBody.indexOf("provider.findActive(") < rentBody.indexOf("provider.rent("),
  "A billable rental must check whether we already own the number before paying for it again");
assert.match(rentBody, /hyrdes hos leverantören men kunde inte sparas/, "A rental that succeeds and then fails to store must say so with the number, since it cannot be undone");
assert.match(rentBody, /telephony\.number_rented/, "Renting a number is a cost and must be attributable to whoever pressed the button");

const dropMigration = await readFile(join(root, "supabase/migrations/202609170009_drop_rinkel_schema.sql"), "utf8");
assert.match(dropMigration, /rinkel_schema_removal_incomplete/, "The removal must fail loudly rather than leave half a provider behind");
assert.match(dropMigration, /create trigger calls_projection_monotonic/, "Call-state monotonicity must survive the removal, and apply to every provider");
assert.doesNotMatch(dropMigration, /^\s*if old\.provider<>/m, "The monotonicity guard must not be gated on a provider name again");
const nixMigration = await readFile(join(root, "supabase/migrations/202609070004_seller_reported_nix_and_screening_mode.sql"), "utf8");
assert.match(nixMigration, /nix_screening_mode/, "NIX screening must be a tenant policy, not a hard-coded gate");
assert.match(nixMigration, /if v_nix_result is not null and v_nix_result<>'not_listed' then/, "A known listing must refuse the call before the mode is consulted");
assert.match(nixMigration, /default_marketing_legal_basis/, "A tenant-wide legal basis must satisfy the marketing gate");
assert.match(nixMigration, /apply_call_block_disposition/, "The manual and list dialers must share one blocking-disposition definition");
assert.match(nixMigration, /'listed',now\(\),now\(\)\+interval '1 year'/, "A seller report must record a durable NIX result for the number");
const completeRoute = await readFile(join(root, "src/app/api/v1/calls/complete/route.ts"), "utf8");
assert.match(completeRoute, /"nix_listed"/, "The after-call API must accept the seller NIX report");
const dialerNix = await readFile(join(root, "src/components/dialer-panel.tsx"), "utf8");
assert.match(dialerNix, /Nixat nummer/, "The seller must be able to report a NIX listing from the dialer");
const complianceAdminActions = await readFile(join(root, "src/app/actions/admin.ts"), "utf8");
assert.match(complianceAdminActions, /saveComplianceScreeningPolicy/, "The screening mode must be settable by a tenant administrator");
assert.match(complianceAdminActions, /mode === "pre_screened_source" && !defaultLegalBasis/, "Relaxing NIX screening must require a documented legal basis");
const customerActions = await readFile(join(root, "src/app/actions/customers.ts"), "utf8");
assert.match(customerActions, /export async function updateCustomerDetails/, "A customer card must be completable after it was created for a call");
assert.match(customerActions, /normalizeOrganizationNumber\(identity/, "Identity numbers must be validated, not stored raw");
assert.match(customerActions, /personalIdentityNumber = normalized\.canonical/, "A personal identity number must not be stored in the organisation-number column");
assert.match(customerActions, /customer\.details_updated/, "Completing a customer card must be audited");
const customerDetailPage = await readFile(join(root, "src/app/(dashboard)/app/customers/[id]/page.tsx"), "utf8");
assert.match(customerDetailPage, /updateCustomerDetails/, "The customer card must expose the completion form");
assert.match(customerDetailPage, /name="legal_basis"/, "Legal basis must be editable, since marketing calls to private individuals depend on it");
const rlsMigration = await readFile(join(root, "supabase/migrations/202609070003_rls_insert_returning_self_reference.sql"), "utf8");
assert.match(rlsMigration, /can_access_customer_row/, "The customers select policy must not re-query the table it protects");
assert.doesNotMatch(rlsMigration, /create policy customers_scoped_select[\s\S]{0,200}can_access_customer\(id\)/, "The select policy must evaluate the candidate row's own columns");
const globalCss = await readFile(join(root, "src/app/globals.css"), "utf8");
assert.match(globalCss, /\.span-2/, "Multi-column form spans must be defined, not assumed");
const dialerComponent = await readFile(join(root, "src/components/dialer-panel.tsx"), "utf8");
assert.match(dialerComponent, /initialCallerId/, "The manual dialer must select the only accessible caller ID automatically");
assert.match(dialerComponent, /callerIdPhoneNumberId,/, "The manual dialer must always send the selected number explicitly");
assert.match(dialerComponent, /!callerIdPhoneNumberId/, "The dial button must not submit without a caller ID");
assert.doesNotMatch(dialerComponent, /dialPath/, "The dial path belonged to a provider that rang a desk phone first; the browser is the phone now");
assert.match(dialRoute, /internalDialFailure/, "Local database and finalization errors must not be mislabeled as provider failures");
assert.match(dialRoute, /getCorrelationId\(request\)/, "Dial failures must use a stable correlation id for support tracing");
assert.match(dialRoute, /apiJson\(correlationId/, "Dial responses must expose the correlation id as a response header");
const dialerHook = await readFile(join(root, "src/hooks/use-dialer.ts"), "utf8");
assert.match(dialerHook, /Referens:/, "Seller-visible dial errors must include a neutral support reference");
// Hindren formuleras i databasen. En hårdkodad kodlista i klienten driver isär
// från SQL:en och lämnar säljaren med "telefoni ej redo" utan orsak.
assert.match(dialerHook, /data\.blockers\?\.find\(\(blocker\) => blocker\.message\)/, "The dialer must show the database's own reason, not re-derive one");
assert.doesNotMatch(dialerHook, /RINKEL_/, "The dialer must not branch on a removed provider's diagnostic codes");
const exampleEnv = await readFile(join(root, ".env.example"), "utf8");
assert.doesNotMatch(exampleEnv, /SUPABASE_SERVICE_ROLE_KEY=eyJ/, "Tracked environment examples must not contain a live service-role JWT");

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
const voiceWebhook = await readFile(join(root, "src/app/api/webhooks/sinch/route.ts"), "utf8");
assert.match(voiceWebhook, /verifySinchCallback/, "Voice events must be signature-verified before they are believed");
assert.match(voiceWebhook, /status: 503/, "An unconfigured webhook must ask for redelivery, not swallow the event with a 200");
assert.match(voiceWebhook, /status: 403/, "An unverifiable event must be refused");
assert.doesNotMatch(voiceWebhook, /reason: verification\.reason \}\)[\s\S]{0,120}NextResponse\.json/, "The rejection reason must be logged, not handed to the sender");
assert.match(voiceWebhook, /ingest_sinch_voice_event/, "Voice lifecycle projection must use the atomic database reducer");
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
// Listan stod tidigare i skriptet, och prövades här mot en kopia av samma lista
// -- två handskrivna listor som bekräftade varandra. En ny funktion kördes inte
// förrän någon fyllde på båda, och en borttagen låg kvar i produktionen: den
// gamla leverantörens arbetare låg ACTIVE i tre dagar efter att källkoden
// försvann. Listan läses nu ur katalogen, och det är katalogen som prövas.
assert.match(deployFunctions, /readdirSync\(functionsDir/,
  "The deploy list must be read from the functions directory, not hand-maintained beside it");
const deployedWorkers = (await readdir(join(root, "supabase/functions"), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
  .map((entry) => entry.name).sort();
for (const worker of ["process-outbox", "automation-runner", "data-worker", "ingestion-worker", "maintenance-worker", "compliance-worker", "parsehub-worker"]) {
  assert.ok(deployedWorkers.includes(worker), `Deployment must include ${worker}`);
}
// Deployen deployar det repot har; utan det här tas det som lämnat repot aldrig
// bort någonstans, och ligger kvar anropbart i produktionen.
assert.match(deployFunctions, /functions", "delete"/,
  "The deploy must remove retired functions, or a deleted worker stays live in production forever");
assert.match(deployFunctions, /if \(functions\.length === 0\)/,
  "An empty directory listing must abort the deploy rather than read as `remove everything`");
assert.match(packageJson.scripts.verify, /typecheck:edge/, "Full verification must type-check Edge Functions");

// Varje npm-skript en workflow anropar måste finnas. Ett borttaget skript syns
// annars inte förrän CI säger "Missing script", vilket den gjorde en minut efter
// att den här grenens PR öppnades.
const workflowDir = join(root, ".github/workflows");
for (const name of (await readdir(workflowDir)).filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))) {
  const workflow = await readFile(join(workflowDir, name), "utf8");
  for (const [, script] of workflow.matchAll(/npm run ([a-z0-9:_-]+)/g)) {
    assert.ok(script in packageJson.scripts, `${name} runs \`npm run ${script}\`, which package.json does not define`);
  }
}

// Leverantörsnamn får bara finnas där de hör hemma.
//
// Det här är hela poängen med omskrivningen. Så länge ett leverantörsnamn får
// stå var som helst i koden växer bindningen tillbaka, och nästa byte blir lika
// dyrt som det här. Kontrollen är därför inte kosmetisk: den är kontraktet.
//
// Undantagen är uppräknade, inte mönstermatchade. Ett mönster hade tyst börjat
// undanta nya filer när någon döpte om en katalog.
const PROVIDER_NAME_EXEMPT = new Set([
  // Adaptrarna. Här är namnet själva innehållet.
  "src/lib/telephony/sinch/registration-token.ts",
  "src/lib/telephony/sinch/callback-signature.ts",
  "src/lib/telephony/webphone/sinch.ts",
  "src/lib/telephony/numbers/sinch.ts",
  "src/lib/telephony/numbers/index.ts",
  "src/hooks/use-sinch-webphone.ts",
  "src/hooks/use-webphone.ts",
  "src/lib/telephony/webphone/index.ts",
  "src/lib/telephony/webphone/provider.ts",
  "src/lib/messaging/provider.ts",
  "supabase/functions/_shared/sms-provider.ts",
  // Rutten är namngiven efter leverantören därför att det är leverantören som
  // bestämmer nyttolastens form och därmed callback-URL:en.
  "src/app/api/webhooks/sinch/route.ts",
  "src/app/api/v1/telephony/webphone/route.ts",
  "src/lib/env.ts",
  // Migrationen som tar bort leverantören måste få nämna den.
  "supabase/migrations/202609170009_drop_rinkel_schema.sql",
  // Tester och genererade filer.
  "scripts/api-core-tests.ts",
  "scripts/verify.mjs",
  "scripts/verify-sql.mjs",
  "scripts/sinch-unit-tests.mts",
  "scripts/remediation-regression-tests.mjs",
  "scripts/verify-generated-schema.mjs",
  "src/lib/supabase/database.types.ts",
  "src/lib/supabase/runtime-database.types.ts",
]);
// `.github` ingår. Den saknades, och kostade en röd CI direkt efter att PR:en
// öppnades: verify-workflowen anropade `npm run test:rinkel` som ett eget steg
// långt efter att skriptet tagits bort ur package.json. En skanning som inte
// läser det som faktiskt kör bygget mäter inte bygget.
const SCANNED_ROOTS = ["src", "scripts", "supabase/functions", ".github"];
// .json ingår: ruttklassificeringen är en JSON-fil, och där stod en borttagen
// leverantörs namn kvar i både en rutt och tre motiveringar.
const SCANNED_EXTENSIONS = [".ts", ".tsx", ".mjs", ".mts", ".sql", ".json", ".yml", ".yaml"];

async function sourceFiles(relative) {
  const absolute = join(root, relative);
  const entries = await readdir(absolute, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    const child = `${relative}/${entry.name}`;
    if (entry.isDirectory()) found.push(...await sourceFiles(child));
    else if (SCANNED_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) found.push(child);
  }
  return found;
}

const scanned = (await Promise.all(SCANNED_ROOTS.map(sourceFiles))).flat();
assert.ok(scanned.length > 200, "The provider-name scan must actually reach the source tree");
const removedProviderMentions = [];
const providerLeaks = [];
for (const relative of scanned) {
  if (PROVIDER_NAME_EXEMPT.has(relative)) continue;
  const source = await readFile(join(root, relative), "utf8");
  // De borttagna leverantörerna får inte nämnas alls. Ett namn som står kvar
  // betyder antingen kod som inte längre kan köra, eller ett fält som ingen
  // fyller i.
  // Ett namn får stå kvar på exakt ett ställe: i listan över jobbtyper som ska
  // dödbrevas när de dyker upp ur kön. Den listan är själva avvecklingen.
  // Samma undantag gäller listan över avvecklade Edge-funktioner: en deploy som
  // ska *ta bort* en funktion måste kunna peka ut den vid namn. Bara listan
  // strippas -- namnet någon annanstans i filen är fortfarande ett återfall.
  const withoutQueueDrain = source
    .replace(/const LEGACY_TELEPHONY_JOB_TYPES = \[[^\]]*\];/, "")
    .replace(/job\.job_type === "rinkel\.retention"/, "")
    .replace(/const RETIRED = \[[^\]]*\];/, "");
  if (/rinkel|46\s?elks/i.test(withoutQueueDrain)) removedProviderMentions.push(relative);
  if (/\bsinch\b/i.test(source)) providerLeaks.push(relative);
}
assert.deepEqual(removedProviderMentions, [], `Removed providers are still named in: ${removedProviderMentions.join(", ")}`);
assert.deepEqual(providerLeaks, [], `The provider is named outside its adapters in: ${providerLeaks.join(", ")}`);

// Migrationer skrivs aldrig om -- de är protokollet över vad som byggts, och
// borttagningen fungerar just genom att spelas upp efter dem. Regeln gäller
// därför framåt: ingen migration efter borttagningen får återinföra namnet.
const REMOVAL_MIGRATION = "202609170009";
// En migration som *tar bort* leverantörens rader måste nämna namnet för att
// kunna peka ut dem. Undantaget är därför en uppräkning, inte ett mönster: ett
// mönster som "migrationer med `delete` får nämna namnet" hade börjat ursäkta
// varje framtida migration som råkar innehålla en delete.
const REMOVAL_MIGRATIONS_MAY_NAME = new Set([
  "202609180001_remove_provider_configuration_leftovers.sql",
]);
for (const name of migrations) {
  const version = name.match(/^(\d+)_/)?.[1] ?? "";
  if (version <= REMOVAL_MIGRATION) continue;
  const source = await readFile(join(migrationDir, name), "utf8");
  if (REMOVAL_MIGRATIONS_MAY_NAME.has(name)) {
    // Den får nämna namnet, men bara för att ta bort. Ett `insert` eller en ny
    // tabell med namnet är ett återinförande oavsett vad filen heter.
    assert.doesNotMatch(source, /^\s*(insert|create)\b[\s\S]*rinkel/im,
      `${name} may name the removed provider only to delete it`);
    continue;
  }
  assert.doesNotMatch(source, /rinkel|46\s?elks/i, `${name} reintroduces a removed provider`);
}

// Det slutgiltiga beviset: schemat självt. Genererade typer läses ur det levande
// projektet, så ett namn här betyder att något faktiskt finns kvar i databasen --
// oavsett vad källkoden säger.
const generatedTypes = await readFile(join(root, "src/lib/supabase/database.types.ts"), "utf8");
assert.doesNotMatch(generatedTypes, /rinkel/i, "The live schema still carries provider tables, columns or functions");
const runtimeTypeOverlay = await readFile(join(root, "src/lib/supabase/runtime-database.types.ts"), "utf8");
assert.doesNotMatch(runtimeTypeOverlay, /rinkel/i, "The runtime type overlay still declares removed provider objects");

// ---------------------------------------------------------------------------
// Avtalslänken ska nå kunden, eller stoppas där någon kan göra något åt det
// ---------------------------------------------------------------------------
// Funktionsflaggorna för SMS och e-post prövades bara i utskicksarbetaren, som
// dödbrevar jobbet. Säljaren såg "utskicket har köats" och kunden fick aldrig
// någon länk. Varje väg som köar en leverans måste därför först fråga om
// kanalen är öppen -- och en ny väg som glömmer det ska fälla bygget, inte
// upptäckas av en kund som väntar.
for (const [file, source] of [
  ["src/app/actions/contracts.ts", await readFile(join(root, "src/app/actions/contracts.ts"), "utf8")],
  ["src/lib/contracts/api-service.ts", await readFile(join(root, "src/lib/contracts/api-service.ts"), "utf8")],
]) {
  const queueIndex = source.indexOf("prepare_contract_delivery");
  assert.ok(queueIndex > 0, `${file} must still queue the delivery through prepare_contract_delivery`);
  const gateIndex = source.indexOf("contractDeliveryBlocker(");
  assert.ok(gateIndex > 0, `${file} queues a contract delivery without checking whether the channel is enabled`);
  assert.ok(gateIndex < queueIndex, `${file} must check the delivery channel before queueing, not after`);
}

// Länken kunden klickar på byggs på två ställen: webbappen vid första utskicket
// och arbetaren vid påminnelsen. Arbetarens adress kom från `Deno.env.get(...)!`,
// som bara tystar typkontrollen -- en osatt variabel gav `undefined/accept/...`
// i ett SMS som rapporterades som skickat.
// Samma regel som för nummeradaptern: kommentarerna får nämna det gamla
// uttrycket -- de är protokollet över vad som var fel. Koden får inte.
const outboxWorkerCode = outboxWorker.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
assert.doesNotMatch(outboxWorkerCode, /Deno\.env\.get\("APP_URL"\)!/,
  "APP_URL must be validated, not asserted non-null: an unset value ships `undefined/accept/<token>` to a customer");
assert.doesNotMatch(outboxWorkerCode, /\$\{appUrl\}\//,
  "Customer-facing URLs must be built through requireAppUrl(), which refuses an unset APP_URL");
assert.match(outboxWorker, /function requireAppUrl\(\)/, "The worker must validate APP_URL before building a customer link");
// Arbetarens konfiguration är det enda stället SMS-nycklarnas närvaro går att
// se utifrån; webbappen har dem inte. Rapporten får bära närvaro, aldrig värden.
assert.match(outboxWorker, /platformSmsConfigured: Boolean\(/, "The worker must report whether platform SMS credentials are present");
const deliveryReport = outboxWorkerCode.match(/function deliveryConfiguration\(\)[\s\S]*?\n\}/);
assert.ok(deliveryReport, "The worker must report its delivery configuration");
for (const secret of ["globalSmsApiToken", "globalSmsServicePlanId", "globalResendKey", "cronSecret", "encryptionKey", "serviceKey"]) {
  assert.ok(!new RegExp(`:\\s*${secret}\\b`).test(deliveryReport[0]),
    `The delivery report must carry presence, never the value of ${secret}`);
}
const readyRoute = await readFile(join(root, "src/app/api/ready/route.ts"), "utf8");
assert.match(readyRoute, /platform_worker_heartbeats/,
  "Readiness must read the worker's own report: the web app cannot see the Edge Function's SMS credentials");
assert.match(readyRoute, /linkHostAligned/,
  "Readiness must compare the worker's link host with the app's, so a reminder cannot point at another host");

// ---------------------------------------------------------------------------
// En oregistrerad webbtelefon ska inte se ut som ett trasigt samtal
// ---------------------------------------------------------------------------
// Ett byggt men oregistrerat SDK-objekt har ändå ett `callClient`, så kontrollen
// "finns objektet?" släppte igenom ett samtal som leverantören avvisade med
// "Invalid operation". Säljaren fick "Samtalet kunde inte kopplas upp", vilket
// pekar på samtalet när problemet är registreringen -- och platsen var redan
// tagen och samtalsraden skriven för ett samtal som aldrig kunde ringas.
const webphoneHook = await readFile(join(root, "src/hooks/use-sinch-webphone.ts"), "utf8");
assert.match(webphoneHook, /registeredRef\.current = true/,
  "The webphone must record that the provider accepted the registration, not just that start was called");
assert.match(webphoneHook, /!client\?\.callClient \|\| !registeredRef\.current/,
  "Placing a call must require a registered client: a built-but-unregistered client still exposes callClient");
// Hjärtslaget är det enda som håller sessionen vid liv. Rutten och
// databasfunktionen fanns, men ingen anropade dem, så varje session tystnade
// direkt och sopades bort efter fem minuter -- med samtalsraden stämplad
// `failed` medan säljaren fortfarande pratade.
assert.match(webphoneHook, /"\/api\/v1\/telephony\/webphone\/heartbeat"/,
  "The webphone must send the heartbeat, or every session is swept as lost while the seller is still on the call");
assert.match(webphoneHook, /setInterval\(\(\) => \{ void beat\(\); \}/,
  "One heartbeat is not enough: the session must keep reporting for as long as the tab is open");
const reserveIndex = dialerHook.indexOf('fetch("/api/v1/calls"');
const readinessIndex = dialerHook.indexOf("webphone.state.phase");
assert.ok(readinessIndex > 0, "The dialer must check whether the webphone is registered");
assert.ok(readinessIndex < reserveIndex,
  "The webphone readiness check must come before the reservation, or an unregistered webphone burns a seat and writes a failed call row");

// Leverantörens callback bär samtalets id i `callid`, gemener. Det ser ut som
// en felstavning, och leverantörens översiktssidor skriver `callId` -- men
// referensen för både ace och dice säger gemener. En "rättelse" till camelCase
// gör att fältet aldrig hittas: rutten svarar 400 på varje riktig händelse och
// inget samtal får något utfall.
const sinchWebhookRoute = await readFile(join(root, "src/app/api/webhooks/sinch/route.ts"), "utf8");
assert.match(sinchWebhookRoute, /payload\.callid/,
  "The provider sends `callid` in lower case; reading `callId` finds nothing and rejects every real event");

// ---------------------------------------------------------------------------
// Två kostnadsbärande beslut ligger där den som betalar sitter
// ---------------------------------------------------------------------------
// Numren hyrs i Kundexas leverantörskonto och faktureras Kundexa. En knapp hos
// företaget hade alltså skickat en räkning till någon annan, varje månad tills
// någon säger upp numret. Och all avtalspost går via Kundexas e-postkonto,
// eftersom det är Kundexa som äger domänverifieringen hos leverantören.
const numberSearchRoute = await readFile(join(root, "src/app/api/v1/telephony/numbers/available/route.ts"), "utf8");
assert.match(numberSearchRoute, /getPlatformContext|isPlatformAdmin/,
  "Searching rentable numbers is a platform action: the rental is billed to the platform, not the tenant");
assert.doesNotMatch(numberSearchRoute, /getAppContext/,
  "A tenant context here would let a company spend the platform's money");
const platformActions = await readFile(join(root, "src/app/actions/platform.ts"), "utf8");
assert.match(platformActions, /export async function rentPhoneNumberForTenant/,
  "Renting a number must live on the platform surface");
assert.match(platformActions, /tenantId: z\.uuid\(\)/,
  "The receiving tenant must be explicit: a guessed one puts a monthly cost on the wrong company");
const tenantTelephonyActions = await readFile(join(root, "src/app/actions/telephony.ts"), "utf8");
assert.doesNotMatch(tenantTelephonyActions, /provider\.rent\(/,
  "A tenant-scoped action must not be able to rent a number");

// Kontomodellen för e-post prövades på fem ställen med två olika defaultvärden,
// så ett företag utan uttrycklig inställning fick olika svar beroende på vem som
// frågade -- utskicket kunde prövas mot en nyckel och skickas med en annan. Det
// finns nu bara en modell för avtalspost, och därför inget att läsa.
//
// Regeln gäller e-posten. SMS har fortfarande ett tenantägt läge, så en bred
// sökning efter namnet hade fällt fel filer av rätt skäl.
for (const file of [
  "src/app/actions/contracts.ts",
  "src/lib/contracts/api-service.ts",
  "src/app/actions/admin.ts",
  "src/app/api/v1/integrations/resend/test/route.ts",
  "supabase/functions/process-outbox/index.ts",
]) {
  const source = (await readFile(join(root, file), "utf8")).replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
  // Just den här formen var defekten: en default som skilde sig mellan anropen.
  assert.doesNotMatch(source, /account_mode \?\? "tenant_owned"/,
    `${file} defaults the account model to tenant-owned; that default disagreed with the other call sites`);
}
for (const file of [
  ["src/app/actions/contracts.ts", /emailFrom = String\(env\.DEFAULT_EMAIL_FROM_ADDRESS/],
  ["src/lib/contracts/api-service.ts", /emailFrom = String\(env\.DEFAULT_EMAIL_FROM_ADDRESS/],
  ["supabase/functions/process-outbox/index.ts", /const apiKey = globalResendKey;/],
]) {
  const [name, pattern] = file;
  assert.match(await readFile(join(root, name), "utf8"), pattern,
    `${name} must take the e-mail account from the platform, unconditionally: the verified sending domain is the platform's`);
}

console.log(`Verified ${migrations.length} migrations, monotonic call/Resend projections, non-truncating imports, multi-recipient signing, dialer recovery, canonical contracts, tenant isolation and worker deployment.`);
