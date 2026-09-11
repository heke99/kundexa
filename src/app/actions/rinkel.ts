"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getAppContext, getPlatformContext, isAdmin, isPlatformAdmin } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { sha256 } from "@/lib/crypto";
import { serverEnv } from "@/lib/env";
import { invokeRinkelPlatformWorker } from "@/lib/workers/rinkel-platform-worker";
import { toJson } from "@/lib/supabase/json";
import { createPlatformRinkelClient, rinkelSeatDialPolicy, staleRinkelDeviceIds } from "@/lib/integrations/rinkel/client";
import { safeRinkelError } from "@/lib/integrations/rinkel/errors";
import {
  RINKEL_CORE_WEBHOOK_EVENTS,
  RINKEL_OPTIONAL_WEBHOOK_EVENTS,
} from "@/lib/integrations/rinkel/schemas";
import type { RinkelNumber, RinkelUser } from "@/lib/integrations/rinkel/types";

type PlatformIntegration = {
  id: string;
  status: string;
  webhook_status?: string;
  capabilities: Record<string, unknown> | null;
  configuration: Record<string, unknown> | null;
  last_error_operation: string | null;
};

function value(form: FormData, key: string) {
  return String(form.get(key) ?? "").trim();
}

function go(path: string, kind: "message" | "error", message: string): never {
  redirect(`${path}?${kind}=${encodeURIComponent(message)}`);
}

async function tenantAdminContext() {
  const context = await getAppContext();
  if (!isAdmin(context.role) && context.role !== "team_lead") {
    throw new Error("Telefonibehörighet saknas.");
  }
  return context;
}

async function platformAdminContext() {
  const context = await getPlatformContext();
  if (!isPlatformAdmin(context.platformRole)) throw new Error("Plattformsadmin krävs.");
  return context;
}

type SafePlatformError = { code: string; message: string; retryable: boolean; outcomeUnknown: boolean };

function safePlatformError(error: unknown): SafePlatformError {
  const provider = safeRinkelError(error);
  if (provider.code !== "RINKEL_UNKNOWN_ERROR") return provider;
  if (error && typeof error === "object") {
    const candidate = error as { code?: unknown; message?: unknown };
    const databaseCode = typeof candidate.code === "string" ? candidate.code : "";
    const rawMessage = typeof candidate.message === "string" ? candidate.message : "";
    const explicitInternalCode = /^[A-Z][A-Z0-9_]{3,100}$/.test(databaseCode) ? databaseCode : null;
    const internalCode = explicitInternalCode ?? /^([A-Z][A-Z0-9_]{3,100})/.exec(rawMessage)?.[1] ?? null;
    if (internalCode) {
      const messages: Record<string, string> = {
        RINKEL_WEBHOOK_REGISTRATION_MISMATCH: "Den registrerade webhooken stämmer inte med Kundexas publika HTTPS-adress.",
        RINKEL_WORKER_CRON_SECRET_MISSING: "CRON_SECRET saknas i Vercels servermiljö.",
        RINKEL_WORKER_NOT_DEPLOYED: "Telefoniworkern är inte deployad i Supabase-projektet.",
        RINKEL_WORKER_SECRET_REJECTED: "Telefoniworkern nekade scheduler-anropet. Kontrollera att samma CRON_SECRET finns i Vercel och Supabase.",
        RINKEL_WORKER_FORBIDDEN: "Telefoniworkern saknar behörighet för scheduler-anropet.",
        RINKEL_WORKER_UNREACHABLE: "Telefoniworkerns Edge Function kunde inte nås.",
        RINKEL_WORKER_HTTP_401: "Telefoniworkern nekade scheduler-anropet. Kontrollera CRON_SECRET i Vercel och Supabase.",
        RINKEL_WORKER_HTTP_403: "Telefoniworkern saknar behörighet för scheduler-anropet.",
        RINKEL_PLATFORM_QUERY_FAILED: "Den centrala telefoni-integrationen kunde inte läsas.",
        RINKEL_PLATFORM_NOT_CONFIGURED: "Den centrala telefoni-integrationen är inte konfigurerad.",
        TEAM_SELECTION_REQUIRED: "Välj minst ett aktivt team.",
        ACTIVE_TEAM_SELECTION_INVALID: "Ett eller flera valda team är inaktiva eller finns inte längre.",
        ACTIVE_TEAM_NUMBER_GRANT_NOT_FOUND: "Teamets nummeråtkomst finns inte längre.",
        PHONE_NUMBER_INACTIVE: "Telefonnumret är inaktivt eller saknas i katalogen.",
        TENANT_NOT_ACTIVE: "Ett valt bolag är inte aktivt.",
        DEVICE_MISSING: "Den valda telefonienheten är inaktiv eller hör inte till den valda telefoni-användaren.",
        RINKEL_USER_DEVICE_MISSING: "Telefoni-användaren saknar en registrerad enhet hos leverantören. Säljaren måste logga in i leverantörens webbtelefon eller app, därefter synkroniseras katalogen.",
        PLATFORM_ADMIN_REQUIRED: "Åtgärden kräver en plattformsadministratör.",
        INVALID_ASSIGNMENT_SCOPE: "Välj om numret ska tilldelas ett bolag, ett team eller en säljare.",
        TENANT_SELECTION_REQUIRED: "Välj ett bolag.",
        SELLER_SELECTION_REQUIRED: "Välj minst en säljare.",
        ACTIVE_SELLER_SELECTION_INVALID: "En eller flera valda säljare är inte aktiva medlemmar i ett aktivt bolag.",
        ASSIGNMENT_TARGET_NOT_FOUND: "Tilldelningen hade inget giltigt mål.",
        EXPLICIT_PROVIDER_USER_REQUIRES_SINGLE_SELLER: "En vald telefoni-användare kan bara kopplas till exakt en säljare.",
        EXPLICIT_PROVIDER_USER_REQUIRES_SELLER_SCOPE: "En telefoni-användare kan bara väljas när numret tilldelas en enskild säljare.",
        RINKEL_USER_ALLOCATION_MISSING: "Telefoni-användaren är inte tilldelad det här bolaget.",
        NUMBER_ALLOCATION_MISSING: "Det valda telefonnumret är inaktivt eller inte tilldelat företaget.",
        AUTHENTICATION_REQUIRED: "Du behöver logga in igen innan telefonimappningen kan sparas.",
        RINKEL_MAPPING_MEMBER_NOT_ACTIVE: "Säljaren är inte en aktiv medlem i företaget.",
        RINKEL_MAPPING_PERMISSION_REQUIRED: "Du saknar behörighet att ändra telefonimappningen.",
        RINKEL_MAPPING_TEAM_PERMISSION_REQUIRED: "Teamledaren får bara mappa säljare i team som hen hanterar.",
      };
      return { code: internalCode, message: messages[internalCode] ?? "Telefoniåtgärden kunde inte slutföras.", retryable: false, outcomeUnknown: false };
    }
    if (databaseCode === "42501" || databaseCode === "PGRST301") {
      return { code: "DATABASE_PERMISSION_ERROR", message: "Databasen nekade åtgärden.", retryable: false, outcomeUnknown: false };
    }
    if (["42P01", "42703", "PGRST204"].includes(databaseCode)) {
      return { code: "DATABASE_SCHEMA_MISMATCH", message: "Databasschemat är inte synkroniserat med applikationen.", retryable: false, outcomeUnknown: false };
    }
    if (databaseCode.startsWith("23")) {
      return { code: "DATABASE_CONSTRAINT_ERROR", message: "Databasen stoppade en konfliktande ändring.", retryable: false, outcomeUnknown: false };
    }
    if (databaseCode) {
      return { code: "DATABASE_UNAVAILABLE", message: "Databasåtgärden kunde inte slutföras.", retryable: true, outcomeUnknown: false };
    }
  }
  return provider;
}

async function loadPlatformIntegration(): Promise<PlatformIntegration> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("platform_integrations")
    .select("id,status,capabilities,configuration,last_error_operation")
    .eq("provider", "rinkel")
    .eq("is_canonical", true)
    .is("disabled_at", null)
    .single();
  if (error) throw new Error("RINKEL_PLATFORM_QUERY_FAILED");
  if (!data) throw new Error("RINKEL_PLATFORM_NOT_CONFIGURED");
  return data as PlatformIntegration;
}

