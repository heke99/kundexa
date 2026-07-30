"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getAppContext, isAdmin } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { decryptJson, encryptJson, randomToken, sha256 } from "@/lib/crypto";
import { serverEnv } from "@/lib/env";
import { RinkelClient } from "@/lib/integrations/rinkel/client";
import { RinkelError, safeRinkelError } from "@/lib/integrations/rinkel/errors";
import { RINKEL_WEBHOOK_EVENTS } from "@/lib/integrations/rinkel/schemas";
import type { RinkelNumber } from "@/lib/integrations/rinkel/types";

type RinkelCredentials = { apiKey: string; webhookSecret: string };
type IntegrationRow = {
  id: string;
  tenant_id: string;
  public_id: string;
  credentials_ciphertext: string | null;
  configuration: Record<string, unknown> | null;
  status: string;
};

function value(form: FormData, key: string) {
  return String(form.get(key) ?? "").trim();
}

function messageRedirect(kind: "message" | "error", message: string): never {
  redirect(`/app/integrations?${kind}=${encodeURIComponent(message)}`);
}

async function rinkelAdminContext() {
  const context = await getAppContext();
  if (!isAdmin(context.role)) throw new Error("Adminbehörighet krävs för Rinkel-integrationen.");
  return context;
}

async function loadConnection(tenantId: string): Promise<IntegrationRow> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("tenant_integrations")
    .select("id,tenant_id,public_id,credentials_ciphertext,configuration,status")
    .eq("tenant_id", tenantId)
    .eq("provider_type", "telephony")
    .eq("provider", "rinkel")
    .is("disabled_at", null)
    .limit(1)
    .maybeSingle();
  if (error || !data) throw new Error("Rinkel-integrationen är inte konfigurerad.");
  return data as IntegrationRow;
}

function clientFor(connection: IntegrationRow) {
  if (!connection.credentials_ciphertext) throw new Error("Rinkel API-nyckel saknas.");
  const env = serverEnv();
  const credentials = decryptJson<RinkelCredentials>(connection.credentials_ciphertext, env.KUNDEXA_ENCRYPTION_KEY);
  return {
    credentials,
    client: new RinkelClient({
      apiKey: credentials.apiKey,
      baseUrl: env.RINKEL_API_BASE_URL,
      timeoutMs: env.RINKEL_REQUEST_TIMEOUT_MS,
    }),
  };
}

