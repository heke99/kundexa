import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const [
  migration,
  lintMigration,
  customerApi,
  products,
  calls,
  telephonyStatus,
  openapi,
  dialerHook,
  webphoneSession,
  webphoneAdapter,
  callsMigration,
  platformPage,
  platformListsPage,
  authUsers,
  contracts,
  apiContracts,
  resendRoute,
  customerActions,
  adminActions,
  automationRunner,
  smsDelivery,
  outbox,
  auth,
  appLayout,
  proxy,
  organizationActions,
  topbar,
  onboarding,
  bootstrapPlatformOwner,
  verifier,
  sqlVerifier,
  invitationMigration,
  listDistributionMigration,
  contractGenerationMigration,
  publicContractAction,
  smsInboundRoute,
  permissions,
  sidebar,
  verifyWorkflow,
  openapiVerifier,
  contractsNewPage,
  contractDetailPage,
  scheduledEdgeWorker,
  processOutboxCron,
  vercelConfig,
] = await Promise.all([
  read("supabase/migrations/202608080001_cross_surface_consistency_remediation.sql"),
  read("supabase/migrations/202608080002_database_lint_runtime_hardening.sql"),
  read("src/app/api/v1/customers/route.ts"),
  read("src/app/actions/products.ts"),
  read("src/app/api/v1/calls/route.ts"),
  read("src/app/api/v1/telephony/status/route.ts"),
  read("src/app/api/openapi.json/route.ts"),
  read("src/hooks/use-dialer.ts"),
  read("src/app/api/v1/telephony/webphone/session/route.ts"),
  read("src/lib/telephony/webphone/sinch.ts"),
  read("supabase/migrations/202609170003_dial_on_sinch.sql"),
  read("src/app/(dashboard)/app/platform/page.tsx"),
  read("src/app/(dashboard)/app/platform/lists/page.tsx"),
  read("src/lib/supabase/auth-admin-users.ts"),
  read("src/app/actions/contracts.ts"),
  read("src/lib/contracts/api-service.ts"),
  read("src/app/api/webhooks/resend/[token]/route.ts"),
  read("src/app/actions/customers.ts"),
  read("src/app/actions/admin.ts"),
  read("supabase/functions/automation-runner/index.ts"),
  read("src/app/api/webhooks/sms/delivery/route.ts"),
  read("supabase/functions/process-outbox/index.ts"),
  read("src/lib/auth.ts"),
  read("src/app/(dashboard)/app/layout.tsx"),
  read("src/lib/supabase/proxy.ts"),
  read("src/app/actions/organization.ts"),
  read("src/components/app-shell/topbar.tsx"),
  read("src/app/onboarding/page.tsx"),
  read("scripts/bootstrap-platform-owner.mjs"),
  read("scripts/verify.mjs"),
  read("scripts/verify-sql.mjs"),
  read("supabase/migrations/202608100004_invitation_membership_team_hardening.sql"),
  read("supabase/migrations/202608100005_list_distribution_dialer_authorization.sql"),
  read("supabase/migrations/202608100007_contract_acceptance_generation_and_policy.sql"),
  read("src/app/actions/public-contract.ts"),
  read("src/app/api/webhooks/sms/inbound/route.ts"),
  read("src/lib/permissions.ts"),
  read("src/components/app-shell/sidebar.tsx"),
  read(".github/workflows/verify.yml"),
  read("scripts/verify-openapi-coverage.mjs"),
  read("src/app/(dashboard)/app/contracts/new/page.tsx"),
  read("src/app/(dashboard)/app/contracts/[id]/page.tsx"),
  read("src/lib/workers/scheduled-edge-worker.ts"),
  read("src/app/api/cron/process-outbox/route.ts"),
  read("vercel.json"),
]);

const [
  securityProjectionMigration, signingCompletionMigration, performanceMigration, workerScheduler, edgeWorkerCron,
  navConfig, customerSearch, customerMultiSearch, dialerPanel, dialerPage, listPage, contractsPage, reportsPage, dashboardPage,
  apiAuth, routeClassification, processOutboxCurrent, teamDailyLeadLimitMigration, callProjectionMonotonicMigration,
  canonicalProvisioningMigration, provisionUserSource, changePasswordAction, registerPage, usersPage, platformListActions, authActions,
] = await Promise.all([
  read("supabase/migrations/202608100008_security_resource_projection_and_rls.sql"),
  read("supabase/migrations/202608100009_contract_signing_generation_completion.sql"),
  read("supabase/migrations/202608100010_reporting_navigation_performance.sql"),
  read("src/lib/workers/scheduled-edge-worker.ts"),
  read("src/app/api/cron/edge-workers/[worker]/route.ts"),
  read("src/components/app-shell/nav-config.ts"),
  read("src/components/customer-search-select.tsx"),
  read("src/components/customer-multi-search-select.tsx"),
  read("src/components/dialer-panel.tsx"),
  read("src/app/(dashboard)/app/dialer/page.tsx"),
  read("src/app/(dashboard)/app/lists/[id]/page.tsx"),
  read("src/app/(dashboard)/app/contracts/page.tsx"),
  read("src/app/(dashboard)/app/reports/page.tsx"),
  read("src/app/(dashboard)/app/page.tsx"),
  read("src/lib/api-auth.ts"),
  read("scripts/api-route-classification.json"),
  read("supabase/functions/process-outbox/index.ts"),
  read("supabase/migrations/202608100011_team_daily_lead_limit_enforcement.sql"),
  read("supabase/migrations/202609170009_drop_rinkel_schema.sql"),
  read("supabase/migrations/202608100013_canonical_user_provisioning_and_first_login.sql"),
  read("src/lib/users/provision-user.ts"),
  read("src/app/actions/change-password.ts"),
  read("src/app/(auth)/register/page.tsx"),
  read("src/app/(dashboard)/app/users/page.tsx"),
  read("src/app/actions/platform-lists.ts"),
  read("src/app/actions/auth.ts"),
]);