async function platformAudit(
  actorId: string,
  action: string,
  entityType: string,
  entityId: string | null,
  metadata: Record<string, unknown>,
  tenantId?: string | null,
) {
  const { error } = await createAdminClient().from("platform_audit_logs").insert({
    actor_user_id: actorId,
    action,
    entity_type: entityType,
    entity_id: entityId,
    tenant_id: tenantId ?? null,
    metadata: toJson(metadata),
  });
  if (error) throw new Error("DATABASE_AUDIT_LOG_FAILED");
}

function rinkelUserProviderPayload(user: RinkelUser) {
  return toJson({
    ...user.raw,
    _kundexa_sync: {
      device_inventory_complete: user.deviceInventoryComplete,
      device_inventory_source: user.deviceInventorySource,
      device_inventory_error: user.deviceInventoryError,
    },
  });
}

async function repairUniqueRinkelDeviceMappings(
  admin: ReturnType<typeof createAdminClient>,
  integrationId: string,
) {
  const [{ data: devices, error: devicesError }, { data: allocations, error: allocationsError }] = await Promise.all([
    admin.from("platform_rinkel_devices")
      .select("id,platform_rinkel_user_id,active")
      .eq("platform_integration_id", integrationId)
      .eq("active", true),
    admin.from("rinkel_user_allocations")
      .select("id,rinkel_user_id")
      .eq("status", "active")
      .is("valid_to", null),
  ]);
  if (devicesError) throw devicesError;
  if (allocationsError) throw allocationsError;

  const activeDevicesByUser = new Map<string, string[]>();
  for (const device of devices ?? []) {
    activeDevicesByUser.set(
      device.platform_rinkel_user_id,
      [...(activeDevicesByUser.get(device.platform_rinkel_user_id) ?? []), device.id],
    );
  }
  const allocationToUser = new Map((allocations ?? []).map((item) => [item.id, item.rinkel_user_id]));
  const allocationIds = [...allocationToUser.keys()];
  if (!allocationIds.length) return 0;

  const { data: mappings, error: mappingsError } = await admin.from("rinkel_user_mappings_v2")
    .select("id,rinkel_user_allocation_id,selected_device_id")
    .eq("active", true)
    .in("rinkel_user_allocation_id", allocationIds);
  if (mappingsError) throw mappingsError;

  const repairGroups = new Map<string, string[]>();
  for (const mapping of mappings ?? []) {
    const userId = allocationToUser.get(mapping.rinkel_user_allocation_id);
    if (!userId) continue;
    const userDevices = activeDevicesByUser.get(userId) ?? [];
    if (userDevices.length !== 1 || mapping.selected_device_id === userDevices[0]) continue;
    repairGroups.set(userDevices[0], [...(repairGroups.get(userDevices[0]) ?? []), mapping.id]);
  }

  let repaired = 0;
  for (const [deviceId, mappingIds] of repairGroups) {
    const { data: updated, error } = await admin.from("rinkel_user_mappings_v2")
      .update({ selected_device_id: deviceId })
      .in("id", mappingIds)
      .eq("active", true)
      .select("id");
    if (error) throw error;
    repaired += updated?.length ?? 0;
  }
  return repaired;
}

export async function testPlatformRinkelConnection() {
  const context = await platformAdminContext();
  const env = serverEnv();
  const admin = createAdminClient();
  const integration = await loadPlatformIntegration();
  const testedAt = new Date().toISOString();
  if (!env.RINKEL_API_KEY) {
    await admin.from("platform_integrations").update({
      status: "not_configured",
      last_connection_test_at: testedAt,
      last_error_code: "RINKEL_PLATFORM_NOT_CONFIGURED",
      last_error_message: "RINKEL_API_KEY saknas i servermiljön.",
      last_error_at: testedAt,
      last_error_operation: "connection_test",
    }).eq("id", integration.id);
    go("/app/platform/telephony", "error", "RINKEL_API_KEY saknas i servermiljön.");
  }
  await admin.from("platform_integrations").update({
    status: "testing",
    last_connection_test_at: testedAt,
  }).eq("id", integration.id);
  let successMessage = "";
  try {
    const { data: persistedCapabilities, error: capabilityReadError } = await admin
      .from("platform_rinkel_capabilities")
      .select("dial_test_succeeded,dial_tested_at,core_webhooks_verified,webhooks,transcription_supported,insights_supported,note_sync_supported")
      .eq("platform_integration_id", integration.id)
      .maybeSingle();
    if (capabilityReadError) throw capabilityReadError;
    const client = createPlatformRinkelClient(crypto.randomUUID());
    const [users, numbers] = await Promise.all([client.listUsersWithDeviceDetails(), client.listNumbers()]);
    let webhookRegistration = false;
    let webhookErrorCode: string | null = null;
    try {
      await client.listWebhooks();
      webhookRegistration = true;
    } catch (error) {
      const safe = safePlatformError(error);
      webhookErrorCode = safe.code;
    }
    const dialConfigured = users.some((user) => user.active && user.devices.some((device) => device.active))
      && numbers.some((number) => number.active);
    const recordingDetected = numbers.some((number) => number.recordingEnabled);
    const previous = integration.capabilities ?? {};
    const capabilities = {
      ...previous,
      api_access: true,
      users_catalog: true,
      numbers_catalog: true,
      dial: false,
      dial_endpoint_reachable: false,
      dial_configured: dialConfigured,
      dial_test_succeeded: Boolean(persistedCapabilities?.dial_test_succeeded ?? previous.dial_test_succeeded),
      webhooks: Boolean(persistedCapabilities?.webhooks),
      webhooks_registration: webhookRegistration,
      core_webhooks_verified: Boolean(persistedCapabilities?.core_webhooks_verified),
      recordings: recordingDetected,
      recording_detected: recordingDetected,
      transcription: false,
      ai_insights: false,
    };
    const clearsConnectionError = !integration.last_error_operation || integration.last_error_operation === "connection_test";
    await admin.from("platform_integrations").update({
      status: "connected",
      last_verified_at: testedAt,
      last_connection_test_at: testedAt,
      capabilities,
      ...(clearsConnectionError ? {
        last_error_code: null,
        last_error_message: null,
        last_error_at: null,
        last_error_operation: null,
      } : {}),
    }).eq("id", integration.id);
    await admin.from("platform_rinkel_capabilities").upsert({
      platform_integration_id: integration.id,
      api_access: true,
      dial: false,
      webhooks: Boolean(persistedCapabilities?.webhooks),
      recordings: recordingDetected,
      transcription: false,
      ai_insights: false,
      users_catalog: true,
      numbers_catalog: true,
      dial_endpoint_reachable: false,
      dial_configured: dialConfigured,
      dial_test_succeeded: Boolean(persistedCapabilities?.dial_test_succeeded ?? previous.dial_test_succeeded),
      dial_tested_at: persistedCapabilities?.dial_tested_at ?? null,
      webhooks_registration: webhookRegistration,
      core_webhooks_verified: Boolean(persistedCapabilities?.core_webhooks_verified),
      recording_detected: recordingDetected,
      transcription_supported: Boolean(persistedCapabilities?.transcription_supported),
      insights_supported: Boolean(persistedCapabilities?.insights_supported),
      note_sync_supported: Boolean(persistedCapabilities?.note_sync_supported),
      detected_at: testedAt,
      details: {
        user_count: users.length,
        device_count: users.reduce((sum, user) => sum + user.devices.length, 0),
        users_with_provider_device: users.filter((user) => user.active && Boolean(user.deviceId)).length,
        users_without_provider_device: users.filter((user) => user.active && !user.deviceId && !user.deviceInventoryError).length,
        device_inventory_errors: users.filter((user) => user.deviceInventoryError).map((user) => ({
          user_id: user.id, error_code: user.deviceInventoryError,
        })),
        number_count: numbers.length,
        webhook_catalog_error_code: webhookErrorCode,
        dial_verification: "not_executed_by_connection_test",
      },
    }, { onConflict: "platform_integration_id" });
    await platformAudit(context.userId, "rinkel.connection_test_succeeded", "platform_integration", integration.id, {
      user_count: users.length,
      device_count: users.reduce((sum, user) => sum + user.devices.length, 0),
      users_with_provider_device: users.filter((user) => user.active && Boolean(user.deviceId)).length,
      users_without_provider_device: users.filter((user) => user.active && !user.deviceId && !user.deviceInventoryError).length,
      number_count: numbers.length,
      webhook_registration_access: webhookRegistration,
      dial_configured: dialConfigured,
      dial_test_executed: false,
    });
    revalidatePath("/app/platform/telephony");
    successMessage = "API och kataloger är verifierade. Ett verkligt testsamtal är fortfarande ej verifierat.";
  } catch (error) {
    const safe = safePlatformError(error);
    const status = safe.code === "RINKEL_AUTHENTICATION_ERROR"
      ? "authentication_failed"
      : safe.code === "RINKEL_PLAN_UNSUPPORTED" ? "plan_unsupported" : "unavailable";
    await admin.from("platform_integrations").update({
      status,
      last_failed_sync_at: testedAt,
      last_connection_test_at: testedAt,
      last_error_code: safe.code,
      last_error_message: safe.message,
      last_error_at: testedAt,
      last_error_operation: "connection_test",
    }).eq("id", integration.id);
    await platformAudit(context.userId, "rinkel.connection_test_failed", "platform_integration", integration.id, {
      error_code: safe.code,
    });
    go("/app/platform/telephony", "error", safe.message);
  }
  go("/app/platform/telephony", "message", successMessage);
}

