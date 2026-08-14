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
  platformTelephonyPage,
  rinkelActions,
  proxy,
  organizationActions,
  topbar,
  onboarding,
  bootstrapPlatformOwner,
  rinkelClient,
  deviceMigration,
  sellerNumberAssignmentMigration,
  rinkelMappingForm,
  rinkelWebhookRoute,
  rinkelWebhookRepairMigration,
  verifier,
  sqlVerifier,
  invitationMigration,
  listDistributionMigration,
  rinkelRuntimeMigration,
  contractGenerationMigration,
  publicContractAction,
  smsInboundRoute,
  permissions,
  sidebar,
  verifyWorkflow,
  openapiVerifier,
] = await Promise.all([
  read("supabase/migrations/202608080001_cross_surface_consistency_remediation.sql"),
  read("supabase/migrations/202608080002_database_lint_runtime_hardening.sql"),
  read("src/app/api/v1/customers/route.ts"),
  read("src/app/actions/products.ts"),
  read("src/app/api/v1/calls/route.ts"),
  read("src/app/api/v1/telephony/status/route.ts"),
  read("src/app/api/openapi.json/route.ts"),
  read("src/hooks/use-rinkel-dialer.ts"),
  read("src/app/(dashboard)/app/platform/page.tsx"),
  read("src/app/(dashboard)/app/platform/lists/page.tsx"),
  read("src/lib/supabase/auth-admin-users.ts"),
  read("src/app/actions/contracts.ts"),
  read("src/lib/contracts/api-service.ts"),
  read("src/app/api/webhooks/resend/[token]/route.ts"),
  read("src/app/actions/customers.ts"),
  read("src/app/actions/admin.ts"),
  read("supabase/functions/automation-runner/index.ts"),
  read("src/app/api/webhooks/46elks/sms/delivery/route.ts"),
  read("supabase/functions/process-outbox/index.ts"),
  read("src/lib/auth.ts"),
  read("src/app/(dashboard)/app/layout.tsx"),
  read("src/app/(dashboard)/app/platform/telephony/page.tsx"),
  read("src/app/actions/rinkel.ts"),
  read("src/lib/supabase/proxy.ts"),
  read("src/app/actions/organization.ts"),
  read("src/components/app-shell/topbar.tsx"),
  read("src/app/onboarding/page.tsx"),
  read("scripts/bootstrap-platform-owner.mjs"),
  read("supabase/functions/_shared/rinkel.ts"),
  read("supabase/migrations/202608100002_rinkel_device_inventory_mapping_hardening.sql"),
  read("supabase/migrations/20260814124751_rinkel_seller_number_assignment_without_device.sql"),
  read("src/components/rinkel-user-mapping-form.tsx"),
  read("src/app/api/webhooks/rinkel/[secret]/[event]/route.ts"),
  read("supabase/migrations/202608100003_rinkel_webhook_live_verification_repair.sql"),
  read("scripts/verify.mjs"),
  read("scripts/verify-sql.mjs"),
  read("supabase/migrations/202608100004_invitation_membership_team_hardening.sql"),
  read("supabase/migrations/202608100005_list_distribution_dialer_authorization.sql"),
  read("supabase/migrations/202608100006_rinkel_runtime_authorization_and_failure_recovery.sql"),
  read("supabase/migrations/202608100007_contract_acceptance_generation_and_policy.sql"),
  read("src/app/actions/public-contract.ts"),
  read("src/app/api/webhooks/46elks/sms/inbound/route.ts"),
  read("src/lib/permissions.ts"),
  read("src/components/app-shell/sidebar.tsx"),
  read(".github/workflows/verify.yml"),
  read("scripts/verify-openapi-coverage.mjs"),
]);