export async function saveRinkelIntegration(form: FormData) {
  const context = await rinkelAdminContext();
  const env = serverEnv();
  const admin = createAdminClient();
  const apiKey = value(form, "api_key");
  const { data: existing } = await admin.from("tenant_integrations")
    .select("id,credentials_ciphertext,configuration")
    .eq("tenant_id", context.tenantId)
    .eq("provider_type", "telephony")
    .eq("provider", "rinkel")
    .is("disabled_at", null)
    .limit(1)
    .maybeSingle();
  let previous: RinkelCredentials | null = null;
  if (existing?.credentials_ciphertext) {
    try {
      previous = decryptJson<RinkelCredentials>(existing.credentials_ciphertext, env.KUNDEXA_ENCRYPTION_KEY);
    } catch {
      previous = null;
    }
  }
  if (!apiKey && !previous?.apiKey) messageRedirect("error", "Rinkel API-nyckel krävs.");
  const credentials: RinkelCredentials = {
    apiKey: apiKey || previous!.apiKey,
    webhookSecret: previous?.webhookSecret || randomToken(36),
  };
  const payload: Record<string, unknown> = {
    tenant_id: context.tenantId,
    provider_type: "telephony",
    provider: "rinkel",
    name: "Rinkel",
    credentials_ciphertext: encryptJson(credentials, env.KUNDEXA_ENCRYPTION_KEY),
    api_key_last_four: credentials.apiKey.slice(-4),
    webhook_secret_hash: sha256(credentials.webhookSecret + env.KUNDEXA_WEBHOOK_PEPPER),
    status: "pending",
    last_error_code: null,
    last_error_message: null,
    configuration: {
      ...((existing?.configuration ?? {}) as Record<string, unknown>),
      api_version: "v1",
      account_mode: "tenant_owned",
    },
    disabled_at: null,
  };
  if (!existing || apiKey) payload.webhook_status = "not_configured";
  const query = existing
    ? admin.from("tenant_integrations").update(payload).eq("tenant_id", context.tenantId).eq("id", existing.id)
    : admin.from("tenant_integrations").insert({ ...payload, created_by: context.userId });
  const { error } = await query;
  if (error) messageRedirect("error", error.message);
  if (existing && apiKey) {
    const resetAt = new Date().toISOString();
    const resets = await Promise.all([
      admin.from("rinkel_users").update({ active: false, last_synced_at: resetAt })
        .eq("tenant_id", context.tenantId).eq("connection_id", existing.id),
      admin.from("rinkel_numbers").update({ active: false, last_synced_at: resetAt })
        .eq("tenant_id", context.tenantId).eq("connection_id", existing.id),
      admin.from("rinkel_capabilities").update({
        api_access: false,
        dial: false,
        webhooks: false,
        recordings: false,
        transcription: false,
        ai_insights: false,
        detected_at: resetAt,
        details: { reset_reason: "api_key_changed" },
      }).eq("tenant_id", context.tenantId).eq("connection_id", existing.id),
      admin.from("rinkel_webhook_subscriptions").update({
        status: "pending",
        last_verified_at: null,
        last_error: "API-nyckeln har ändrats; konfigurera webhooken igen.",
      }).eq("tenant_id", context.tenantId).eq("connection_id", existing.id),
    ]);
    const resetError = resets.find((result) => result.error)?.error;
    if (resetError) messageRedirect("error", `Rinkel sparades men providerstatus kunde inte nollställas: ${resetError.message}`);
  }
  await admin.from("audit_logs").insert({
    tenant_id: context.tenantId,
    actor_user_id: context.userId,
    action: existing ? "integration.rinkel_updated" : "integration.rinkel_created",
    entity_type: "tenant_integration",
    entity_id: existing?.id ?? context.tenantId,
    after_data: { api_key_changed: Boolean(apiKey), status: "pending" },
  });
  revalidatePath("/app/integrations");
  messageRedirect("message", "Rinkel är sparat krypterat. Testa anslutningen och synkronisera katalogen.");
}

