"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getAppContext, isAdmin, isPlatformAdmin } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { sha256 } from "@/lib/crypto";
import { serverEnv } from "@/lib/env";
import { toJson } from "@/lib/supabase/json";
import { createPlatformRinkelClient } from "@/lib/integrations/rinkel/client";
import { safeRinkelError } from "@/lib/integrations/rinkel/errors";
import { RINKEL_WEBHOOK_EVENTS } from "@/lib/integrations/rinkel/schemas";
import type { RinkelNumber } from "@/lib/integrations/rinkel/types";

type PlatformIntegration = {
  id: string;
  status: string;
  capabilities: Record<string, unknown> | null;
  configuration: Record<string, unknown> | null;
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
  const context = await getAppContext();
  if (!isPlatformAdmin(context.platformRole)) throw new Error("Plattformsadmin krävs.");
  return context;
}

async function loadPlatformIntegration(): Promise<PlatformIntegration> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("platform_integrations")
    .select("id,status,capabilities,configuration")
    .eq("provider", "rinkel")
    .is("disabled_at", null)
    .limit(1)
    .maybeSingle();
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
  await createAdminClient().from("platform_audit_logs").insert({
    actor_user_id: actorId,
    action,
    entity_type: entityType,
    entity_id: entityId,
    tenant_id: tenantId ?? null,
    metadata: toJson(metadata),
  });
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
    }).eq("id", integration.id);
    go("/app/platform/telephony", "error", "RINKEL_API_KEY saknas i servermiljön.");
  }
  await admin.from("platform_integrations").update({
    status: "testing",
    last_connection_test_at: testedAt,
    last_error_code: null,
    last_error_message: null,
  }).eq("id", integration.id);
  try {
    const client = createPlatformRinkelClient(crypto.randomUUID());
    const [users, numbers] = await Promise.all([client.listUsers(), client.listNumbers()]);
    let webhookAccess = true;
    try {
      await client.listWebhooks();
    } catch {
      webhookAccess = false;
    }
    const capabilities = {
      api_access: true,
      dial: true,
      webhooks: webhookAccess,
      recordings: numbers.some((number) => number.recordingEnabled),
      transcription: false,
      ai_insights: false,
    };
    await admin.from("platform_integrations").update({
      status: webhookAccess ? "connected" : "degraded",
      last_verified_at: testedAt,
      last_connection_test_at: testedAt,
      capabilities,
      last_error_code: webhookAccess ? null : "RINKEL_PLAN_UNSUPPORTED",
      last_error_message: webhookAccess ? null : "Webhookåtkomst kunde inte verifieras.",
    }).eq("id", integration.id);
    await admin.from("platform_rinkel_capabilities").upsert({
      platform_integration_id: integration.id,
      ...capabilities,
      detected_at: testedAt,
      details: { user_count: users.length, number_count: numbers.length },
    }, { onConflict: "platform_integration_id" });
    await platformAudit(context.userId, "rinkel.connection_test_succeeded", "platform_integration", integration.id, {
      user_count: users.length,
      number_count: numbers.length,
      webhook_access: webhookAccess,
    });
    revalidatePath("/app/platform/telephony");
    go("/app/platform/telephony", "message", "Den centrala Rinkel-anslutningen fungerar.");
  } catch (error) {
    const safe = safeRinkelError(error);
    const status = safe.code === "RINKEL_AUTHENTICATION_ERROR"
      ? "authentication_failed"
      : safe.code === "RINKEL_PLAN_UNSUPPORTED" ? "plan_unsupported" : "unavailable";
    await admin.from("platform_integrations").update({
      status,
      last_failed_sync_at: testedAt,
      last_connection_test_at: testedAt,
      last_error_code: safe.code,
      last_error_message: safe.message,
    }).eq("id", integration.id);
    await platformAudit(context.userId, "rinkel.connection_test_failed", "platform_integration", integration.id, {
      error_code: safe.code,
    });
    go("/app/platform/telephony", "error", safe.message);
  }
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
  try {
    const client = createPlatformRinkelClient(crypto.randomUUID());
    const [users, numbers] = await Promise.all([client.listUsers(), client.listNumbers()]);
    const [{ data: existingUsers }, { data: existingNumbers }] = await Promise.all([
      admin.from("platform_rinkel_users").select("id,external_user_id").eq("platform_integration_id", integration.id),
      admin.from("platform_rinkel_numbers").select("id,external_number_id").eq("platform_integration_id", integration.id),
    ]);
    for (const user of users) {
      const { error } = await admin.from("platform_rinkel_users").upsert({
        platform_integration_id: integration.id,
        external_user_id: user.id,
        external_device_id: user.deviceId,
        email: user.email,
        display_name: user.fullName,
        active: user.active,
        raw_provider_data: toJson(user.raw),
        last_synced_at: syncedAt,
      }, { onConflict: "platform_integration_id,external_user_id" });
      if (error) throw error;
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
    if (staleUsers.length) await admin.from("platform_rinkel_users").update({ active: false, last_synced_at: syncedAt }).in("id", staleUsers);
    if (staleNumbers.length) await admin.from("platform_rinkel_numbers").update({ active: false, provider_status: "removed", last_synced_at: syncedAt }).in("id", staleNumbers);
    await admin.from("platform_integrations").update({
      status: integration.status === "degraded" ? "degraded" : "connected",
      last_successful_sync_at: syncedAt,
      last_error_code: null,
      last_error_message: null,
    }).eq("id", integration.id);
    await platformAudit(context.userId, "rinkel.directory_synced", "platform_integration", integration.id, {
      users: users.length,
      numbers: numbers.length,
      deactivated_users: staleUsers.length,
      deactivated_numbers: staleNumbers.length,
    });
    revalidatePath("/app/platform/telephony");
    go("/app/platform/telephony", "message", `Katalogen synkroniserades: ${users.length} användare och ${numbers.length} nummer.`);
  } catch (error) {
    const safe = safeRinkelError(error);
    await admin.from("platform_integrations").update({
      last_failed_sync_at: syncedAt,
      last_error_code: safe.code,
      last_error_message: safe.message,
    }).eq("id", integration.id);
    go("/app/platform/telephony", "error", safe.message);
  }
}