async function ensureTenantPhoneNumber(number: RinkelNumber) {
  // The central inventory is canonical. Tenant phone_numbers are deliberately
  // not created here; tenants receive historical allocations instead.
  return number;
}

/**
 * Brings every seat Kundexa dials through onto the dial-path policy.
 *
 * Runs as part of the catalog sync so a newly provisioned seat is correct from
 * its first call rather than after someone notices a customer complaining that
 * a mobile rang. Only seats that are actually allocated to a tenant are touched
 * — a Rinkel seat nobody dials through is the account owner's business, not
 * Kundexa's — and only when the stored payload says the policy is not already
 * in effect, so a healthy sync makes no provider writes at all.
 */
async function enforceAllocatedSeatDialPolicies(
  admin: ReturnType<typeof createAdminClient>,
  integrationId: string,
) {
  const { data: allocations, error: allocationsError } = await admin.from("rinkel_user_allocations")
    .select("tenant_id,rinkel_user_id,platform_rinkel_users!inner(id,external_user_id,active,raw_provider_data,platform_integration_id)")
    .eq("status", "active")
    .is("valid_to", null);
  if (allocationsError) throw allocationsError;

  const seats = (allocations ?? [])
    .map((allocation) => {
      const user = Array.isArray(allocation.platform_rinkel_users)
        ? allocation.platform_rinkel_users[0]
        : allocation.platform_rinkel_users;
      return user && user.active && user.platform_integration_id === integrationId
        ? { tenantId: allocation.tenant_id, providerUserRowId: user.id, externalUserId: user.external_user_id, raw: user.raw_provider_data }
        : null;
    })
    .filter((seat): seat is NonNullable<typeof seat> => Boolean(seat));
  if (!seats.length) return { applied: 0, failed: 0 };

  const { data: numberAllocations, error: numberError } = await admin.from("rinkel_number_allocations")
    .select("tenant_id,created_at,platform_rinkel_numbers!inner(external_number_id,active,is_platform_default)")
    .in("tenant_id", [...new Set(seats.map((seat) => seat.tenantId))])
    .eq("status", "active")
    .is("valid_to", null)
    .order("created_at");
  if (numberError) throw numberError;

  const numberByTenant = new Map<string, string>();
  for (const allocation of numberAllocations ?? []) {
    const number = Array.isArray(allocation.platform_rinkel_numbers)
      ? allocation.platform_rinkel_numbers[0]
      : allocation.platform_rinkel_numbers;
    if (!number?.active || numberByTenant.has(allocation.tenant_id)) continue;
    numberByTenant.set(allocation.tenant_id, number.external_number_id);
  }

  let applied = 0;
  let failed = 0;
  for (const seat of seats) {
    const expectedNumberId = numberByTenant.get(seat.tenantId) ?? null;
    const current = rinkelSeatDialPolicy(seat.raw);
    const alreadyCorrect = current.webphoneOnly
      && (!expectedNumberId || current.defaultOutboundNumberId === expectedNumberId);
    if (alreadyCorrect) continue;
    const failure = await applySeatDialPolicy(admin, seat, expectedNumberId);
    if (failure) failed += 1;
    else applied += 1;
  }
  return { applied, failed };
}