export async function testRinkelConnection() {
  const context = await rinkelAdminContext();
  const admin = createAdminClient();
  const connection = await loadConnection(context.tenantId);
  const testedAt = new Date().toISOString();
  await admin.from("tenant_integrations").update({
    status: "testing",
    last_connection_test_at: testedAt,
    last_error_code: null,
    last_error_message: null,
  }).eq("tenant_id", context.tenantId).eq("id", connection.id);
  try {
    const { client } = clientFor(connection);
    const [users, numbers] = await Promise.all([client.listUsers(), client.listNumbers()]);
    let webhookAccess = true;
    let webhookError: string | null = null;
    try {
      await client.listWebhooks();
    } catch (error) {
      if (error instanceof RinkelError && error.code === "RINKEL_PLAN_UNSUPPORTED") {
        webhookAccess = false;
        webhookError = error.message;
      } else {
        throw error;
      }
    }
    const status = webhookAccess ? "connected" : "degraded";
    await admin.from("tenant_integrations").update({
      status,
      last_verified_at: testedAt,
      last_connection_test_at: testedAt,
      last_error_code: webhookAccess ? null : "RINKEL_PLAN_UNSUPPORTED",
      last_error_message: webhookError,
    }).eq("tenant_id", context.tenantId).eq("id", connection.id);
    await admin.from("rinkel_capabilities").upsert({
      tenant_id: context.tenantId,
      connection_id: connection.id,
      api_access: true,
      dial: true,
      webhooks: webhookAccess,
      recordings: numbers.some((number) => number.recordingEnabled),
      transcription: false,
      ai_insights: false,
      detected_at: testedAt,
      details: {
        user_count: users.length,
        number_count: numbers.length,
        webhook_error: webhookError,
        transcription: "observed_only",
        ai_insights: "observed_only",
      },
    }, { onConflict: "connection_id" });
    await admin.from("audit_logs").insert({
      tenant_id: context.tenantId,
      actor_user_id: context.userId,
      action: "integration.rinkel_test_succeeded",
      entity_type: "tenant_integration",
      entity_id: connection.id,
      after_data: { status, users: users.length, numbers: numbers.length, webhooks: webhookAccess },
    });
    revalidatePath("/app/integrations");
    messageRedirect("message", webhookAccess
      ? "Rinkel-anslutningen fungerar."
      : "Rinkel API och dial fungerar, men kontot saknar webhookstöd. Automatisk dialer ska hållas pausad tills Expert-plan/webhookar är aktiva.");
  } catch (error) {
    const safe = safeRinkelError(error);
    const status = safe.code === "RINKEL_AUTHENTICATION_ERROR"
      ? "authentication_failed"
      : safe.code === "RINKEL_PLAN_UNSUPPORTED"
        ? "plan_unsupported"
        : "unknown_error";
    await admin.from("tenant_integrations").update({
      status,
      last_connection_test_at: testedAt,
      last_failed_sync_at: testedAt,
      last_error_code: safe.code,
      last_error_message: safe.message,
    }).eq("tenant_id", context.tenantId).eq("id", connection.id);
    await admin.from("audit_logs").insert({
      tenant_id: context.tenantId,
      actor_user_id: context.userId,
      action: "integration.rinkel_test_failed",
      entity_type: "tenant_integration",
      entity_id: connection.id,
      after_data: { error_code: safe.code },
    });
    revalidatePath("/app/integrations");
    messageRedirect("error", safe.message);
  }
}

async function ensureCanonicalNumber(
  tenantId: string,
  connectionId: string,
  number: RinkelNumber,
  actorId: string,
) {
  const admin = createAdminClient();
  const env = serverEnv();
  const { data: existing } = await admin.from("phone_numbers")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("number_e164", number.number)
    .maybeSingle();
  if (existing) {
    const { error } = await admin.from("phone_numbers").update({
      integration_id: connectionId,
      provider_number_id: number.id,
      status: number.active ? "active" : "inactive",
      supports_voice: true,
      last_synced_at: new Date().toISOString(),
    }).eq("tenant_id", tenantId).eq("id", existing.id);
    if (error) throw error;
    return existing.id;
  }
  const token = randomToken();
  const { data: created, error } = await admin.from("phone_numbers").insert({
    tenant_id: tenantId,
    integration_id: connectionId,
    provider_number_id: number.id,
    number_e164: number.number,
    country_code: number.number.startsWith("+46") ? "SE" : "INT",
    status: number.active ? "active" : "inactive",
    supports_voice: true,
    supports_sms: false,
    webhook_token_hash: sha256(token + env.KUNDEXA_WEBHOOK_PEPPER),
    webhook_token_ciphertext: encryptJson({ token }, env.KUNDEXA_ENCRYPTION_KEY),
    purpose: "rinkel_voice",
    last_synced_at: new Date().toISOString(),
  }).select("id").single();
  if (error || !created) throw error ?? new Error("rinkel_phone_number_create_failed");
  await admin.from("audit_logs").insert({
    tenant_id: tenantId,
    actor_user_id: actorId,
    action: "rinkel.phone_number_created",
    entity_type: "phone_number",
    entity_id: created.id,
    after_data: { provider_number_id: number.id, suffix: number.number.slice(-4) },
  });
  return created.id;
}