export async function configurePlatformRinkelWebhooks() {
  const context = await platformAdminContext();
  const env = serverEnv();
  const admin = createAdminClient();
  const integration = await loadPlatformIntegration();
  if (!env.RINKEL_WEBHOOK_SECRET) {
    go("/app/platform/telephony", "error", "RINKEL_WEBHOOK_SECRET saknas i servermiljön.");
  }
  const base = env.RINKEL_WEBHOOK_PUBLIC_BASE_URL.replace(/\/+$/, "");
  const verifiedAt = new Date().toISOString();
  try {
    const client = createPlatformRinkelClient(crypto.randomUUID());
    const existing = await client.listWebhooks();
    for (const event of RINKEL_WEBHOOK_EVENTS) {
      const url = `${base}/api/webhooks/rinkel/${env.RINKEL_WEBHOOK_SECRET}/${event}`;
      const current = existing.find((item) => item.event === event);
      if (!current) {
        await client.subscribeWebhook(event, {
          url,
          contentType: "application/json",
          active: true,
          description: "Kundexa central Rinkel webhook",
        });
      } else if (current.url !== url || !current.active || current.contentType !== "application/json") {
        await client.updateWebhook(event, {
          url,
          contentType: "application/json",
          active: true,
          description: "Kundexa central Rinkel webhook",
        });
      }
      await admin.from("platform_rinkel_webhook_subscriptions").upsert({
        platform_integration_id: integration.id,
        event_type: event,
        target_url_hash: sha256(url),
        status: "active",
        last_verified_at: verifiedAt,
        last_error: null,
      }, { onConflict: "platform_integration_id,event_type" });
    }
    await admin.from("platform_integrations").update({
      webhook_status: "active",
      last_verified_at: verifiedAt,
      capabilities: { ...(integration.capabilities ?? {}), webhooks: true },
    }).eq("id", integration.id);
    await platformAudit(context.userId, "rinkel.webhooks_configured", "platform_integration", integration.id, {
      events: RINKEL_WEBHOOK_EVENTS,
    });
    revalidatePath("/app/platform/telephony");
    go("/app/platform/telephony", "message", "Alla fem centrala Rinkel-webhookar är registrerade.");
  } catch (error) {
    const safe = safeRinkelError(error);
    await admin.from("platform_integrations").update({
      webhook_status: safe.code === "RINKEL_PLAN_UNSUPPORTED" ? "disabled" : "error",
      status: "degraded",
      last_error_code: safe.code,
      last_error_message: safe.message,
    }).eq("id", integration.id);
    go("/app/platform/telephony", "error", safe.message);
  }
}