export async function syncPlatformRinkelDirectory() {
  const context = await platformAdminContext();
  const admin = createAdminClient();
  const integration = await loadPlatformIntegration();
  const syncedAt = new Date().toISOString();
  let successMessage = "";
  try {
    const client = createPlatformRinkelClient(crypto.randomUUID());
    const [users, numbers] = await Promise.all([client.listUsersWithDeviceDetails(), client.listNumbers()]);
    const [{ data: existingUsers }, { data: existingNumbers }] = await Promise.all([
      admin.from("platform_rinkel_users").select("id,external_user_id,external_device_id").eq("platform_integration_id", integration.id),
      admin.from("platform_rinkel_numbers").select("id,external_number_id").eq("platform_integration_id", integration.id),
    ]);
    let deviceCount = 0;
    for (const user of users) {
      const existingUser = (existingUsers ?? []).find((item) => item.external_user_id === user.id);
      const providerUserWrite = {
        platform_integration_id: integration.id,
        external_user_id: user.id,
        email: user.email,
        display_name: user.fullName,
        active: user.active,
        raw_provider_data: rinkelUserProviderPayload(user),
        last_synced_at: syncedAt,
        // A successful `GET /users/:id` is authoritative for this user's single
        // device, including reporting that it now has none. Only an unreadable
        // detail response preserves the previously synchronized device id.
        ...(user.deviceInventoryError
          ? existingUser?.external_device_id
            ? { external_device_id: existingUser.external_device_id }
            : {}
          : { external_device_id: user.deviceId }),
      };
      const { data: storedUser, error } = await admin.from("platform_rinkel_users").upsert(
        providerUserWrite,
        { onConflict: "platform_integration_id,external_user_id" },
      ).select("id").single();
      if (error) throw error;
      const liveDeviceIds = new Set(user.devices.map((device) => device.id));
      for (const device of user.devices) {
        deviceCount += 1;
        const { error: deviceError } = await admin.from("platform_rinkel_devices").upsert({
          platform_integration_id: integration.id,
          platform_rinkel_user_id: storedUser.id,
          provider_device_id: device.id,
          display_name: device.displayName,
          device_type: device.type,
          provider_status: device.status,
          active: user.active && device.active,
          last_seen_at: syncedAt,
          last_synced_at: syncedAt,
          raw_payload: toJson(device.raw),
        }, { onConflict: "platform_rinkel_user_id,provider_device_id" });
        if (deviceError) throw deviceError;
      }
      const { data: storedDevices, error: storedDevicesError } = await admin.from("platform_rinkel_devices")
        .select("id,provider_device_id").eq("platform_rinkel_user_id", storedUser.id);
      if (storedDevicesError) throw storedDevicesError;
      const staleProviderDeviceIds = staleRinkelDeviceIds(
        user,
        (storedDevices ?? []).map((device) => device.provider_device_id),
      );
      const staleDeviceIds = (storedDevices ?? [])
        .filter((device) => staleProviderDeviceIds.includes(device.provider_device_id))
        .map((device) => device.id);
      if (staleDeviceIds.length) {
        const { error: staleDeviceError } = await admin.from("platform_rinkel_devices").update({
          active: false,
          provider_status: "removed",
          last_synced_at: syncedAt,
        }).in("id", staleDeviceIds);
        if (staleDeviceError) throw staleDeviceError;
      }
    }
    for (const numberValue of numbers) {
      const number = await ensureTenantPhoneNumber(numberValue);
      const { error } = await admin.from("platform_rinkel_numbers").upsert({
        platform_integration_id: integration.id,
        external_number_id: number.id,
        phone_number_e164: number.number,
        display_name: number.label,
        country_code: number.number.startsWith("+46") ? "SE" : null,
        provider_status: number.status,
        active: number.active,
        recording_enabled: number.recordingEnabled,
        raw_provider_data: toJson(number.raw),
        last_synced_at: syncedAt,
      }, { onConflict: "platform_integration_id,external_number_id" });
      if (error) throw error;
    }
    const liveUsers = new Set(users.map((item) => item.id));
    const liveNumbers = new Set(numbers.map((item) => item.id));
    const staleUsers = (existingUsers ?? []).filter((item) => !liveUsers.has(item.external_user_id)).map((item) => item.id);
    const staleNumbers = (existingNumbers ?? []).filter((item) => !liveNumbers.has(item.external_number_id)).map((item) => item.id);
    if (staleUsers.length) {
      const { error: staleUserError } = await admin.from("platform_rinkel_users")
        .update({ active: false, last_synced_at: syncedAt }).in("id", staleUsers);
      if (staleUserError) throw staleUserError;
    }
    if (staleNumbers.length) {
      const { error: staleNumberError } = await admin.from("platform_rinkel_numbers")
        .update({ active: false, provider_status: "removed", last_synced_at: syncedAt }).in("id", staleNumbers);
      if (staleNumberError) throw staleNumberError;
    }
    const { data: synchronizedDevices, error: synchronizedDevicesError } = await admin.from("platform_rinkel_devices")
      .select("id,platform_rinkel_user_id,active")
      .eq("platform_integration_id", integration.id)
      .eq("active", true);
    if (synchronizedDevicesError) throw synchronizedDevicesError;
    const activeUserIds = new Set(users.filter((user) => user.active).map((user) => user.id));
    const storedUserByExternalId = new Map((existingUsers ?? []).map((item) => [item.external_user_id, item.id]));
    const activeStoredUserIds = new Set(
      [...activeUserIds].map((externalId) => storedUserByExternalId.get(externalId)).filter((id): id is string => Boolean(id)),
    );
    // Upserts can create users that were not in existingUsers. Refresh their ids before readiness calculation.
    const { data: currentUsers, error: currentUsersError } = await admin.from("platform_rinkel_users")
      .select("id,external_user_id,active")
      .eq("platform_integration_id", integration.id);
    if (currentUsersError) throw currentUsersError;
    activeStoredUserIds.clear();
    for (const user of currentUsers ?? []) if (user.active && activeUserIds.has(user.external_user_id)) activeStoredUserIds.add(user.id);
    const activeUserCount = users.filter((user) => user.active).length;
    const activeDeviceCount = (synchronizedDevices ?? []).filter((device) => activeStoredUserIds.has(device.platform_rinkel_user_id)).length;
    const activeNumberCount = numbers.filter((number) => number.active).length;
    const repairedMappingCount = await repairUniqueRinkelDeviceMappings(admin, integration.id);
    // Rinkel places every call through a seat's device, so a seat that still
    // rings a personal mobile sends the call via that phone no matter what
    // caller ID Kundexa picks. Correct it here, where the fresh catalog already
    // says which seats exist and which are allocated.
    const dialPolicy = await enforceAllocatedSeatDialPolicies(admin, integration.id);
    const dialConfigured = activeUserCount > 0 && activeDeviceCount > 0 && activeNumberCount > 0;
    const capabilities = {
      ...(integration.capabilities ?? {}),
      api_access: true,
      users_catalog: true,
      numbers_catalog: true,
      dial_configured: dialConfigured,
    };
    const clearsDirectoryError = !integration.last_error_operation || integration.last_error_operation === "directory_sync";
    const { error: integrationUpdateError } = await admin.from("platform_integrations").update({
      status: "connected",
      capabilities,
      last_verified_at: syncedAt,
      last_successful_sync_at: syncedAt,
      ...(clearsDirectoryError ? {
        last_error_code: null,
        last_error_message: null,
        last_error_at: null,
        last_error_operation: null,
      } : {}),
    }).eq("id", integration.id);
    if (integrationUpdateError) throw integrationUpdateError;
    const { error: capabilityError } = await admin.from("platform_rinkel_capabilities").upsert({
      platform_integration_id: integration.id,
      api_access: true,
      users_catalog: true,
      numbers_catalog: true,
      dial_configured: dialConfigured,
      detected_at: syncedAt,
      details: {
        users: users.length,
        active_users: activeUserCount,
        devices: deviceCount,
        active_devices: activeDeviceCount,
        numbers: numbers.length,
        active_numbers: activeNumberCount,
        users_with_provider_device: users.filter((user) => user.active && Boolean(user.deviceId)).length,
        users_without_provider_device: users.filter((user) => user.active && !user.deviceId && !user.deviceInventoryError).length,
        device_inventory_errors: users.filter((user) => user.deviceInventoryError).map((user) => ({
          user_id: user.id, error_code: user.deviceInventoryError,
        })),
        repaired_mappings: repairedMappingCount,
        source: "directory_sync",
      },
    }, { onConflict: "platform_integration_id" });
    if (capabilityError) throw capabilityError;
    await platformAudit(context.userId, "rinkel.directory_synced", "platform_integration", integration.id, {
      users: users.length,
      devices: deviceCount,
      numbers: numbers.length,
      deactivated_users: staleUsers.length,
      deactivated_numbers: staleNumbers.length,
      active_users: activeUserCount,
      active_devices: activeDeviceCount,
      active_numbers: activeNumberCount,
      users_with_provider_device: users.filter((user) => user.active && Boolean(user.deviceId)).length,
      users_without_provider_device: users.filter((user) => user.active && !user.deviceId && !user.deviceInventoryError).length,
      repaired_mappings: repairedMappingCount,
      dial_configured: dialConfigured,
      dial_policy_applied: dialPolicy.applied,
      dial_policy_failed: dialPolicy.failed,
    });
    revalidatePath("/app/platform/telephony");
    revalidatePath("/app/integrations");
    // Rinkel exposes no devices endpoint and reports at most one device per user
    // as the nullable scalar `deviceId`. A user without one has simply not signed
    // in on a Rinkel device yet; say that instead of blaming the payload shape.
    const usersWithoutDevice = users.filter((user) => user.active && !user.deviceId && !user.deviceInventoryError).length;
    const unreadableUsers = users.filter((user) => user.deviceInventoryError).length;
    successMessage = `Katalogen synkroniserades: ${users.length} användare, ${activeDeviceCount} registrerade enheter och ${numbers.length} nummer.${repairedMappingCount ? ` ${repairedMappingCount} befintliga säljarmappningar reparerades automatiskt.` : ""}${usersWithoutDevice ? ` ${usersWithoutDevice} aktiva användare saknar registrerad enhet hos Rinkel; de kan tilldelas men kan ringa först när de loggat in i Rinkels webbtelefon eller app och katalogen synkats igen.` : ""}${unreadableUsers ? ` ${unreadableUsers} användare kunde inte läsas i detalj och deras befintliga enheter bevarades.` : ""}${dialPolicy.applied ? ` ${dialPolicy.applied} telefoniplats${dialPolicy.applied === 1 ? "" : "er"} ställdes om till att ringa i webbtelefonen i stället för på en mobil.` : ""}${dialPolicy.failed ? ` ${dialPolicy.failed} telefoniplats${dialPolicy.failed === 1 ? "" : "er"} kunde inte ställas om; orsaken visas per plats under Integrationer.` : ""}`;
  } catch (error) {
    const safe = safePlatformError(error);
    await admin.from("platform_integrations").update({
      last_failed_sync_at: syncedAt,
      last_error_code: safe.code,
      last_error_message: safe.message,
      last_error_at: syncedAt,
      last_error_operation: "directory_sync",
    }).eq("id", integration.id);
    go("/app/platform/telephony", "error", safe.message);
  }
  go("/app/platform/telephony", "message", successMessage);
}