export async function syncRinkelDirectory() {
  const context = await rinkelAdminContext();
  const admin = createAdminClient();
  const connection = await loadConnection(context.tenantId);
  const startedAt = new Date().toISOString();
  try {
    const { client } = clientFor(connection);
    const [users, numbers] = await Promise.all([client.listUsers(), client.listNumbers()]);
    const [
      { data: existingUsers, error: existingUsersError },
      { data: existingNumbers, error: existingNumbersError },
    ] = await Promise.all([
      admin.from("rinkel_users").select("id,external_user_id")
        .eq("tenant_id", context.tenantId).eq("connection_id", connection.id),
      admin.from("rinkel_numbers").select("id,external_number_id")
        .eq("tenant_id", context.tenantId).eq("connection_id", connection.id),
    ]);
    if (existingUsersError || existingNumbersError) throw existingUsersError ?? existingNumbersError;
    const userIds: string[] = [];
    for (const user of users) {
      userIds.push(user.id);
      const { error } = await admin.from("rinkel_users").upsert({
        tenant_id: context.tenantId,
        connection_id: connection.id,
        external_user_id: user.id,
        external_device_id: user.deviceId,
        email: user.email,
        display_name: user.fullName,
        active: user.active,
        raw_provider_data: user.raw,
        last_synced_at: startedAt,
      }, { onConflict: "connection_id,external_user_id" });
      if (error) throw error;
    }
    const numberIds: string[] = [];
    for (const number of numbers) {
      numberIds.push(number.id);
      const phoneNumberId = await ensureCanonicalNumber(context.tenantId, connection.id, number, context.userId);
      const { error } = await admin.from("rinkel_numbers").upsert({
        tenant_id: context.tenantId,
        connection_id: connection.id,
        phone_number_id: phoneNumberId,
        external_number_id: number.id,
        phone_number_e164: number.number,
        display_name: number.label,
        country_code: number.number.startsWith("+46") ? "SE" : null,
        active: number.active,
        recording_enabled: number.recordingEnabled,
        raw_provider_data: number.raw,
        last_synced_at: startedAt,
      }, { onConflict: "connection_id,external_number_id" });
      if (error) throw error;
    }
    const currentUserIds = new Set(userIds);
    const currentNumberIds = new Set(numberIds);
    const staleUserIds = (existingUsers ?? [])
      .filter((item) => !currentUserIds.has(item.external_user_id))
      .map((item) => item.id);
    const staleNumberIds = (existingNumbers ?? [])
      .filter((item) => !currentNumberIds.has(item.external_number_id))
      .map((item) => item.id);
    const [{ data: oldUsers, error: oldUsersError }, { data: oldNumbers, error: oldNumbersError }] = await Promise.all([
      staleUserIds.length
        ? admin.from("rinkel_users").update({ active: false, last_synced_at: startedAt })
          .eq("tenant_id", context.tenantId).eq("connection_id", connection.id).in("id", staleUserIds).select("id")
        : Promise.resolve({ data: [] as { id: string }[], error: null }),
      staleNumberIds.length
        ? admin.from("rinkel_numbers").update({ active: false, last_synced_at: startedAt })
          .eq("tenant_id", context.tenantId).eq("connection_id", connection.id).in("id", staleNumberIds).select("id")
        : Promise.resolve({ data: [] as { id: string }[], error: null }),
    ]);
    if (oldUsersError || oldNumbersError) throw oldUsersError ?? oldNumbersError;
    const deactivatedUsers = oldUsers?.length ?? 0;
    const deactivatedNumbers = oldNumbers?.length ?? 0;
    await admin.from("tenant_integrations").update({
      status: connection.status === "degraded" ? "degraded" : "connected",
      last_successful_sync_at: startedAt,
      last_error_code: null,
      last_error_message: null,
    }).eq("tenant_id", context.tenantId).eq("id", connection.id);
    await admin.from("audit_logs").insert({
      tenant_id: context.tenantId,
      actor_user_id: context.userId,
      action: "integration.rinkel_directory_synced",
      entity_type: "tenant_integration",
      entity_id: connection.id,
      after_data: {
        users: users.length,
        numbers: numbers.length,
        deactivated_users: deactivatedUsers,
        deactivated_numbers: deactivatedNumbers,
      },
    });
    revalidatePath("/app/integrations");
    messageRedirect("message", `Rinkel synkroniserades: ${users.length} användare och ${numbers.length} nummer.`);
  } catch (error) {
    const safe = safeRinkelError(error);
    await admin.from("tenant_integrations").update({
      last_failed_sync_at: startedAt,
      last_error_code: safe.code,
      last_error_message: safe.message,
    }).eq("tenant_id", context.tenantId).eq("id", connection.id);
    messageRedirect("error", safe.message);
  }
}

