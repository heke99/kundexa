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
import { createPlatformRinkelClient } from "@/lib/integrations/rinkel/client";
import { safeRinkelError } from "@/lib/integrations/rinkel/errors";
import {
  RINKEL_CORE_WEBHOOK_EVENTS,
  RINKEL_OPTIONAL_WEBHOOK_EVENTS,
} from "@/lib/integrations/rinkel/schemas";
import type { RinkelNumber } from "@/lib/integrations/rinkel/types";

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
    const [users, numbers] = await Promise.all([client.listUsers(), client.listNumbers()]);
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
        number_count: numbers.length,
        webhook_catalog_error_code: webhookErrorCode,
        dial_verification: "not_executed_by_connection_test",
      },
    }, { onConflict: "platform_integration_id" });
    await platformAudit(context.userId, "rinkel.connection_test_succeeded", "platform_integration", integration.id, {
      user_count: users.length,
      device_count: users.reduce((sum, user) => sum + user.devices.length, 0),
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

export async function syncPlatformRinkelDirectory() {
  const context = await platformAdminContext();
  const admin = createAdminClient();
  const integration = await loadPlatformIntegration();
  const syncedAt = new Date().toISOString();
  let successMessage = "";
  try {
    const client = createPlatformRinkelClient(crypto.randomUUID());
    const [users, numbers] = await Promise.all([client.listUsers(), client.listNumbers()]);
    const [{ data: existingUsers }, { data: existingNumbers }] = await Promise.all([
      admin.from("platform_rinkel_users").select("id,external_user_id").eq("platform_integration_id", integration.id),
      admin.from("platform_rinkel_numbers").select("id,external_number_id").eq("platform_integration_id", integration.id),
    ]);
    let deviceCount = 0;
    for (const user of users) {
      const { data: storedUser, error } = await admin.from("platform_rinkel_users").upsert({
        platform_integration_id: integration.id,
        external_user_id: user.id,
        external_device_id: user.deviceId,
        email: user.email,
        display_name: user.fullName,
        active: user.active,
        raw_provider_data: toJson(user.raw),
        last_synced_at: syncedAt,
      }, { onConflict: "platform_integration_id,external_user_id" }).select("id").single();
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
      const staleDeviceIds = (storedDevices ?? []).filter((device) => !liveDeviceIds.has(device.provider_device_id)).map((device) => device.id);
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
    const activeUserCount = users.filter((user) => user.active).length;
    const activeDeviceCount = users.reduce(
      (sum, user) => sum + (user.active ? user.devices.filter((device) => device.active).length : 0),
      0,
    );
    const activeNumberCount = numbers.filter((number) => number.active).length;
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
      dial_configured: dialConfigured,
    });
    revalidatePath("/app/platform/telephony");
    revalidatePath("/app/integrations");
    successMessage = `Katalogen synkroniserades: ${users.length} användare, ${deviceCount} enheter och ${numbers.length} nummer.`;
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
        try {
          await client.testWebhook(event);
          testRequestedCount += 1;
          await admin.from("platform_rinkel_webhook_subscriptions").update({
            status: "test_pending",
            test_requested_at: new Date().toISOString(),
          }).eq("platform_integration_id", integration.id).eq("event_type", event);
        } catch (testError) {
          const safe = safePlatformError(testError);
          await admin.from("platform_rinkel_webhook_subscriptions").update({
            status: "registered",
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
    await admin.from("platform_integrations").update({
      webhook_status: testRequestedCount > 0 ? "test_pending" : "registered",
      capabilities: {
        ...(integration.capabilities ?? {}),
        webhooks: false,
        webhooks_registration: true,
        core_webhooks_verified: false,
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
      webhooks: false,
      webhooks_registration: true,
      core_webhooks_verified: false,
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

export async function assignPlatformPhoneNumberToTeams(form: FormData) {
  await platformAdminContext();
  const numberId = value(form, "number_id");
  const teamIds = [...new Set(form.getAll("team_ids").map((item) => String(item).trim()).filter(Boolean))];
  if (!numberId) go("/app/platform/telephony", "error", "Välj ett telefonnummer.");
  if (!teamIds.length) go("/app/platform/telephony", "error", "Välj minst ett aktivt team.");

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("assign_platform_rinkel_number_to_teams", {
    p_number_id: numberId,
    p_team_ids: teamIds,
    p_reason: value(form, "reason") || "Tilldelad till team i plattformsadministrationen",
  });
  if (error) go("/app/platform/telephony", "error", safePlatformError(error).message);

  const result = (data ?? {}) as Record<string, unknown>;
  const members = Number(result.member_count ?? 0);
  const ready = Number(result.ready_member_count ?? 0);
  const autoMapped = Number(result.auto_mapped_member_count ?? 0);
  const unresolved = Math.max(0, members - ready);
  const readiness = members
    ? ` ${ready}/${members} teammedlemmar är ringklara${autoMapped ? `, varav ${autoMapped} mappades automatiskt` : ""}.`
    : " Teamen saknar aktiva medlemmar.";
  const unresolvedMessage = unresolved
    ? ` ${unresolved} medlem behöver en entydig telefoni-användare och aktiv enhet.`
    : "";

  revalidatePath("/app/platform/telephony");
  revalidatePath("/app/integrations");
  revalidatePath("/app/dialer");
  go("/app/platform/telephony", "message", `Telefonnumret är tilldelat till ${teamIds.length} team.${readiness}${unresolvedMessage}`);
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
    p_selected_device_id: value(form, "selected_device_id"),
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