export async function configurePlatformRinkelWebhooks() {
  const context = await platformAdminContext();
  const env = serverEnv();
  const admin = createAdminClient();
  const integration = await loadPlatformIntegration();
  if (!env.RINKEL_WEBHOOK_SECRET) go("/app/platform/telephony", "error", "RINKEL_WEBHOOK_SECRET saknas i servermiljön.");
  const base = env.RINKEL_WEBHOOK_PUBLIC_BASE_URL.replace(/\/+$/, "");
  const configuredAt = new Date().toISOString();
  const allEvents = [...RINKEL_CORE_WEBHOOK_EVENTS, ...RINKEL_OPTIONAL_WEBHOOK_EVENTS];
  let successMessage = "";
  try {
    const client = createPlatformRinkelClient(crypto.randomUUID());
    const existing = await client.listWebhooks();
    await admin.from("platform_integrations").update({ webhook_status: "registering" }).eq("id", integration.id);
    const optionalFailures: string[] = [];
    let testRequestedCount = 0;
    for (const event of allEvents) {
      const required = RINKEL_CORE_WEBHOOK_EVENTS.includes(event as (typeof RINKEL_CORE_WEBHOOK_EVENTS)[number]);
      const url = `${base}/api/webhooks/rinkel/${env.RINKEL_WEBHOOK_SECRET}/${event}`;
      await admin.from("platform_rinkel_webhook_subscriptions").upsert({
        platform_integration_id: integration.id,
        event_type: event,
        target_url_hash: sha256(url),
        target_url_redacted: `${base}/api/webhooks/rinkel/[REDACTED]/${event}`,
        required,
        status: "registering",
        last_error: null,
        last_error_code: null,
        last_error_message: null,
      }, { onConflict: "platform_integration_id,event_type" });
      try {
        const current = existing.find((item) => item.event === event);
        if (!current) {
          await client.subscribeWebhook(event, { url, contentType: "application/json", active: true, description: "Kundexa central Rinkel webhook" });
        } else if (current.url !== url || !current.active || current.contentType !== "application/json") {
          await client.updateWebhook(event, { url, contentType: "application/json", active: true, description: "Kundexa central Rinkel webhook" });
        }
        const verifiedCatalog = (await client.listWebhooks()).find((item) => item.event === event);
        if (!verifiedCatalog || verifiedCatalog.url !== url || !verifiedCatalog.active || verifiedCatalog.contentType !== "application/json") {
          throw new Error("RINKEL_WEBHOOK_REGISTRATION_MISMATCH");
        }
        await admin.from("platform_rinkel_webhook_subscriptions").update({
          status: "registered",
          provider_active: true,
          registered_at: configuredAt,
          last_verified_at: null,
        }).eq("platform_integration_id", integration.id).eq("event_type", event);
        const testRequestedAt = new Date().toISOString();
        const { error: testPendingError } = await admin.from("platform_rinkel_webhook_subscriptions").update({
          status: "test_pending",
          test_requested_at: testRequestedAt,
          last_error: null,
          last_error_code: null,
          last_error_message: null,
        }).eq("platform_integration_id", integration.id).eq("event_type", event);
        if (testPendingError) throw testPendingError;
        try {
          await client.testWebhook(event, url);
          testRequestedCount += 1;
        } catch (testError) {
          const safe = safePlatformError(testError);
          await admin.from("platform_rinkel_webhook_subscriptions").update({
            status: "registered",
            test_requested_at: null,
            last_error: safe.message,
            last_error_code: safe.code,
            last_error_message: "Webhooken är registrerad men provider-testet kunde inte köras. Verifiering inväntar verklig leverans.",
          }).eq("platform_integration_id", integration.id).eq("event_type", event);
        }
      } catch (eventError) {
        const safe = safePlatformError(eventError);
        if (!required && ["RINKEL_PLAN_UNSUPPORTED", "RINKEL_FORBIDDEN", "RINKEL_NUMBER_NOT_FOUND"].includes(safe.code)) {
          optionalFailures.push(event);
          await admin.from("platform_rinkel_webhook_subscriptions").update({
            status: "unsupported",
            provider_active: false,
            last_error: safe.message,
            last_error_code: safe.code,
            last_error_message: safe.message,
          }).eq("platform_integration_id", integration.id).eq("event_type", event);
          continue;
        }
        throw eventError;
      }
    }
    const { data: verificationRows, error: verificationReadError } = await admin
      .from("platform_rinkel_webhook_subscriptions")
      .select("event_type,status")
      .eq("platform_integration_id", integration.id)
      .in("event_type", [...RINKEL_CORE_WEBHOOK_EVENTS]);
    if (verificationReadError) throw verificationReadError;
    const verifiedCoreCount = (verificationRows ?? []).filter((item) => item.status === "verified").length;
    const coreWebhooksVerified = verifiedCoreCount === RINKEL_CORE_WEBHOOK_EVENTS.length;
    await admin.from("platform_integrations").update({
      webhook_status: coreWebhooksVerified ? "verified" : testRequestedCount > 0 ? "test_pending" : "registered",
      capabilities: {
        ...(integration.capabilities ?? {}),
        webhooks: coreWebhooksVerified,
        webhooks_registration: true,
        core_webhooks_verified: coreWebhooksVerified,
        insights_supported: !optionalFailures.includes("callInsights"),
      },
      ...(!integration.last_error_operation || integration.last_error_operation === "webhook_registration" ? {
        last_error_code: null,
        last_error_message: null,
        last_error_at: null,
        last_error_operation: null,
      } : {}),
    }).eq("id", integration.id);
    await admin.from("platform_rinkel_capabilities").upsert({
      platform_integration_id: integration.id,
      webhooks: coreWebhooksVerified,
      webhooks_registration: true,
      core_webhooks_verified: coreWebhooksVerified,
      insights_supported: !optionalFailures.includes("callInsights"),
      detected_at: configuredAt,
    }, { onConflict: "platform_integration_id" });
    await platformAudit(context.userId, "rinkel.webhooks_configured", "platform_integration", integration.id, {
      core_events: RINKEL_CORE_WEBHOOK_EVENTS,
      optional_events: RINKEL_OPTIONAL_WEBHOOK_EVENTS,
      optional_unsupported: optionalFailures,
      verification_state: testRequestedCount > 0 ? "test_pending" : "registered",
      provider_tests_requested: testRequestedCount,
    });
    revalidatePath("/app/platform/telephony");
    successMessage = testRequestedCount > 0
      ? "Fyra kärnwebhookar är registrerade. De blir verifierade först när Kundexa har mottagit och behandlat testeventen."
      : "Fyra kärnwebhookar är registrerade. Leverantörstestet var inte tillgängligt; verifiering inväntar verklig leverans och workerbehandling.";
  } catch (error) {
    const safe = safePlatformError(error);
    await admin.from("platform_integrations").update({
      webhook_status: "failed",
      status: "degraded",
      last_error_code: safe.code,
      last_error_message: safe.message,
      last_error_at: configuredAt,
      last_error_operation: "webhook_registration",
    }).eq("id", integration.id);
    go("/app/platform/telephony", "error", safe.message);
  }
  go("/app/platform/telephony", "message", successMessage);
}

export async function setPlatformRinkelPaused(form: FormData) {
  const context = await platformAdminContext();
  const paused = value(form, "paused") === "true";
  const integration = await loadPlatformIntegration();
  const admin = createAdminClient();
  const nextStatus = paused
    ? "disabled"
    : serverEnv().RINKEL_API_KEY
      ? "testing"
      : "not_configured";
  const { error } = await admin.from("platform_integrations").update({
    status: nextStatus,
    disabled_at: paused ? new Date().toISOString() : null,
    last_error_code: paused ? "TELEPHONY_DISABLED" : null,
    last_error_message: paused ? "Central telefoni har pausats av plattformsadmin." : null,
    last_error_at: paused ? new Date().toISOString() : null,
    last_error_operation: paused ? "platform_pause" : null,
  }).eq("id", integration.id);
  if (error) go("/app/platform/telephony", "error", "Central telefonistatus kunde inte ändras.");
  await platformAudit(
    context.userId,
    paused ? "rinkel.platform_paused" : "rinkel.platform_resumed",
    "platform_integration",
    integration.id,
    { status: nextStatus },
  );
  revalidatePath("/app/platform/telephony");
  revalidatePath("/app/integrations");
  go("/app/platform/telephony", "message", paused ? "Central telefoni är pausad." : "Central telefoni är återaktiverad och måste verifieras innan status blir ansluten.");
}