export async function saveRinkelUserMapping(form: FormData) {
  const context = await getAppContext();
  if (!["owner", "admin", "team_lead"].includes(context.role)) throw new Error("Behörighet saknas.");
  const kundexaUserId = value(form, "kundexa_user_id");
  const rinkelUserId = value(form, "rinkel_user_id");
  const defaultNumberId = value(form, "default_number_id");
  const connection = await loadConnection(context.tenantId);
  const admin = createAdminClient();
  const [{ data: membership }, { data: user }, { data: number }, { data: existingProviderMapping }] = await Promise.all([
    admin.from("tenant_memberships").select("user_id,team_id").eq("tenant_id", context.tenantId).eq("user_id", kundexaUserId).eq("status", "active").maybeSingle(),
    admin.from("rinkel_users").select("id,external_device_id,active").eq("tenant_id", context.tenantId).eq("connection_id", connection.id).eq("id", rinkelUserId).maybeSingle(),
    admin.from("rinkel_numbers").select("id,active").eq("tenant_id", context.tenantId).eq("connection_id", connection.id).eq("id", defaultNumberId).maybeSingle(),
    admin.from("rinkel_user_mappings").select("kundexa_user_id").eq("tenant_id", context.tenantId).eq("connection_id", connection.id).eq("rinkel_user_id", rinkelUserId).eq("active", true).maybeSingle(),
  ]);
  if (!membership || !user?.active || !user.external_device_id || !number?.active) {
    messageRedirect("error", "Välj en aktiv användare med Rinkel-enhet och ett aktivt Rinkel-nummer.");
  }
  if (context.role === "team_lead" && (!membership.team_id || !context.teamIds.includes(membership.team_id))) {
    messageRedirect("error", "Teamledare får bara mappa säljare i sina egna team.");
  }
  if (context.role === "team_lead" && existingProviderMapping && existingProviderMapping.kundexa_user_id !== kundexaUserId) {
    const { data: existingMembership } = await admin.from("tenant_memberships").select("team_id")
      .eq("tenant_id", context.tenantId).eq("user_id", existingProviderMapping.kundexa_user_id).maybeSingle();
    if (!existingMembership?.team_id || !context.teamIds.includes(existingMembership.team_id)) {
      messageRedirect("error", "Rinkel-användaren är redan kopplad utanför dina team.");
    }
  }
  const supabase = await createClient();
  const { error } = await supabase.rpc("replace_rinkel_user_mapping", {
    p_kundexa_user_id: kundexaUserId,
    p_rinkel_user_id: rinkelUserId,
    p_default_number_id: defaultNumberId,
  });
  if (error) messageRedirect("error", error.message);
  revalidatePath("/app/integrations");
  messageRedirect("message", "Säljaren är kopplad till Rinkel.");
}

