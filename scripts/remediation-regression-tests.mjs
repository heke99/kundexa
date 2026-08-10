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
  rinkelMappingForm,
  rinkelWebhookRoute,
  rinkelWebhookRepairMigration,
  verifier,
  sqlVerifier,
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
  read("src/components/rinkel-user-mapping-form.tsx"),
  read("src/app/api/webhooks/rinkel/[secret]/[event]/route.ts"),
  read("supabase/migrations/202608100003_rinkel_webhook_live_verification_repair.sql"),
  read("scripts/verify.mjs"),
  read("scripts/verify-sql.mjs"),
]);

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

for (const source of [calls, telephonyStatus, openapi, dialerHook]) {
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
assert.match(rinkelClient, /deviceInventoryComplete: hasDeviceArray/);
assert.match(rinkelClient, /if \(!user\.deviceInventoryComplete\) return \[\]/);
assert.match(rinkelActions, /client\.listUsersWithDeviceDetails\(\)/);
assert.match(rinkelActions, /staleRinkelDeviceIds/);
assert.match(rinkelActions, /repairUniqueRinkelDeviceMappings/);
assert.match(rinkelActions, /_kundexa_sync/);
assert.match(deviceMigration, /RINKEL_USER_DEVICE_MISSING/);
assert.match(deviceMigration, /deviceInventoryComplete/);
assert.match(deviceMigration, /activeDeviceCount/);
assert.match(deviceMigration, /set search_path=''/);
assert.match(rinkelMappingForm, /if \(nextDevices\.length === 1\) setSelectedDeviceId\(nextDevices\[0\]\.id\)/);
assert.match(rinkelMappingForm, /device-inventering ej verifierad/);

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
assert.match(onboarding, /if\(platformMembership\) redirect\('\/app\/platform'\)/);
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

console.log("Remediation regression tests passed.");