// List work authorization must enforce both seller-assignment and team-member caps.
assert.match(teamDailyLeadLimitMigration, /tm\.daily_lead_limit is null/);
assert.match(teamDailyLeadLimitMigration, /claimed\.last_claimed_by=a\.user_id/);
assert.match(teamDailyLeadLimitMigration, /a\.daily_capacity is null/);
assert.match(teamDailyLeadLimitMigration, /not tm\.assignment_paused/);

// Call projection is monotonic across late/out-of-order lifecycle events, for
// every provider. The guard used to open with `if old.provider<>'rinkel'`, which
// silently turned it off for every call placed after the switch.
assert.match(callProjectionMonotonicMigration, /old\.recording_status in \('available_at_provider','copy_pending','stored_privately'\)/);
assert.match(callProjectionMonotonicMigration, /old\.provider_outcome is not null and new\.provider_outcome is null/);
assert.match(callProjectionMonotonicMigration, /new\.provider_outcome:=old\.provider_outcome/);
assert.match(callProjectionMonotonicMigration, /public\.call_status_rank\(old\.status\)=100/);

assert.match(migration, /audit_logs_customer_api_idempotency_uidx/);
assert.match(lintMigration, /set search_path = public, extensions/);
assert.match(lintMigration, /\'stale\'::public\.directory_freshness_state/);
assert.match(lintMigration, /\'refreshing\'::public\.directory_freshness_state/);
assert.match(lintMigration, /id bigint, normalized_data jsonb/);
assert.doesNotMatch(lintMigration, /id uuid, normalized_data jsonb/);

assert.match(customerApi, /action:\s*"customer\.api_created"/);
assert.match(customerApi, /customerId\s*=\s*existingReservation\.entity_id/);
assert.match(customerApi, /idempotency_key_reused_with_different_payload/);

assert.match(migration, /products_create_initial_price/);
assert.match(products, /_initial_price/);
assert.doesNotMatch(products, /from\("products"\)\.delete\(/);
assert.doesNotMatch(products, /from\("product_price_versions"\)\.insert\(/);

// Telephony that is not configured must be said out loud, not discovered as a
// call that never connects. The refusal used to live on the dial route, which
// asked the provider to ring a device; now the browser places the call, so the
// route that hands out the webphone's credentials is where "not configured" is
// known and where it has to be refused.
assert.match(webphoneSession, /webphone_provider_not_configured|provisioned\.available/);
assert.match(webphoneAdapter, /webphone_provider_not_configured/);

// A call with no caller ID gets a call id from Sinch and never reaches anyone.
// Both the reservation and the route that reports its failures have to name it.
assert.match(callsMigration, /CALLER_ID_MISSING/);
assert.match(calls, /CALLER_ID_MISSING/);

// The dial route no longer asks a provider to ring anything, so nothing about a
// provider runtime key belongs in it.
assert.doesNotMatch(calls, /isPlatformRuntimeConfigured/);

// Platform control-plane authorization must never depend on tenant workspace state.
const platformContextBody = auth.slice(auth.indexOf("export const getPlatformContext"));
assert.match(platformContextBody, /from\("platform_memberships"\)/);
assert.doesNotMatch(platformContextBody, /getAppContext\(/);
assert.doesNotMatch(platformContextBody, /active_tenant_id/);
assert.match(auth, /if \(platformRole\) redirect\("\/app\/platform"\)/);
assert.match(proxy, /requestHeaders\.set\("x-kundexa-path", request\.nextUrl\.pathname\)/);
assert.match(appLayout, /platformMode = pathname === "\/app\/platform"/);
assert.match(appLayout, /const platform = await getPlatformContext\(\)/);

assert.match(organizationActions, /export async function switchTenant[\s\S]*supabase\.auth\.getUser\(\)/);
assert.doesNotMatch(organizationActions.match(/export async function switchTenant[\s\S]*$/)?.[0] ?? "", /await getAppContext\(\)/);
assert.match(topbar, /platformMode && tenants\.length > 0 && !activeTenant/);
assert.match(onboarding, /if \(platformMembership\) redirect\(["\']\/app\/platform["\']\)/);
assert.doesNotMatch(bootstrapPlatformOwner, /Slutför tenant-onboarding innan \/app\/platform\/telephony/);
assert.match(bootstrapPlatformOwner, /Plattformsåtkomst är tenantoberoende/);
assert.doesNotMatch(bootstrapPlatformOwner, /page\s*<=\s*100/);
assert.match(bootstrapPlatformOwner, /while \(!target\)/);

assert.match(platformPage, /canReadPlatformAdministration/);
assert.match(platformListsPage, /canReadPlatformAdministration/);
assert.doesNotMatch(platformPage, /platformRole !== "platform_support"/);
assert.doesNotMatch(platformPage, /createAdminClient/);
assert.doesNotMatch(platformListsPage, /createAdminClient/);
assert.match(migration, /tenants_platform_read/);
assert.match(migration, /tenant_memberships_platform_read/);
assert.doesNotMatch(authUsers, /page\s*<=\s*20/);
assert.match(authUsers, /while \(true\)/);

assert.match(contracts, /zonedLocalDateTimeToIso\(value\(form, "expires_at"\), ctx\.tenantTimezone\)/);

// The pre-fill has to use the same clock as the parser above. `getTimezoneOffset()`
// is the *server's* offset — 0 on Vercel — so pre-filling with it put every
// datetime-local field on the contract pages a whole UTC offset away from how the
// action reads it back.
assert.doesNotMatch(contractsNewPage, /getTimezoneOffset/);
assert.doesNotMatch(contractDetailPage, /getTimezoneOffset/);
assert.match(contractsNewPage, /isoToZonedLocalDateTime\(date\.toISOString\(\), ctx\.tenantTimezone\)/);
assert.match(contractsNewPage, /isoToZonedDateOnly\(date\.toISOString\(\), ctx\.tenantTimezone\)/);
assert.match(contractDetailPage, /isoToZonedLocalDateTime\(value \?\? null, ctx\.tenantTimezone\)/);
assert.match(contracts, /timeZone: ctx\.tenantTimezone/);
assert.match(contracts, /från \$\{sellerLegalName\}/);
assert.match(apiContracts, /select\("name,legal_name,timezone"\)/);
assert.match(apiContracts, /timeZone: tenant\?\.timezone/);

assert.match(migration, /project_compliance_block_to_customer/);
assert.match(migration, /with active_customer_blocks as/);
assert.match(migration, /bool_or\(\'call\'=any\(channels\)\)/);
assert.doesNotMatch(customerActions, /from\('customers'\)\.update\(\{do_not_call:true/);
assert.doesNotMatch(adminActions, /marketing_allowed: false, do_not_call: true/);
assert.doesNotMatch(automationRunner, /const update: Record<string, boolean \| string> = \{ blocked_reason/);

assert.match(migration, /update public\.provider_webhook_events[\s\S]*provider='resend'/);
assert.doesNotMatch(resendRoute, /from\("contract_events"\)\.insert/);
assert.doesNotMatch(resendRoute, /from\("contracts"\)\.update/);
assert.doesNotMatch(resendRoute, /cancel_contract_reminders/);
assert.doesNotMatch(resendRoute, /do_not_email/);
assert.match(resendRoute, /webhook_event_replay_lookup_failed/);
assert.match(resendRoute, /\["processed", "ignored"\]\.includes\(existingEvent\.status\)/);

assert.match(outbox, /provider\.findSubmitted/);
assert.match(outbox, /message_id=\$\{encodeURIComponent\(sms\.id\)\}/);
assert.match(outbox, /sms_submission_reconciliation_pending/);
assert.ok(outbox.indexOf("permanent_sms_outbound_feature_disabled") < outbox.indexOf("const provider = await getSmsProvider(job.tenant_id)"), "SMS feature gate must run before provider credentials/reconciliation");
assert.match(smsDelivery, /message_id/);
assert.match(smsDelivery, /provider_message_id: report\.providerMessageId/);
assert.match(smsDelivery, /from_number/);

// Ett nummer hör till ett företag. Att en annan tenant kan välja det som A-nummer
// är den allvarligaste läckan i hela telefonin, och den prövas i SQL-sviten.
assert.match(sqlVerifier, /callerIdTenantIsolation/);

// 2026-08-10 production remediation invariants.
assert.match(invitationMigration, /active_tenant_member_already_exists/);
assert.match(invitationMigration, /create or replace function public\.assert_team_capacity/);
assert.match(invitationMigration, /create or replace function public\.can_operate_in_team/);
assert.match(invitationMigration, /create or replace function public\.activate_current_user_invitation/);
const activationBlock = invitationMigration.match(/create or replace function public\.activate_current_user_invitation[\s\S]*?end \$\$;/)?.[0] ?? "";
assert.match(activationBlock, /from public\.tenant_invitations/);
assert.match(activationBlock, /status='pending'/);
assert.doesNotMatch(activationBlock, /m\.status='invited'/);
assert.doesNotMatch(invitationMigration.match(/create or replace function public\.register_tenant_invitation[\s\S]*?end \$\$;/)?.[0] ?? "", /insert into public\.team_members/);
assert.match(organizationActions, /reserve_tenant_invitation/);
assert.match(organizationActions, /finalize_tenant_invitation/);
assert.match(organizationActions, /update_tenant_member_v3/);

assert.match(listDistributionMigration, /customer_list_distribution_state/);
assert.match(listDistributionMigration, /round_robin/);
assert.match(listDistributionMigration, /allow_skip/);
assert.match(listDistributionMigration, /allow_browse/);
assert.match(listDistributionMigration, /claim_expires_at<now\(\)/);
assert.match(listDistributionMigration, /can_operate_in_team/);

// Reservationen bär hela behörighets- och efterlevnadskedjan. Den överlevde
// leverantörsbytet ordagrant, eftersom ingenting i den handlar om vem som kopplar.
for (const pattern of [/can_access_customer\(p_customer_id\)/, /evaluate_exact_call_policy/, /exact_call_policy_denied/, /evaluate_contact_policy_for_tenant/, /v_purpose *:?= *'direct_marketing'/, /assignment_paused/]) {
  assert.match(callsMigration, pattern, `Dial reservation invariant missing: ${pattern}`);
}
assert.match(sqlVerifier, /00000000-0000-0000-0000-000000000025','\+46702222225','runtime','1','not_listed'/);
assert.match(sqlVerifier, /centralResult\.purpose !== \"direct_marketing\"/);
assert.match(sqlVerifier, /create function auth\.jwt\(\) returns jsonb/);
assert.match(sqlVerifier, /set_config\('request\.jwt\.claim\.role','service_role',false\)[\s\S]*finalize_dial[\s\S]*set_config\('request\.jwt\.claim\.role','authenticated',false\)/);

assert.match(contractGenerationMigration, /acceptance_generation/);
assert.match(contractGenerationMigration, /source_call_eligibility_snapshot/);
assert.match(contractGenerationMigration, /contract_source_call_snapshot_is_immutable/);
assert.match(contractGenerationMigration, /record_contract_acceptance_v3/);
assert.match(contractGenerationMigration, /acceptance_request_superseded_generation/);
assert.match(contractGenerationMigration, /acceptance_code_required/);
assert.match(contractGenerationMigration, /manual_contract_disposition_allowed/);
assert.match(publicContractAction, /record_contract_acceptance_v3/);
assert.match(publicContractAction, /request\.require_code && !parsed\.data\.acceptanceCode/);
assert.match(smsInboundRoute, /record_contract_acceptance_v3/);
assert.doesNotMatch(smsInboundRoute, /rpc\("record_contract_acceptance",/);
assert.match(contracts, /rpc\("activate_completed_contract"/);
assert.match(contractGenerationMigration, /signature_policy_snapshot/);
assert.match(contractGenerationMigration, /signature_policy_requires_external_signing/);
assert.match(contractGenerationMigration, /final_signed_document_hash_required/);
assert.match(contractGenerationMigration, /completed_evidence_package_required/);
assert.match(contractGenerationMigration, /contract\.acceptance_recorded/);

assert.match(permissions, /routeAccessMap/);
assert.match(permissions, /resourcePermissionMap/);
assert.match(sidebar, /canAccessRoute/);
assert.match(appLayout, /canAccessRoute/);
assert.match(verifyWorkflow, /denoland\/setup-deno@v2/);
assert.match(verifyWorkflow, /npm run openapi:verify/);
assert.match(openapiVerifier, /unclassified route/);
assert.match(openapiVerifier, /public route missing from OpenAPI/);
assert.doesNotMatch(openapi.match(/"\/calls": \{[\s\S]*?\n      \},/)?.[0] ?? "", /purpose: \{ type: "string" \}/);



// Latest production-readiness layers: scoped provider projections, generation-safe
// signing, source-controlled workers and bounded database-backed UI queries.
assert.match(securityProjectionMigration, /tm\.role/);
assert.doesNotMatch(securityProjectionMigration, /tm\.team_role/);
assert.match(securityProjectionMigration, /not tm\.assignment_paused/);

assert.match(signingCompletionMigration, /r\.generation=new\.acceptance_generation/);
assert.match(signingCompletionMigration, /e\.generation=new\.acceptance_generation/);
assert.match(signingCompletionMigration, /idempotent_replay/);
assert.match(signingCompletionMigration, /completed_envelope_document_mismatch/);
assert.match(signingCompletionMigration, /coalesce\(\(ep\.manifest->>'generation'\)::integer,0\)=v_envelope\.generation/);
assert.match(signingCompletionMigration, /source_call_eligibility_snapshot/);
assert.match(signingCompletionMigration, /final_signed_document_invalid/);
assert.match(sqlVerifier, /'signed_pdf','signed\.pdf','contracts\/verify\/signed\.pdf','application\/pdf','final-signed-sha-256',2048/);
assert.match(sqlVerifier, /activate_completed_contract\('00000000-0000-0000-0000-000000000086'\)/);
assert.match(sqlVerifier, /idempotent_replay !== true/);
assert.match(sqlVerifier, /contract\.signed\.confirmation:00000000-0000-0000-0000-000000000086:0/);
assert.doesNotMatch(sqlVerifier, /post_sign_executed/);
const signingContractMarker = sqlVerifier.indexOf("VERIFY-SIGN-1");
const signingRuntimeStart = sqlVerifier.lastIndexOf("insert into public.customers", signingContractMarker);
const signingRuntimeEnd = sqlVerifier.indexOf("Executed production hardening runtime paths", signingContractMarker);
assert.ok(signingContractMarker > 0 && signingRuntimeStart > 0 && signingRuntimeEnd > signingRuntimeStart, "Signing runtime verification block missing");
const signingRuntimeBlock = sqlVerifier.slice(signingRuntimeStart, signingRuntimeEnd);
assert.match(signingRuntimeBlock, /10000000-0000-0000-0000-000000000001/);
assert.match(signingRuntimeBlock, /Signing Runtime Prospect/);
assert.doesNotMatch(signingRuntimeBlock, /00000000-0000-0000-0000-000000000021/);

assert.match(workerScheduler, /scheduledEdgeWorkers/);
assert.match(workerScheduler, /record_platform_worker_heartbeat/);
assert.match(edgeWorkerCron, /invokeScheduledEdgeWorker/);
assert.match(verifyWorkflow, /npm ci/);
assert.match(verifyWorkflow, /node scripts\/verify-sql\.mjs/);
assert.match(verifyWorkflow, /npm run build/);

assert.doesNotMatch(navConfig, /\/app\/queues/);
assert.doesNotMatch(permissions, /"\/app\/queues"/);
assert.match(routeClassification, /"\/calls"[\s\S]*"classification": "internal"/);
assert.match(openapiVerifier, /internal route must not be published in OpenAPI/);

assert.match(performanceMigration, /create or replace function public\.navigation_badges/);
assert.match(performanceMigration, /create or replace function public\.report_sales_overview/);
assert.match(performanceMigration, /create or replace function public\.contract_registry_page/);
assert.match(performanceMigration, /create or replace function public\.customer_list_seller_workload/);
assert.match(reportsPage, /rpc\("report_sales_overview"/);
assert.match(contractsPage, /rpc\("contract_registry_page"/);
assert.match(dashboardPage, /getAppContext/);
assert.match(dashboardPage, /Teamdashboard/);

assert.match(customerSearch, /setTimeout[\s\S]*350/);
assert.match(customerSearch, /AbortError/);
assert.match(customerMultiSearch, /limit", "30"/);
assert.match(dialerPanel, /Dialer customer search failed/);
assert.doesNotMatch(dialerPage, /\.limit\(500\)/);
assert.doesNotMatch(listPage, /from\("customers"\)[\s\S]*\.limit\(500\)/);
assert.match(listPage, /CustomerMultiSearchSelect/);
assert.match(listPage, /customer_list_seller_workload/);

assert.match(apiAuth, /api_key_actor_requires_tenant_admin/);
assert.match(apiAuth, /assertApiObjectAccess/);
assert.match(processOutboxCurrent, /kundexa\.evidence\.v3/);
assert.match(processOutboxCurrent, /acceptance_generation/);

// Canonical tenant/user provisioning and mandatory first-login credential gate.
assert.match(canonicalProvisioningMigration, /create table if not exists private\.user_security_state/);
assert.match(canonicalProvisioningMigration, /alter table private\.user_security_state enable row level security/);
assert.match(canonicalProvisioningMigration, /create table if not exists private\.tenant_invitation_provisioning/);
assert.match(canonicalProvisioningMigration, /create table if not exists private\.tenant_owner_bootstrap_keys/);
assert.match(canonicalProvisioningMigration, /tenant_owner_bootstrap_already_exists/);
assert.match(canonicalProvisioningMigration, /create or replace function public\.reserve_tenant_invitation_v2/);
assert.match(canonicalProvisioningMigration, /create or replace function public\.create_or_resume_platform_tenant_owner/);
assert.match(canonicalProvisioningMigration, /p_primary_team_id uuid default null/);
assert.match(canonicalProvisioningMigration, /active_operational_member_requires_primary_team/);
assert.match(canonicalProvisioningMigration, /legacy_active_operational_members_require_explicit_primary_team_resolution/);
assert.match(canonicalProvisioningMigration, /delete from public\.team_members[\s\S]*not \(team_id=any\(v_team_ids\)\)/);
assert.match(canonicalProvisioningMigration, /tenant\.member_suspended/);
assert.match(canonicalProvisioningMigration, /tenant\.member_removed/);
assert.match(canonicalProvisioningMigration, /tenant\.member_reactivated/);
assert.match(canonicalProvisioningMigration, /if v_role='team_lead' then/);
assert.doesNotMatch(canonicalProvisioningMigration, /team_ids\[1\]/);
assert.doesNotMatch(canonicalProvisioningMigration, /select\s+[^;]*team_id[^;]*into\s+v_primary[^;]*order by[^;]*team_id/is);
assert.match(canonicalProvisioningMigration, /revoke all on function public\.create_tenant_with_owner/);
assert.match(canonicalProvisioningMigration, /revoke all on function public\.create_platform_tenant/);
assert.match(provisionUserSource, /admin\.auth\.admin\.createUser/);
assert.doesNotMatch(provisionUserSource, /inviteUserByEmail/);
assert.match(provisionUserSource, /Existing Auth users are reused/);
assert.match(provisionUserSource, /concurrent request may have created the same Auth identity/i);
assert.match(organizationActions, /export async function createUser/);
assert.match(organizationActions, /reserve_tenant_invitation_v2/);
assert.doesNotMatch(organizationActions, /inviteUserByEmail/);
assert.match(platformListActions, /create_or_resume_platform_tenant_owner/);
assert.match(platformListActions, /provisionUser/);
assert.doesNotMatch(platformListActions, /inviteUserByEmail/);
assert.match(usersPage, /Skapa användare/);
assert.match(usersPage, /name="primary_team_id"/);
assert.match(changePasswordAction, /supabase\.auth\.updateUser\(\{ password:/);
assert.ok(changePasswordAction.indexOf('auth.updateUser') < changePasswordAction.indexOf('complete_user_password_change'), 'Security state must clear only after Auth password update');
assert.ok(changePasswordAction.indexOf('complete_user_password_change') < changePasswordAction.indexOf('activate_current_user_invitation'), 'Tenant/team activation must happen only after password replacement');
assert.ok(authActions.indexOf('current_user_security_state') < authActions.indexOf('activate_current_user_invitation'), 'Login must enforce the first-login gate before invitation activation');
assert.match(auth, /current_user_security_state/);
assert.match(apiAuth, /password_change_required/);
assert.match(registerPage, /Publik registrering är stängd/);

console.log("Remediation regression tests passed.");


// Every worker Vercel schedules must go through the invoker that writes a
// heartbeat, because `platform_worker_heartbeats` is what the platform page and
// the dialer readiness checks read. `process-outbox` used to have its own route
// that forwarded the request and returned the body — so the worker that delivers
// every contract, SMS and reminder was the one whose total silence was
// indistinguishable from health.
{
  const scheduledPaths = JSON.parse(vercelConfig).crons.map((entry) => entry.path);
  const scheduledWorkers = scheduledPaths
    .map((path) => path.replace("/api/cron/edge-workers/", "").replace("/api/cron/", ""))
    .sort();
  const monitored = [...scheduledEdgeWorker.matchAll(/^\s*"([a-z-]+)",$/gm)].map((match) => match[1]).sort();
  assert.deepEqual(monitored, scheduledWorkers,
    `Scheduled workers and heartbeat-monitored workers disagree: cron=${scheduledWorkers}, monitored=${monitored}`);
  assert.match(processOutboxCron, /invokeScheduledEdgeWorker\("process-outbox"\)/);
  assert.doesNotMatch(processOutboxCron, /functions\/v1\/process-outbox/);
}
console.log("Every Vercel-scheduled Edge worker records a heartbeat through the same invoker.");


// Every dashboard page must be reachable: a rule in `routeAccessMap` and, unless
// it is a detail or wizard page opened from its parent, an entry in the sidebar.
// `/app/queues` had neither — the layout redirects on a missing rule, so it
// answered "du saknar behörighet" to every role for a page that had no
// permission rule at all, and nothing anywhere linked to it.
{
  const { readdirSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const root = new URL("../src/app/(dashboard)/app", import.meta.url).pathname;
  const routes = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, `${prefix}/${entry}`);
      else if (entry === "page.tsx") routes.push(prefix || "/app");
    }
  };
  walk(root, "/app");

  const ruled = [...permissions.matchAll(/"(\/app[^"]*)":\s*\{/g)].map((match) => match[1]);
  const navHrefs = [...navConfig.matchAll(/href:\s*"(\/app[^"]*)"/g)].map((match) => match[1]);
  const resolves = (route) => ruled.some((rule) => rule === "/app"
    ? route === "/app"
    : route === rule || route.startsWith(`${rule}/`));

  // `/app/platform*` is exempt because the layout returns early for it on a
  // platform context, before the tenant guard runs — a different gate, not a
  // missing one. That branch is already pinned above, where `appLayout` is
  // asserted to compute `platformMode` and call `getPlatformContext`.
  const unreachable = routes.filter((route) =>
    !route.includes("[") && !route.startsWith("/app/platform") && !resolves(route));
  assert.deepEqual(unreachable, [],
    `Pages with no routeAccessMap rule are redirected away from for every role: ${unreachable}`);

  // A page that is neither in the nav nor a child of a navigated route can only
  // be found by typing its URL.
  const findable = (route) => navHrefs.some((href) => route === href || route.startsWith(`${href}/`))
    || route === "/app" || route.startsWith("/app/platform");
  const hidden = routes.filter((route) => !route.includes("[") && !findable(route));
  assert.deepEqual(hidden, [], `Pages with no navigation path: ${hidden}`);
}
console.log("Every dashboard page has an access rule and a navigation path.");

// A page opens on `routeAccessMap`, but the server actions inside it assert
// their own, narrower permission. Where the two differ, a role that may open
// the page sees a form that `assertPermission` will always refuse — and since
// that refusal is a thrown Error, not a message, it was a crash rather than an
// answer. Every such (page, action) pair must therefore be wrapped in a gate on
// the page: `can(role, "<the action's permission>")` or `isAdmin(role)` for the
// admin-context actions.
{
  const { readdirSync, statSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const base = new URL("..", import.meta.url).pathname;

  const roleBlock = permissions.slice(permissions.indexOf("const rolePermissions"), permissions.indexOf("export const segmentCreateRoles"));
  const rolePerms = {};
  for (const match of roleBlock.matchAll(/^\s{2}(\w+):\s*\[([^\]]*)\],?$/gm)) {
    rolePerms[match[1]] = [...match[2].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
  }
  const allRoles = Object.keys(rolePerms);
  assert.ok(allRoles.length >= 8, "rolePermissions parsed");
  const grants = (role, permission) => (rolePerms[role] ?? []).includes(permission);

  const mapBlock = permissions.slice(permissions.indexOf("export const routeAccessMap"), permissions.indexOf("export type ResourceName"));
  const routeRules = {};
  for (const match of mapBlock.matchAll(/"(\/app[^"]*)":\s*\{([^}]*)\}/g)) {
    const roles = /roles:\s*\[([^\]]*)\]/.exec(match[2]);
    const anyPermission = /anyPermission:\s*\[([^\]]*)\]/.exec(match[2]);
    routeRules[match[1]] = {
      roles: roles ? [...roles[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]) : null,
      anyPermission: anyPermission ? [...anyPermission[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]) : null,
    };
  }
  const ruleFor = (route) => Object.entries(routeRules)
    .sort(([a], [b]) => b.length - a.length)
    .find(([rule]) => (rule === "/app" ? route === rule : route === rule || route.startsWith(`${rule}/`)))?.[1] ?? null;
  const viewersOf = (route) => {
    const rule = ruleFor(route);
    if (!rule) return [];
    return allRoles.filter((role) => rule.roles?.includes(role)
      || (rule.anyPermission?.some((permission) => grants(role, permission)) ?? false));
  };

  // action name -> the permission or admin context it asserts
  const actionGate = {};
  for (const file of readdirSync(join(base, "src/app/actions")).filter((name) => name.endsWith(".ts"))) {
    const source = readFileSync(join(base, "src/app/actions", file), "utf8");
    for (const part of source.split(/export async function /).slice(1)) {
      const name = /^([A-Za-z0-9_]+)/.exec(part)?.[1];
      if (!name) continue;
      const boundary = part.search(/\n(?=export )/);
      const body = boundary === -1 ? part : part.slice(0, boundary);
      actionGate[name] = {
        permission: /assertPermission\([^,]+,\s*"([^"]+)"\)/.exec(body)?.[1] ?? null,
        contextFn: /await (adminContext|tenantAdminContext|platformAdminContext)\(\)/.exec(body)?.[1] ?? null,
      };
    }
  }

  const pages = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, `${prefix}/${entry}`);
      else if (entry === "page.tsx") pages.push({ route: prefix || "/app", file: full });
    }
  };
  walk(join(base, "src/app/(dashboard)/app"), "/app");

  // `/app/lists/[id]` gates its whole management column on the RPC
  // `can_manage_customer_list`, which asks the database who manages *this* list
  // rather than what the role may do in general. That is a stricter gate than
  // `can(role, "lists.manage")`, so the page is exempt from the textual check.
  const runtimeGated = { "/app/lists/[id]": "can_manage_customer_list" };

  const ungated = [];
  for (const page of pages) {
    const source = readFileSync(page.file, "utf8");
    const imported = new Set();
    for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*"@\/app\/actions\/[^"]+"/g)) {
      for (const name of match[1].split(",").map((entry) => entry.trim().split(" as ")[0]).filter(Boolean)) imported.add(name);
    }
    const used = [...imported].filter((name) => new RegExp(`action=\\{${name}\\}`).test(source));
    const viewers = viewersOf(page.route);
    if (!viewers.length) continue;
    const runtimeGuard = runtimeGated[page.route];
    for (const action of used) {
      const gate = actionGate[action];
      if (!gate) continue;
      let allowed;
      if (gate.permission) allowed = viewers.filter((role) => grants(role, gate.permission));
      else if (gate.contextFn === "adminContext" || gate.contextFn === "platformAdminContext") allowed = viewers.filter((role) => ["owner", "admin"].includes(role));
      else if (gate.contextFn === "tenantAdminContext") allowed = viewers.filter((role) => ["owner", "admin", "team_lead"].includes(role));
      else continue;
      if (allowed.length === viewers.length) continue; // every viewer may act
      const gated = runtimeGuard ? source.includes(runtimeGuard)
        : gate.permission ? source.includes(`can(${/can\((\w+)\.role/.exec(source)?.[1] ?? "context"}.role, "${gate.permission}")`)
          || new RegExp(`can\\([\\w.]+\\.role,\\s*"${gate.permission.replace(".", "\\.")}"\\)`).test(source)
        : /isAdmin\([\w.]+\.role\)/.test(source);
      if (!gated) ungated.push(`${page.route} → ${action} (${gate.permission ?? gate.contextFn}) refused for ${viewers.filter((role) => !allowed.includes(role)).join(", ")}`);
    }
  }
  assert.deepEqual(ungated, [], `Forms shown to roles whose server action refuses them:\n${ungated.join("\n")}`);
}
console.log("Every role-restricted form is gated on the permission its action asserts.");

// A server action reports a refusal by bouncing back with `?error=`. If the page
// it lands on does not read that parameter, the refusal is swallowed: the user
// is returned to an unchanged screen with their work gone and nothing said.
// `/app/dialer/lists/[id]` took no searchParams at all while
// `setCallDisposition` redirected list-bound calls to it with exactly that.
{
  const { readdirSync, statSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const base = new URL("..", import.meta.url).pathname;

  const pageSource = new Map();
  const walkPages = (dir, prefix) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walkPages(full, `${prefix}/${entry}`);
      else if (entry === "page.tsx") pageSource.set(prefix || "/app", readFileSync(full, "utf8"));
    }
  };
  walkPages(join(base, "src/app/(dashboard)/app"), "/app");

  // a literal target matches a dynamic route segment-for-segment
  const routeFor = (target) => {
    if (pageSource.has(target)) return target;
    const segments = target.split("/");
    for (const route of pageSource.keys()) {
      const routeSegments = route.split("/");
      if (routeSegments.length !== segments.length) continue;
      if (routeSegments.every((segment, index) => segment.startsWith("[") || segment === segments[index])) return route;
    }
    return null;
  };

  const actionFiles = readdirSync(join(base, "src/app/actions")).filter((name) => /\.tsx?$/.test(name));
  const swallowed = [];
  for (const file of actionFiles) {
    const source = readFileSync(join(base, "src/app/actions", file), "utf8");
    for (const match of source.matchAll(/redirect\(\s*[`'"]([^`'"]*?)\?(\w+)=/g)) {
      const target = match[1].replace(/\$\{[^}]*\}/g, "X");
      const parameter = match[2];
      if (!target.startsWith("/app")) continue; // public /accept pages are checked by the contract tests
      const route = routeFor(target);
      if (!route) { swallowed.push(`${file}: redirects to ${target} — no page matches that route`); continue; }
      const page = pageSource.get(route);
      // Must be an actual read — `query.error`, or a destructuring of the awaited
      // searchParams. Accepting a bare `error?:` matched the *type annotation*,
      // so the check passed for a page that renders nothing.
      const renders = new RegExp(`\\.${parameter}\\b`).test(page)
        || new RegExp(`\\{[^}]*\\b${parameter}\\b[^}]*\\}\\s*=\\s*await\\s+searchParams`).test(page);
      if (!renders) swallowed.push(`${route} never renders ?${parameter}= (sent by ${file})`);
    }
  }
  assert.deepEqual([...new Set(swallowed)].sort(), [],
    `Server actions redirecting to a parameter the page never shows:\n${[...new Set(swallowed)].join("\n")}`);
}
console.log("Every action redirect lands on a page that renders the parameter.");

// PostgREST does not throw. A read that fails comes back as `{ data: null,
// error }`, so a page destructuring only `data` renders a broken query exactly
// like a query that found nothing: "Inga poster ännu". On a tenant still being
// filled that is the difference between "you have not added customers yet" and
// "the customer list is broken", shown identically. Every page read must
// therefore either bind `error` or go through `ok()` from
// src/lib/supabase/read.ts, which turns the failure into a thrown error the
// boundary can show.
{
  const { readdirSync, statSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { unguardedReads } = await import("./unguarded-reads.mjs");
  const base = new URL("..", import.meta.url).pathname;

  const pages = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry === "page.tsx") pages.push(full);
    }
  };
  walk(join(base, "src/app"));
  assert.ok(pages.length >= 40, `expected to find the app's pages, found ${pages.length}`);

  const unguarded = pages.sort().flatMap((file) =>
    unguardedReads(readFileSync(file, "utf8"), file.slice(base.length)));
  assert.deepEqual(unguarded, [],
    `Page reads that render a failure as emptiness:\n${unguarded.join("\n")}`);

  // The checker is only worth having if it can see a read in the first place.
  // Its first version hard-coded the client name `supabase`, so seven pages that
  // call it `s` were invisible — to the fix and to the check that was meant to
  // prove the fix. Pin that it follows the local name.
  const { clientNames, unguardedReads: scan } = await import("./unguarded-reads.mjs");
  assert.deepEqual([...clientNames("const s = await createClient();")], ["s"]);
  assert.equal(scan(`const s = await createClient();\nconst { data } = await s.from("x").select("*");\n`, "t").length, 1,
    "a read through a locally named client must still be seen");
  assert.equal(scan(`const s = await createClient();\nconst { data } = await ok(s.from("x").select("*"));\n`, "t").length, 0,
    "an ok()-wrapped read must be accepted");
  assert.equal(scan(`const s = await createClient();\nconst { data, error } = await s.from("x").select("*");\n`, "t").length, 0,
    "an error-checked read must be accepted");
}
console.log("Every page read is error-checked or wrapped in ok().");

// The telephony service has no hangup endpoint — `POST /dial` is its only
// call-control surface. A control labelled "Avsluta samtalet" therefore promises
// something the system cannot do, and on 2026-09-15 the owner pressed it and the
// phone went on ringing. Kundexa releases the seat; the leg is dropped on the
// device. Explaining that in small print under the button was not enough: people
// act on the label.
{
  const { readFileSync } = await import("node:fs");
  const base = new URL("..", import.meta.url).pathname;
  const dialers = [
    "src/components/dialer-panel.tsx",
    "src/components/list-dialer-workspace.tsx",
  ];
  for (const file of dialers) {
    const source = readFileSync(base + file, "utf8");
    assert.ok(!source.includes("Avsluta samtalet"),
      `${file} labels a control "Avsluta samtalet", which the telephony service cannot do`);
    // The honest pair: cancel while it is still ringing, release once answered.
    assert.ok(source.includes("Avbryt uppringningen") && source.includes("Frigör för nästa samtal"),
      `${file} must distinguish cancelling an unanswered dial from releasing an answered one`);
    assert.ok(source.includes("kan inte kopplas ned härifrån"),
      `${file} must say that the call is hung up on the device`);
  }
}
console.log("No dialer offers to end a call the telephony service cannot end.");

// A commit that changes an Edge Function and does not deploy it leaves production
// running code nobody chose. That used to pass as a warning on a green run, and
// four functions drifted behind main unnoticed until someone compared timestamps
// by hand. The deploy workflow must fail on missing credentials, not warn.
{
  const { readFileSync } = await import("node:fs");
  const base = new URL("..", import.meta.url).pathname;
  const workflow = readFileSync(base + ".github/workflows/deploy-edge-functions.yml", "utf8");
  assert.ok(workflow.includes("::error title=Edge Functions were not deployed"),
    "a skipped Edge Function deploy must be an error annotation, not a warning");
  assert.ok(!workflow.includes("::warning title=Edge Functions were not deployed"),
    "the skipped-deploy warning must not come back: a warning on a green run is what let four functions drift");
  assert.ok(/echo "ready=false" >> "\$GITHUB_OUTPUT"[\s\S]*?\n\s*exit 1\n/.test(workflow),
    "the credential check must exit non-zero when the deploy cannot run");
}
console.log("A skipped Edge Function deploy fails the run instead of passing as a warning.");

// A contract is issued by one of the tenant's legal entities, and which one is
// frozen into contracts.seller_snapshot at send time. The reminder header and the
// From name both used tenants.legal_name — the group name — so a tenant with more
// than one company reminded the customer in the wrong company's name, on a
// binding document.
{
  const { readFileSync } = await import("node:fs");
  const base = new URL("..", import.meta.url).pathname;
  const source = readFileSync(base + "supabase/functions/process-outbox/index.ts", "utf8");

  assert.ok(source.includes("async function contractIssuerName("),
    "process-outbox must resolve the issuing legal entity for contract e-mail");
  assert.ok(!/escapeHtml\(tenant\.legal_name\)/.test(source),
    "the reminder header must name the issuing legal entity, not the tenant");
  assert.ok(source.includes("escapeHtml(issuerLegalName)"),
    "the reminder header must render the issuer resolved from the contract snapshot");
  assert.ok(source.includes("const senderIdentity = `${cleanHeaderName(issuerName)} <${config.address}>`"),
    "the From name on a contract e-mail must be the issuing legal entity");
  assert.ok(!/from: email\.from_address === "pending@kundexa\.local" \? config\.formattedFrom/.test(source),
    "the tenant-wide From name must not be used for a contract-bound message");
  // A failed read is not a verdict. Falling back to the group name on an error
  // would reintroduce the same wrong sender, invisibly.
  assert.ok(source.includes("contract_issuer_read_failed"),
    "a failed issuer lookup must raise rather than silently fall back to the tenant name");
}
console.log("Contract e-mail is sent in the name of the legal entity that issued the contract.");

// Kundexa contains no webphone — no SIP, no WebRTC, no audio — and the provider's
// muteOtherDevicesOnWebphone only silences other devices while one is online. So a
// correct dial policy does not mean the call rings in the browser: it rings the
// phone on the seat. Telling the seller "Webbtelefonen" is the same false claim
// that was just removed from the warning beneath it, and with the warning gone
// there would be nothing left to contradict it.
{
  const { readFileSync } = await import("node:fs");
  const base = new URL("..", import.meta.url).pathname;
  for (const file of ["src/components/dialer-panel.tsx", "src/components/list-dialer-workspace.tsx"]) {
    const source = readFileSync(base + file, "utf8");
    const claims = source.split("\n").filter((line) =>
      /["'`]Webbtelefonen/.test(line) && !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*"));
    assert.deepEqual(claims, [],
      `${file} tells the seller the call rings a webphone that does not exist:\n${claims.join("\n")}`);
  }
}
console.log("No dialer claims the call rings a webphone Kundexa does not have.");

// Being signed out is a claim about authentication, and neither of these is one.
//
// enforceFirstLoginGate runs on every page load, in both the tenant and the platform
// context. Redirecting to /login on any RPC error turned one slow query into "you are
// signed out" — and bought nothing, because the gate exists to force a password change
// and a bounced user simply signs back in and meets it again.
//
// The proxy's redirects then made that permanent: getUser() can rotate the refresh
// token, and the rotation is spent the moment GoTrue answers. A redirect built without
// those cookies leaves the browser holding a token the server has already retired.
{
  const { readFileSync } = await import("node:fs");
  const base = new URL("..", import.meta.url).pathname;

  const auth = readFileSync(base + "src/lib/auth.ts", "utf8");
  const gate = auth.slice(auth.indexOf("async function enforceFirstLoginGate"));
  const gateBody = gate.slice(0, gate.indexOf("\n}"));
  assert.ok(!/redirect\("\/login/.test(gateBody),
    "a failed security-state read must not sign the user out");
  assert.ok(/throw new Error\("security_state_unavailable"\)/.test(gateBody),
    "a failed security-state read must surface as an error, not as a silent pass");
  // The gate must still do the one thing it is for.
  assert.ok(/must_change_password.*redirect\("\/change-password"\)/s.test(gateBody),
    "the first-login gate must still force a password change");

  const proxy = readFileSync(base + "src/lib/supabase/proxy.ts", "utf8");
  assert.ok(proxy.includes("const withRefreshedSession ="),
    "the proxy must have one exit that carries refreshed auth cookies");
  const redirects = proxy.match(/return\s+\S+\(NextResponse\.redirect\(/g) ?? [];
  assert.ok(redirects.length >= 2, `expected the proxy's two redirects, found ${redirects.length}`);
  assert.deepEqual(
    redirects.filter((line) => !line.includes("withRefreshedSession")), [],
    "every proxy redirect must carry the refreshed session, or it retires a token the browser still holds");
}
console.log("A database blip cannot sign a user out, and no redirect drops a refreshed session.");