export async function allocatePlatformRinkelResource(form: FormData) {
  const context = await platformAdminContext();
  const type = value(form, "resource_type");
  const resourceId = value(form, "resource_id");
  const tenantId = value(form, "tenant_id");
  if (!["user", "number"].includes(type) || !resourceId || !tenantId) {
    go("/app/platform/telephony", "error", "Resurs och tenant måste väljas.");
  }
  const supabase = await createClient();
  const { error } = await supabase.rpc("allocate_platform_rinkel_resource", {
    p_resource_type: type,
    p_resource_id: resourceId,
    p_tenant_id: tenantId,
    p_reason: value(form, "reason") || "Tilldelad i plattformsadministrationen",
  });
  if (error) go("/app/platform/telephony", "error", safePlatformError(error).message);
  await platformAudit(context.userId, "rinkel.resource_allocation_requested", `rinkel_${type}`, resourceId, {}, tenantId);
  revalidatePath("/app/platform/telephony");
  go("/app/platform/telephony", "message", "Resursen är tilldelad.");
}

type AssignmentReport = {
  scope?: unknown;
  target_count?: unknown;
  tenant_count?: unknown;
  telephony_activated_tenant_count?: unknown;
  seller_count?: unknown;
  linked_seller_count?: unknown;
  already_linked_seller_count?: unknown;
  unresolved_seller_count?: unknown;
  unresolved_reasons?: unknown;
  dial_ready_seller_count?: unknown;
  provider_device_missing_count?: unknown;
};

const assignmentBlockerMessages: Record<string, string> = {
  no_provider_user: "saknar en entydig telefoni-användare",
  ambiguous_provider_user: "matchar flera telefoni-användare",
  provider_user_taken: "delar telefoni-användare med en redan mappad säljare",
  no_seller_email: "saknar e-postadress",
};