export async function setPlatformRinkelPaused(form: FormData) {
  const context = await platformAdminContext();
  const paused = value(form, "paused") === "true";
  const integration = await loadPlatformIntegration();
  const admin = createAdminClient();
  const nextStatus = paused
    ? "disabled"
    : serverEnv().RINKEL_API_KEY
      ? "connected"
      : "not_configured";
  const { error } = await admin.from("platform_integrations").update({
    status: nextStatus,
    last_error_code: paused ? "TELEPHONY_DISABLED" : null,
    last_error_message: paused ? "Central telefoni har pausats av plattformsadmin." : null,
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
  go("/app/platform/telephony", "message", paused ? "Central telefoni är pausad." : "Central telefoni är återaktiverad.");
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
  if (error) go("/app/platform/telephony", "error", error.message);
  await platformAudit(context.userId, "rinkel.resource_allocation_requested", `rinkel_${type}`, resourceId, {}, tenantId);
  revalidatePath("/app/platform/telephony");
  go("/app/platform/telephony", "message", "Rinkel-resursen är tilldelad.");
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
  if (error) go("/app/platform/telephony", "error", error.message);
  revalidatePath("/app/platform/telephony");
  go("/app/platform/telephony", "message", "Tilldelningen är återkallad.");
}

export async function saveRinkelUserMapping(form: FormData) {
  await tenantAdminContext();
  const supabase = await createClient();
  const { error } = await supabase.rpc("replace_rinkel_user_mapping_v2", {
    p_kundexa_user_id: value(form, "kundexa_user_id"),
    p_rinkel_user_allocation_id: value(form, "rinkel_user_allocation_id"),
    p_default_number_allocation_id: value(form, "default_number_allocation_id"),
  });
  if (error) go("/app/integrations", "error", error.message);
  revalidatePath("/app/integrations");
  go("/app/integrations", "message", "Telefonimappningen är sparad.");
}

export async function saveTelephonyPolicy(form: FormData) {
  const context = await tenantAdminContext();
  const storageMode = value(form, "recording_storage_mode") === "kundexa_private_copy"
    ? "kundexa_private_copy"
    : "provider_only";
  const retentionDays = Math.max(1, Math.min(3650, Number(value(form, "recording_retention_days") || 90)));
  const rawRetentionDays = Math.max(1, Math.min(365, Number(value(form, "raw_event_retention_days") || 30)));
  const admin = createAdminClient();
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
    transcription_enabled: form.get("transcription_enabled") === "on",
    ai_analysis_enabled: form.get("ai_analysis_enabled") === "on",
    disposition_required: form.get("disposition_required") === "on",
    timezone: value(form, "timezone") || context.tenantTimezone,
    allowed_start_time: value(form, "allowed_start_time") || "09:00",
    allowed_end_time: value(form, "allowed_end_time") || "18:00",
    delete_provider_recording_on_retention: form.get("delete_provider_recording_on_retention") === "on",
  }, { onConflict: "tenant_id" });
  if (error) go("/app/integrations", "error", error.message);
  await admin.from("audit_logs").insert({
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
  revalidatePath("/app/integrations");
  go("/app/integrations", "message", "Telefonipolicyn är sparad.");
}