export async function configureRinkelWebhooks() {
  const context = await rinkelAdminContext();
  const env = serverEnv();
  const admin = createAdminClient();
  const connection = await loadConnection(context.tenantId);
  const { client, credentials } = clientFor(connection);
  const base = (env.RINKEL_WEBHOOK_PUBLIC_BASE_URL ?? env.NEXT_PUBLIC_APP_URL).replace(/\/+$/, "");
  if (!base.startsWith("https://")) messageRedirect("error", "Rinkel-webhookar kräver en publik HTTPS-basadress.");
  try {
    const existing = await client.listWebhooks();
    for (const event of RINKEL_WEBHOOK_EVENTS) {
      const target = `${base}/api/webhooks/rinkel/${connection.public_id}/${credentials.webhookSecret}/${event}`;
      const input = { url: target, contentType: "application/json" as const, active: true, description: `Kundexa ${event}` };
      const current = existing.find((item) => item.event === event);
      if (current) await client.updateWebhook(event, input);
      else await client.subscribeWebhook(event, input);
      await admin.from("rinkel_webhook_subscriptions").upsert({
        tenant_id: context.tenantId,
        connection_id: connection.id,
        event_type: event,
        target_url_hash: sha256(target),
        status: "active",
        last_verified_at: new Date().toISOString(),
        last_error: null,
      }, { onConflict: "connection_id,event_type" });
    }
    await admin.from("tenant_integrations").update({
      webhook_status: "active",
      status: "connected",
    }).eq("tenant_id", context.tenantId).eq("id", connection.id);
    await admin.from("rinkel_capabilities").update({ webhooks: true, detected_at: new Date().toISOString() })
      .eq("tenant_id", context.tenantId).eq("connection_id", connection.id);
    await admin.from("audit_logs").insert({
      tenant_id: context.tenantId,
      actor_user_id: context.userId,
      action: "integration.rinkel_webhooks_configured",
      entity_type: "tenant_integration",
      entity_id: connection.id,
      after_data: { events: RINKEL_WEBHOOK_EVENTS },
    });
    revalidatePath("/app/integrations");
    messageRedirect("message", "Alla fem Rinkel-webhookar är registrerade.");
  } catch (error) {
    const safe = safeRinkelError(error);
    await admin.from("tenant_integrations").update({
      webhook_status: safe.code === "RINKEL_PLAN_UNSUPPORTED" ? "disabled" : "error",
      status: "degraded",
      last_error_code: safe.code,
      last_error_message: safe.message,
    }).eq("tenant_id", context.tenantId).eq("id", connection.id);
    messageRedirect("error", safe.message);
  }
}

export async function saveTelephonyPolicy(form: FormData) {
  const context = await rinkelAdminContext();
  const storageMode = value(form, "recording_storage_mode") === "kundexa_private_copy"
    ? "kundexa_private_copy"
    : "provider_only";
  const retentionDays = Math.max(1, Math.min(3650, Number(value(form, "recording_retention_days") || 90)));
  const rawRetentionDays = Math.max(1, Math.min(365, Number(value(form, "raw_event_retention_days") || 30)));
  const admin = createAdminClient();
  const { error } = await admin.from("telephony_policies").upsert({
    tenant_id: context.tenantId,
    recording_enabled: form.get("recording_enabled") === "on",
    recording_storage_mode: storageMode,
    recording_retention_days: retentionDays,
    raw_event_retention_days: rawRetentionDays,
    allow_seller_playback: form.get("allow_seller_playback") === "on",
    allow_team_leader_playback: form.get("allow_team_leader_playback") === "on",
    allow_tenant_admin_playback: form.get("allow_tenant_admin_playback") === "on",
    transcription_enabled: form.get("transcription_enabled") === "on",
    ai_analysis_enabled: form.get("ai_analysis_enabled") === "on",
    sync_notes_to_rinkel: form.get("sync_notes_to_rinkel") === "on",
    disposition_required: form.get("disposition_required") === "on",
    timezone: value(form, "timezone") || context.tenantTimezone,
    allowed_start_time: value(form, "allowed_start_time") || "09:00",
    allowed_end_time: value(form, "allowed_end_time") || "18:00",
    delete_provider_recording_on_retention: form.get("delete_provider_recording_on_retention") === "on",
  }, { onConflict: "tenant_id" });
  if (error) messageRedirect("error", error.message);
  await admin.from("audit_logs").insert({
    tenant_id: context.tenantId,
    actor_user_id: context.userId,
    action: "telephony.policy_updated",
    entity_type: "telephony_policy",
    entity_id: context.tenantId,
    after_data: { storage_mode: storageMode, retention_days: retentionDays },
  });
  revalidatePath("/app/integrations");
  messageRedirect("message", "Telefonipolicyn är sparad.");
}