function count(value: unknown) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function assignmentSummary(report: AssignmentReport) {
  const sellers = count(report.seller_count);
  const ready = count(report.dial_ready_seller_count);
  const linked = count(report.linked_seller_count);
  const unresolved = count(report.unresolved_seller_count);
  const withoutDevice = count(report.provider_device_missing_count);
  const reasons = report.unresolved_reasons && typeof report.unresolved_reasons === "object" && !Array.isArray(report.unresolved_reasons)
    ? Object.entries(report.unresolved_reasons as Record<string, unknown>)
      .map(([reason, total]) => `${count(total)} ${assignmentBlockerMessages[reason] ?? reason}`)
      .join(", ")
    : "";

  return [
    `Telefonnumret är tilldelat och telefoni är aktiverad för ${count(report.tenant_count)} bolag.`,
    sellers ? `${ready}/${sellers} säljare är ringklara${linked ? `, varav ${linked} aktiverades nu` : ""}.` : "Ingen aktiv säljare omfattas ännu av tilldelningen.",
    withoutDevice
      ? `${withoutDevice} säljare väntar på en registrerad enhet hos telefonitjänsten: säljaren måste logga in i telefonitjänstens webbtelefon eller app, därefter kör du "Synkronisera katalog".`
      : "",
    unresolved ? `${unresolved} säljare kunde inte kopplas automatiskt${reasons ? ` (${reasons})` : ""}. Tilldela numret per säljare och välj telefoni-användare manuellt.` : "",
  ].filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------
// Uppringningsvägen
//
// `POST /dial` always originates the call through a provider user's device;
// Rinkel offers no way to place a call from the number alone. So the seat's own
// ring preferences — not anything in Kundexa — decide whether the seller answers
// in the browser or whether a mobile rings instead, and a seat carrying a
// personal mobile rings that phone on every call.
//
// Rinkel does expose the fix: `preferences.muteOtherDevicesOnWebphone`, "call
// only Webphone when available". Kundexa sets it, together with the outbound
// number the tenant actually holds, and confirms both by reading the seat back.
// A 204 only says the body was accepted.
// ---------------------------------------------------------------------------

type DialPathSeat = {
  providerUserRowId: string;
  externalUserId: string;
  displayName: string | null;
  email: string | null;
  sellerUserId: string | null;
  sellerName: string | null;
  appliedAt: string | null;
  error: string | null;
  state: {
    webphoneOnly: boolean;
    ringDevices: string | null;
    defaultOutboundNumberId: string | null;
    seatPhoneE164: string | null;
    outboundNumberMatches: boolean | null;
    correct: boolean;
  };
};

type DialPathReport = {
  expectedNumberId: string | null;
  seats: DialPathSeat[];
  incorrectCount: number;
};

/**
 * Applies the dial-path policy to one seat and records what the provider says
 * afterwards. Returns null on success, or a safe reason.
 *
 * Every failure is written to the seat rather than only returned, because the
 * caller here is a button press: without the stored reason, the next person to
 * look at the page sees an unrepaired seat and no explanation.
 */
async function applySeatDialPolicy(
  admin: ReturnType<typeof createAdminClient>,
  seat: { providerUserRowId: string; externalUserId: string },
  expectedNumberId: string | null,
): Promise<string | null> {
  const client = createPlatformRinkelClient(crypto.randomUUID());
  let confirmed: RinkelUser | null = null;
  let failure: string | null = null;
  try {
    await client.setSeatDialPreferences({
      userId: seat.externalUserId,
      webphoneOnly: true,
      defaultOutboundNumberId: expectedNumberId,
    });
    // Read back. "Rinkel accepted the body" and "the seat now rings the
    // webphone" are different claims, and only the second one is worth storing.
    confirmed = await client.getUser(seat.externalUserId);
    const applied = rinkelSeatDialPolicy(confirmed.raw);
    if (!applied.webphoneOnly) {
      failure = "Telefonitjänsten sparade inte inställningen att bara webbtelefonen ska ringa.";
    } else if (expectedNumberId && applied.defaultOutboundNumberId !== expectedNumberId) {
      failure = "Telefonitjänsten sparade inte företagets utgående nummer på platsen.";
    }
  } catch (error) {
    failure = safePlatformError(error).message;
  }
  const { error: recordError } = await admin.rpc("record_rinkel_seat_dial_policy", {
    p_provider_user_id: seat.providerUserRowId,
    p_raw_provider_data: confirmed ? rinkelUserProviderPayload(confirmed) : null,
    p_error: failure,
  });
  if (recordError) {
    // The provider may well have been changed; saying nothing would leave the
    // page showing a stale "not repaired" with no reason at all.
    return failure ?? "Rättningen gick igenom hos telefonitjänsten men kunde inte sparas i Kundexa.";
  }
  return failure;
}

export async function repairTenantDialPath() {
  await tenantAdminContext();
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("tenant_rinkel_dial_path_report");
  if (error) go("/app/integrations", "error", safePlatformError(error).message);
  const report = (data ?? { expectedNumberId: null, seats: [], incorrectCount: 0 }) as DialPathReport;
  if (!report.seats.length) {
    go("/app/integrations", "error", "Företaget har ingen aktiv telefoniplats att rätta. Mappa säljarna till telefoni först.");
  }
  if (!report.expectedNumberId) {
    go("/app/integrations", "error", "Företaget saknar ett aktivt utgående telefonnummer, så platsen kan inte peka på något nummer.");
  }

  const admin = createAdminClient();
  const failures: string[] = [];
  let repaired = 0;
  for (const seat of report.seats) {
    const failure = await applySeatDialPolicy(admin, seat, report.expectedNumberId);
    if (failure) failures.push(`${seat.sellerName ?? seat.displayName ?? seat.externalUserId}: ${failure}`);
    else repaired += 1;
  }

  revalidatePath("/app/integrations");
  revalidatePath("/app/dialer");
  if (failures.length) {
    go("/app/integrations", "error", `${repaired} av ${report.seats.length} telefoniplatser rättades. ${failures.join(" ")}`);
  }
  go(
    "/app/integrations",
    "message",
    `${repaired} telefoniplats${repaired === 1 ? "" : "er"} ringer nu i webbtelefonen och ringer ut från företagets nummer. Säljaren måste vara inloggad i telefonitjänstens webbtelefon när samtalet startas.`,
  );
}

export async function assignPlatformPhoneNumber(form: FormData) {
  await platformAdminContext();
  const numberId = value(form, "number_id");
  const scope = value(form, "scope");
  const reason = value(form, "reason");
  if (!numberId) go("/app/platform/telephony", "error", "Välj ett telefonnummer.");
  if (!["tenant", "team", "user"].includes(scope)) go("/app/platform/telephony", "error", "Välj vem numret ska tilldelas.");

  const list = (key: string) => [...new Set(form.getAll(key).map((item) => String(item).trim()).filter(Boolean))];
  const teamIds = list("team_ids");
  const userIds = list("user_ids");
  const tenantId = value(form, "tenant_id") || null;
  const rinkelUserId = value(form, "rinkel_user_id") || null;

  if (scope === "tenant" && !tenantId) go("/app/platform/telephony", "error", "Välj ett bolag.");
  if (scope === "team" && !teamIds.length) go("/app/platform/telephony", "error", "Välj minst ett aktivt team.");
  if (scope === "user" && !userIds.length) go("/app/platform/telephony", "error", "Välj minst en säljare.");

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("assign_platform_rinkel_number", {
    p_number_id: numberId,
    p_scope: scope,
    p_tenant_id: scope === "team" ? null : tenantId,
    p_team_ids: scope === "team" ? teamIds : null,
    p_user_ids: scope === "user" ? userIds : null,
    p_rinkel_user_id: scope === "user" && userIds.length === 1 ? rinkelUserId : null,
    p_activate_telephony: form.get("activate_telephony") === "false" ? false : true,
    p_reason: reason || null,
  });
  if (error) go("/app/platform/telephony", "error", safePlatformError(error).message);

  revalidatePath("/app/platform/telephony");
  revalidatePath("/app/integrations");
  revalidatePath("/app/dialer");
  go("/app/platform/telephony", "message", assignmentSummary((data ?? {}) as AssignmentReport));
}

export async function revokePlatformPhoneNumberTeamGrant(form: FormData) {
  await platformAdminContext();
  const grantId = value(form, "grant_id");
  if (!grantId) go("/app/platform/telephony", "error", "Teamets nummeråtkomst saknas.");

  const supabase = await createClient();
  const { error } = await supabase.rpc("revoke_platform_rinkel_number_team_grant", {
    p_grant_id: grantId,
    p_reason: value(form, "reason") || "Borttagen från team i plattformsadministrationen",
  });
  if (error) go("/app/platform/telephony", "error", safePlatformError(error).message);

  revalidatePath("/app/platform/telephony");
  revalidatePath("/app/integrations");
  go("/app/platform/telephony", "message", "Teamets åtkomst till telefonnumret är borttagen.");
}

export async function revokePlatformRinkelResource(form: FormData) {
  await platformAdminContext();
  const type = value(form, "resource_type");
  const allocationId = value(form, "allocation_id");
  const supabase = await createClient();
  const { error } = await supabase.rpc("revoke_platform_rinkel_resource", {
    p_resource_type: type,
    p_allocation_id: allocationId,
    p_reason: value(form, "reason") || "Återkallad i plattformsadministrationen",
  });
  if (error) go("/app/platform/telephony", "error", safePlatformError(error).message);
  revalidatePath("/app/platform/telephony");
  go("/app/platform/telephony", "message", "Tilldelningen är återkallad.");
}

export async function saveRinkelUserMapping(form: FormData) {
  await tenantAdminContext();
  const supabase = await createClient();
  // replace_rinkel_user_mapping_v2 established the transactional contract;
  // v3 keeps that contract and additionally persists the selected device.
  const { error } = await supabase.rpc("replace_rinkel_user_mapping_v3", {
    p_kundexa_user_id: value(form, "kundexa_user_id"),
    p_rinkel_user_allocation_id: value(form, "rinkel_user_allocation_id"),
    p_default_number_allocation_id: value(form, "default_number_allocation_id"),
    p_selected_device_id: value(form, "selected_device_id") || null,
  });
  if (error) go("/app/integrations", "error", safePlatformError(error).message);
  revalidatePath("/app/integrations");
  go("/app/integrations", "message", "Telefonimappningen är sparad.");
}


export async function saveRinkelCallerIdDefault(form: FormData) {
  const context = await tenantAdminContext();
  if (!isAdmin(context.role)) go("/app/integrations", "error", "Endast tenantägare eller tenantadmin får ändra caller-ID-standarder.");
  const scopeTarget = value(form, "scope_target");
  const numberAllocationId = value(form, "number_allocation_id") || null;
  const [scope, scopeId = ""] = scopeTarget.split(":", 2);
  if (!['tenant', 'team', 'list', 'campaign'].includes(scope)) go("/app/integrations", "error", "Ogiltig caller-ID-scope.");
  if (scope !== "tenant" && !scopeId) go("/app/integrations", "error", "Mål för caller-ID saknas.");
  const admin = createAdminClient();
  if (numberAllocationId) {
    const { data: allocation, error: allocationError } = await admin.from("rinkel_number_allocations")
      .select("id,rinkel_number_id")
      .eq("tenant_id", context.tenantId).eq("id", numberAllocationId)
      .eq("status", "active").is("valid_to", null).maybeSingle();
    if (allocationError || !allocation) go("/app/integrations", "error", "Nummerallokeringen är inte aktiv för detta företag.");
    const { data: number } = await admin.from("platform_rinkel_numbers").select("id").eq("id", allocation.rinkel_number_id).eq("active", true).maybeSingle();
    if (!number) go("/app/integrations", "error", "Telefonnumret är inaktivt eller saknas.");
  }
  let mutationError: unknown = null;
  let updatedTarget = true;
  if (scope === "tenant") {
    const result = await admin.from("telephony_policies").upsert({
      tenant_id: context.tenantId,
      default_number_allocation_id: numberAllocationId,
    }, { onConflict: "tenant_id" });
    mutationError = result.error;
  } else if (scope === "team") {
    const result = await admin.from("teams").update({ rinkel_number_allocation_id: numberAllocationId })
      .eq("tenant_id", context.tenantId).eq("id", scopeId).select("id").maybeSingle();
    mutationError = result.error;
    updatedTarget = Boolean(result.data);
  } else if (scope === "list") {
    const result = await admin.from("customer_lists").update({ rinkel_number_allocation_id: numberAllocationId })
      .eq("tenant_id", context.tenantId).eq("id", scopeId).select("id").maybeSingle();
    mutationError = result.error;
    updatedTarget = Boolean(result.data);
  } else {
    const result = await admin.from("campaigns").update({ rinkel_number_allocation_id: numberAllocationId })
      .eq("tenant_id", context.tenantId).eq("id", scopeId).select("id").maybeSingle();
    mutationError = result.error;
    updatedTarget = Boolean(result.data);
  }
  if (mutationError) go("/app/integrations", "error", safePlatformError(mutationError).message);
  if (!updatedTarget) go("/app/integrations", "error", "Det valda målet finns inte i detta företag.");
  const { error: callerAuditError } = await admin.from("audit_logs").insert({
    tenant_id: context.tenantId, actor_user_id: context.userId, action: "telephony.caller_id_default_updated",
    entity_type: `rinkel_caller_id_${scope}`, entity_id: scope === "tenant" ? context.tenantId : scopeId,
    after_data: { scope, number_allocation_id: numberAllocationId },
  });
  if (callerAuditError) go("/app/integrations", "error", "Caller-ID ändrades men auditloggen kunde inte skrivas. Kontakta plattformsadministratör.");
  revalidatePath("/app/integrations");
  go("/app/integrations", "message", numberAllocationId ? "Caller-ID-standarden är sparad." : "Caller-ID-standarden är rensad.");
}

export async function setPlatformDefaultRinkelNumber(form: FormData) {
  const context = await platformAdminContext();
  const numberId = value(form, "number_id");
  if (!numberId) go("/app/platform/telephony", "error", "Telefonnummer saknas.");
  const admin = createAdminClient();
  const { error } = await admin.rpc("set_platform_rinkel_default_number", { p_number_id: numberId });
  if (error) go("/app/platform/telephony", "error", safePlatformError(error).message);
  await platformAudit(context.userId, "rinkel.platform_default_number_updated", "platform_rinkel_number", numberId, {});
  revalidatePath("/app/platform/telephony");
  go("/app/platform/telephony", "message", "Plattformens sista caller-ID-reserv är uppdaterad.");
}

export async function runPlatformRinkelWorker() {
  const context = await platformAdminContext();
  let successMessage = "";
  try {
    const result = await invokeRinkelPlatformWorker("platform_admin");
    await platformAudit(context.userId, "rinkel.worker_run_requested", "platform_worker", "rinkel-platform-worker", result);
    revalidatePath("/app/platform/telephony");
    successMessage = `Workern kördes: ${Number(result.processed ?? 0)} behandlade, ${Number(result.failed ?? 0)} misslyckade, ${Number(result.requeued ?? 0)} återköade.`;
  } catch (error) {
    const safe = safePlatformError(error);
    go("/app/platform/telephony", "error", safe.code === "RINKEL_UNKNOWN_ERROR" ? "Telefoniworkern kunde inte köras." : safe.message);
  }
  go("/app/platform/telephony", "message", successMessage);
}

export async function runPlatformRinkelReconciliation() {
  const context = await platformAdminContext();
  const admin = createAdminClient();
  const bucket = new Date().toISOString().slice(0, 16);
  const { error } = await admin.from("platform_rinkel_jobs").upsert({
    job_type: "rinkel.reconcile_platform",
    aggregate_id: null,
    idempotency_key: `rinkel.reconcile_platform:manual:${bucket}`,
    payload: { source: "platform_admin", requested_by: context.userId },
    status: "pending",
    available_at: new Date().toISOString(),
  }, { onConflict: "idempotency_key", ignoreDuplicates: true });
  if (error) go("/app/platform/telephony", "error", safePlatformError(error).message);
  await platformAudit(context.userId, "rinkel.reconciliation_requested", "platform_worker", "rinkel-platform-worker", { bucket });
  let message = "";
  try {
    const result = await invokeRinkelPlatformWorker("platform_admin_reconciliation");
    message = `CDR-avstämning köades och workern kördes: ${Number(result.processed ?? 0)} jobb behandlade.`;
  } catch {
    message = "CDR-avstämningen köades. Den schemalagda workern behandlar jobbet vid nästa körning.";
  }
  revalidatePath("/app/platform/telephony");
  go("/app/platform/telephony", "message", message);
}

export async function reprocessPlatformRinkelEvent(form: FormData) {
  const context = await platformAdminContext();
  const conflictId = value(form, "conflict_id");
  if (!conflictId) go("/app/platform/telephony", "error", "Konflikt-ID saknas.");
  const admin = createAdminClient();
  const { data: conflict, error: conflictError } = await admin.from("platform_rinkel_conflicts")
    .select("id,event_id,status").eq("id", conflictId).eq("status", "open").maybeSingle();
  if (conflictError) go("/app/platform/telephony", "error", safePlatformError(conflictError).message);
  if (!conflict?.event_id) go("/app/platform/telephony", "error", "Konflikten saknar ett återbehandlingsbart webhookevent.");

  const requestedAt = new Date().toISOString();
  const { error: eventError } = await admin.from("platform_rinkel_webhook_events").update({
    status: "received",
    correlation_status: "pending",
    next_retry_at: requestedAt,
    processed_at: null,
    last_error: null,
  }).eq("id", conflict.event_id);
  if (eventError) go("/app/platform/telephony", "error", safePlatformError(eventError).message);

  const { error: closeConflictError } = await admin.from("platform_rinkel_conflicts").update({
    status: "ignored",
    resolved_by: context.userId,
    resolved_at: requestedAt,
  }).eq("id", conflict.id).eq("status", "open");
  if (closeConflictError) go("/app/platform/telephony", "error", safePlatformError(closeConflictError).message);

  const { error: jobError } = await admin.from("platform_rinkel_jobs").upsert({
    job_type: "rinkel.process_event",
    aggregate_id: conflict.event_id,
    idempotency_key: `rinkel.process_event:manual:${conflict.event_id}:${requestedAt}`,
    payload: { event_id: conflict.event_id, source: "platform_admin", requested_by: context.userId },
    status: "pending",
    available_at: requestedAt,
  }, { onConflict: "idempotency_key", ignoreDuplicates: true });
  if (jobError) go("/app/platform/telephony", "error", safePlatformError(jobError).message);

  await platformAudit(context.userId, "rinkel.webhook_reprocessing_requested", "platform_rinkel_webhook_event", conflict.event_id, {
    conflict_id: conflict.id,
  });
  revalidatePath("/app/platform/telephony");
  go("/app/platform/telephony", "message", "Webhookeventet har återköats för ny korrelation.");
}

export async function requeuePlatformRinkelJob(form: FormData) {
  const context = await platformAdminContext();
  const jobId = value(form, "job_id");
  if (!jobId) go("/app/platform/telephony", "error", "Jobb-ID saknas.");
  const supabase = await createClient();
  const reason = value(form, "reason") || "Manuellt återköat av plattformsadmin";
  const { error } = await supabase.rpc("requeue_platform_rinkel_job", { p_job_id: jobId, p_reason: reason });
  if (error) go("/app/platform/telephony", "error", safePlatformError(error).message);
  await platformAudit(context.userId, "rinkel.job_requeue_requested", "platform_rinkel_job", jobId, { reason });
  revalidatePath("/app/platform/telephony");
  go("/app/platform/telephony", "message", "Jobbet har återköats.");
}

export async function saveTelephonyPolicy(form: FormData) {
  const context = await tenantAdminContext();
  const storageMode = "provider_only";
  const retentionDays = Math.max(1, Math.min(3650, Number(value(form, "recording_retention_days") || 90)));
  const rawRetentionDays = Math.max(1, Math.min(365, Number(value(form, "raw_event_retention_days") || 30)));
  const admin = createAdminClient();
  const integration = await loadPlatformIntegration();
  const { data: capabilities, error: capabilityError } = await admin.from("platform_rinkel_capabilities")
    .select("transcription_supported,insights_supported,note_sync_supported")
    .eq("platform_integration_id", integration.id)
    .maybeSingle();
  if (capabilityError) go("/app/integrations", "error", safePlatformError(capabilityError).message);
  const transcriptionEnabled = Boolean(capabilities?.transcription_supported && form.get("transcription_enabled") === "on");
  const insightsEnabled = Boolean(capabilities?.insights_supported && form.get("ai_analysis_enabled") === "on");
  const noteSyncEnabled = Boolean(capabilities?.note_sync_supported && form.get("sync_notes_to_rinkel") === "on");
  const { error } = await admin.from("telephony_policies").upsert({
    tenant_id: context.tenantId,
    telephony_enabled: form.get("telephony_enabled") === "on",
    manual_dialer_enabled: form.get("manual_dialer_enabled") === "on",
    automatic_dialer_enabled: form.get("automatic_dialer_enabled") === "on",
    recording_enabled: form.get("recording_enabled") === "on",
    recording_storage_mode: storageMode,
    recording_retention_days: retentionDays,
    raw_event_retention_days: rawRetentionDays,
    allow_seller_playback: form.get("allow_seller_playback") === "on",
    allow_team_leader_playback: form.get("allow_team_leader_playback") === "on",
    allow_tenant_admin_playback: form.get("allow_tenant_admin_playback") === "on",
    transcription_enabled: transcriptionEnabled,
    ai_analysis_enabled: insightsEnabled,
    disposition_required: form.get("disposition_required") === "on",
    timezone: value(form, "timezone") || context.tenantTimezone,
    allowed_start_time: value(form, "allowed_start_time") || "09:00",
    allowed_end_time: value(form, "allowed_end_time") || "18:00",
    delete_provider_recording_on_retention: form.get("delete_provider_recording_on_retention") === "on",
    sync_notes_to_rinkel: noteSyncEnabled,
  }, { onConflict: "tenant_id" });
  if (error) go("/app/integrations", "error", safePlatformError(error).message);
  const { error: policyAuditError } = await admin.from("audit_logs").insert({
    tenant_id: context.tenantId,
    actor_user_id: context.userId,
    action: "telephony.policy_updated",
    entity_type: "telephony_policy",
    entity_id: context.tenantId,
    after_data: {
      telephony_enabled: form.get("telephony_enabled") === "on",
      manual_dialer_enabled: form.get("manual_dialer_enabled") === "on",
      automatic_dialer_enabled: form.get("automatic_dialer_enabled") === "on",
      storage_mode: storageMode,
      retention_days: retentionDays,
    },
  });
  if (policyAuditError) go("/app/integrations", "error", "Telefonipolicyn sparades men auditloggen kunde inte skrivas. Kontakta plattformsadministratör.");
  revalidatePath("/app/integrations");
  go("/app/integrations", "message", "Telefonipolicyn är sparad.");
}