const [
  securityProjectionMigration, signingCompletionMigration, performanceMigration, workerScheduler, edgeWorkerCron,
  navConfig, customerSearch, customerMultiSearch, rinkelDialer, dialerPage, listPage, contractsPage, reportsPage, dashboardPage,
  apiAuth, routeClassification, processOutboxCurrent, teamDailyLeadLimitMigration, rinkelProjectionMonotonicMigration,
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
  read("src/components/rinkel-dialer.tsx"),
  read("src/app/(dashboard)/app/dialer/page.tsx"),
  read("src/app/(dashboard)/app/lists/[id]/page.tsx"),
  read("src/app/(dashboard)/app/contracts/page.tsx"),
  read("src/app/(dashboard)/app/reports/page.tsx"),
  read("src/app/(dashboard)/app/page.tsx"),
  read("src/lib/api-auth.ts"),
  read("scripts/api-route-classification.json"),
  read("supabase/functions/process-outbox/index.ts"),
  read("supabase/migrations/202608100011_team_daily_lead_limit_enforcement.sql"),
  read("supabase/migrations/202608100012_rinkel_projection_monotonic_outcome_recording.sql"),
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

// Rinkel provider projection is monotonic across late/out-of-order lifecycle events.
assert.match(rinkelProjectionMonotonicMigration, /old\.recording_status in \('available_at_provider','copy_pending','stored_privately'\)/);
assert.match(rinkelProjectionMonotonicMigration, /old\.provider_outcome is not null and new\.provider_outcome is null/);
assert.match(rinkelProjectionMonotonicMigration, /new\.provider_outcome:=old\.provider_outcome/);
assert.match(rinkelProjectionMonotonicMigration, /public\.call_status_rank\(old\.status\)=100/);

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

for (const source of [calls, telephonyStatus, dialerHook]) {
  assert.match(source, /RINKEL_RUNTIME_API_KEY_MISSING|runtimeConfigured/);
}
assert.match(calls, /if \(!isPlatformRinkelRuntimeConfigured\(\)\)/);

// Platform control-plane authorization must never depend on tenant workspace state.
const platformContextBody = auth.slice(auth.indexOf("export const getPlatformContext"));
assert.match(platformContextBody, /from\("platform_memberships"\)/);
assert.doesNotMatch(platformContextBody, /getAppContext\(/);
assert.doesNotMatch(platformContextBody, /active_tenant_id/);
assert.match(auth, /if \(platformRole\) redirect\("\/app\/platform"\)/);
assert.match(proxy, /requestHeaders\.set\("x-kundexa-path", request\.nextUrl\.pathname\)/);
assert.match(appLayout, /platformMode = pathname === "\/app\/platform"/);
assert.match(appLayout, /const platform = await getPlatformContext\(\)/);
assert.match(platformTelephonyPage, /const context = await getPlatformContext\(\)/);
assert.doesNotMatch(platformTelephonyPage, /getAppContext/);
assert.match(rinkelActions, /async function platformAdminContext\(\)[\s\S]*getPlatformContext\(\)/);
assert.match(rinkelClient, /async testWebhook\(event: RinkelWebhookEvent, url: string\)[\s\S]*body: \{ url \}/);
assert.match(rinkelActions, /status: "test_pending"[\s\S]*test_requested_at: testRequestedAt[\s\S]*client\.testWebhook\(event, url\)/);
assert.match(rinkelActions, /const coreWebhooksVerified = verifiedCoreCount === RINKEL_CORE_WEBHOOK_EVENTS\.length[\s\S]*webhooks: coreWebhooksVerified[\s\S]*core_webhooks_verified: coreWebhooksVerified/);
assert.match(rinkelClient, /async listUsersWithDeviceDetails\(\)/);
assert.match(rinkelClient, /async getUser\(userId: string, fallback\?: RinkelUser\)/);
// Rinkel's user schema exposes one nullable scalar deviceId and no devices[], so a
// present scalar key is the authoritative per-user inventory. Anchoring completeness
// on devices[] alone made it unreachable and left retired devices active forever.
assert.match(rinkelClient, /deviceInventoryComplete: hasDeviceArray \|\| Boolean\(scalarDeviceKey\)/);
assert.match(rinkelClient, /if \(!user\.deviceInventoryComplete \|\| user\.deviceInventoryError\) return \[\]/);
assert.match(rinkelActions, /client\.listUsersWithDeviceDetails\(\)/);
assert.match(rinkelActions, /staleRinkelDeviceIds/);
assert.match(rinkelActions, /repairUniqueRinkelDeviceMappings/);
assert.match(rinkelActions, /_kundexa_sync/);
assert.match(deviceMigration, /RINKEL_USER_DEVICE_MISSING/);
assert.match(deviceMigration, /deviceInventoryComplete/);
assert.match(deviceMigration, /activeDeviceCount/);
assert.match(deviceMigration, /set search_path=''/);
assert.match(rinkelMappingForm, /if \(nextDevices\.length === 1\) setSelectedDeviceId\(nextDevices\[0\]\.id\)/);
// Rinkel has no device catalog endpoint, so a provider user without a registered
// webphone has no device id. Assigning a number to a seller must stay possible;
// only dialing is allowed to require a synchronized device.
assert.match(sellerNumberAssignmentMigration, /set search_path=''/);
assert.match(sellerNumberAssignmentMigration, /DEVICE_SELECTION_REQUIRED/);
assert.doesNotMatch(
  sellerNumberAssignmentMigration.split("elsif p_resource_type='number'")[0],
  /raise exception 'RINKEL_USER_DEVICE_MISSING'/,
);
assert.match(rinkelMappingForm, /disabled=\{!user\.active\}/);
assert.match(rinkelMappingForm, /required=\{activeDevices\.length > 0\}/);
assert.doesNotMatch(rinkelMappingForm, /device-inventering ej verifierad/);
assert.match(rinkelActions, /p_selected_device_id: value\(form, "selected_device_id"\) \|\| null/);

// The public Rinkel callback owns validation + one atomic ingest RPC. Durable
// event/job/idempotency invariants belong to the latest forward-only migration.
assert.match(rinkelWebhookRoute, /admin\.rpc\("ingest_platform_rinkel_webhook_event"/);
assert.doesNotMatch(rinkelWebhookRoute, /\.from\("platform_rinkel_webhook_events"\)/);
assert.match(rinkelWebhookRepairMigration, /insert into public\.platform_rinkel_webhook_events/);
assert.match(rinkelWebhookRepairMigration, /insert into public\.platform_rinkel_jobs/);
assert.match(rinkelWebhookRepairMigration, /'rinkel\.process_event'/);
assert.match(rinkelWebhookRepairMigration, /on conflict\(idempotency_key\) do nothing/);
assert.match(verifier, /ingest_platform_rinkel_webhook_event/);
const verifierWebhookBlock = verifier.slice(verifier.indexOf("const rinkelWebhook ="), verifier.indexOf("const rinkelCalls ="));
assert.doesNotMatch(verifierWebhookBlock, /\/platform_rinkel_webhook_events\//);

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

assert.match(outbox, /reconcileSubmitted46ElksSms/);
assert.match(outbox, /message_id=\$\{encodeURIComponent\(sms\.id\)\}/);
assert.match(outbox, /sms_submission_reconciliation_pending/);
assert.ok(outbox.indexOf("permanent_sms_outbound_feature_disabled") < outbox.indexOf("const credentials = await get46ElksCredentials(job.tenant_id)"), "SMS feature gate must run before provider credentials/reconciliation");
assert.match(smsDelivery, /message_id/);
assert.match(smsDelivery, /provider_message_id: providerId/);
assert.match(smsDelivery, /from_number/);

// Migration hygiene: the device hardening must use a unique version and SQL special
// forms such as COALESCE must never be schema-qualified as functions.
assert.doesNotMatch(deviceMigration, /pg_catalog\.coalesce\s*\(/i);
assert.match(sqlVerifier, /rejectedCrossTenantNumberAllocation/);
assert.match(sqlVerifier, /RINKEL_NUMBER_TENANT_CONFLICT/);
assert.match(sqlVerifier, /singleTenantPlatformAllocation/);
assert.match(sqlVerifier, /Tenant B caller-ID projection leaked another tenant's Rinkel number/);
assert.doesNotMatch(sqlVerifier, /Central Rinkel number was not shareable across tenants/);
assert.doesNotMatch(sqlVerifier, /Shared caller ID was not visible in tenant B/);

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

assert.match(rinkelRuntimeMigration, /can_access_customer\(p_customer_id\)/);
assert.match(rinkelRuntimeMigration, /create or replace function public\.evaluate_exact_call_policy/);
assert.match(rinkelRuntimeMigration, /exact_call_policy_denied/);
assert.match(rinkelRuntimeMigration, /evaluate_contact_policy_for_tenant/);
assert.match(rinkelRuntimeMigration, /v_purpose:='direct_marketing'/);
assert.match(rinkelRuntimeMigration, /provider_rejected_before_start/);
assert.match(rinkelRuntimeMigration, /not tm\.assignment_paused/);
assert.match(rinkelRuntimeMigration, /RINKEL_MAPPING_TENANT_ADMIN_REQUIRED/);
assert.match(sqlVerifier, /00000000-0000-0000-0000-000000000025','\+46702222225','runtime','1','not_listed'/);
assert.match(sqlVerifier, /centralResult\.purpose !== \"direct_marketing\"/);
assert.match(sqlVerifier, /create function auth\.jwt\(\) returns jsonb/);
assert.match(sqlVerifier, /set_config\('request\.jwt\.claim\.role','service_role',false\)[\s\S]*rinkel_finalize_platform_dial[\s\S]*set_config\('request\.jwt\.claim\.role','authenticated',false\)/);

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
assert.match(securityProjectionMigration, /create or replace function public\.get_tenant_rinkel_resources/);
assert.match(securityProjectionMigration, /create or replace function public\.get_current_user_rinkel_numbers/);
assert.match(securityProjectionMigration, /create or replace function public\.get_managed_team_rinkel_resources/);
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
assert.match(rinkelDialer, /Dialer customer search failed/);
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
