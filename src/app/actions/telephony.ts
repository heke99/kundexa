"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getAppContext, isAdmin } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { serverEnv } from "@/lib/env";
import { encryptJson, randomToken, sha256 } from "@/lib/crypto";
import { NumberProviderError, numberProvider } from "@/lib/telephony/numbers";

const value = (form: FormData, key: string) => String(form.get(key) ?? "").trim();

function go(kind: "message" | "error", message: string, path = "/app/integrations"): never {
  redirect(`${path}?${kind}=${encodeURIComponent(message)}`);
}

/**
 * Var formuläret ska hamna efteråt.
 *
 * Numret kan väljas på fyra ställen, och den som byter nummer för ett team ska
 * hamna tillbaka på teamsidan och inte på Integrationer. Sökvägen kommer från
 * ett dolt fält, alltså från klienten, så den måste prövas: en öppen
 * omdirigering är en riktig sårbarhet och inte en skönhetsfråga. Den prövas mot
 * en form, inte mot en lista, eftersom listsidorna har id i sökvägen.
 */
function safeReturnPath(raw: string) {
  const fallback = "/app/integrations";
  if (!raw) return fallback;
  // Måste börja med en enda snedstreck. `//evil.example` är en protokollrelativ
  // adress och tar användaren ut ur produkten.
  if (!/^\/app\/[a-z0-9\-/]*$/i.test(raw)) return fallback;
  if (raw.startsWith("//")) return fallback;
  return raw;
}

async function adminContext() {
  const context = await getAppContext();
  if (!isAdmin(context.role)) go("error", "Du har inte behörighet att ändra telefoniinställningar.");
  return context;
}

/**
 * Telefonipolicyn: ringtider, vilka dialerlägen som är påslagna, och hur
 * inspelningar hanteras.
 *
 * Den låg tidigare i leverantörens egen actions-fil och grindades mot vad
 * leverantören rapporterade att den klarade. Inget av det hör hemma här --
 * det här är företagets regler för när och hur det ringer, och de gäller
 * oavsett vem som kopplar samtalet.
 */
export async function saveTelephonyPolicy(form: FormData) {
  const context = await adminContext();
  const retentionDays = Math.max(1, Math.min(3650, Number(value(form, "recording_retention_days") || 90)));
  const rawRetentionDays = Math.max(1, Math.min(365, Number(value(form, "raw_event_retention_days") || 30)));

  // Dagarna kommer som en kryssruta per veckodag. Ett tomt val vore ett företag
  // som aldrig får ringa, vilket ingen menar -- så det avvisas i stället för att
  // sparas som en tyst spärr.
  const days = [1, 2, 3, 4, 5, 6, 7].filter((day) => form.get(`allowed_day_${day}`) === "on");
  if (days.length === 0) go("error", "Minst en veckodag måste vara vald för att samtal ska kunna ringas.");

  const start = value(form, "allowed_start_time") || "08:00";
  const end = value(form, "allowed_end_time") || "21:00";
  if (start >= end) go("error", "Ringtidernas sluttid måste vara efter starttiden.");

  const admin = createAdminClient();
  const { error } = await admin.from("telephony_policies").upsert({
    tenant_id: context.tenantId,
    telephony_enabled: form.get("telephony_enabled") === "on",
    manual_dialer_enabled: form.get("manual_dialer_enabled") === "on",
    automatic_dialer_enabled: form.get("automatic_dialer_enabled") === "on",
    recording_enabled: form.get("recording_enabled") === "on",
    recording_retention_days: retentionDays,
    raw_event_retention_days: rawRetentionDays,
    allow_seller_playback: form.get("allow_seller_playback") === "on",
    allow_team_leader_playback: form.get("allow_team_leader_playback") === "on",
    allow_tenant_admin_playback: form.get("allow_tenant_admin_playback") === "on",
    disposition_required: form.get("disposition_required") === "on",
    timezone: value(form, "timezone") || "Europe/Stockholm",
    allowed_days: days,
    allowed_start_time: start,
    allowed_end_time: end,
  }, { onConflict: "tenant_id" });
  if (error) go("error", "Telefonipolicyn kunde inte sparas.");

  const { error: auditError } = await admin.from("audit_logs").insert({
    tenant_id: context.tenantId,
    actor_user_id: context.userId,
    action: "telephony.policy_updated",
    entity_type: "telephony_policy",
    entity_id: context.tenantId,
    after_data: {
      telephony_enabled: form.get("telephony_enabled") === "on",
      allowed_days: days, allowed_start_time: start, allowed_end_time: end,
      retention_days: retentionDays,
    },
  });
  // Ringtiderna avgör när ett företag får ringa kunder. En ändring utan spår är
  // inte en ändring man vill ha kvar.
  if (auditError) go("error", "Telefonipolicyn sparades men ändringen kunde inte loggas. Kontakta plattformsadministratören.");

  revalidatePath("/app/integrations");
  go("message", "Telefonipolicyn är sparad.");
}

/**
 * Vilket av företagets nummer som visas för mottagaren.
 *
 * Kan sättas på företaget, ett team, en lista eller en kampanj. Det mest
 * specifika valet vinner vid uppringning: lista, kampanj, team, företagets
 * förval.
 */
export async function saveCallerIdDefault(form: FormData) {
  const context = await adminContext();
  const back = safeReturnPath(value(form, "return_to"));
  const scope = value(form, "scope");
  const scopeId = value(form, "scope_id") || null;
  const phoneNumberId = value(form, "phone_number_id") || null;

  if (!["tenant", "team", "list", "campaign"].includes(scope)) go("error", "Okänd nivå för utgående nummer.", back);
  if (scope !== "tenant" && !scopeId) go("error", "Valet saknar vilket team, lista eller kampanj det gäller.", back);

  const admin = createAdminClient();

  // Numret måste vara företagets eget, aktivt och bära röst. Utan den
  // kontrollen kan ett val sparas som sedan får varje samtal att avvisas, med
  // ett fel som inte pekar tillbaka hit.
  if (phoneNumberId) {
    const { data: number } = await admin.from("phone_numbers")
      .select("id,status,supports_voice")
      .eq("tenant_id", context.tenantId).eq("id", phoneNumberId).maybeSingle();
    if (!number) go("error", "Numret tillhör inte företaget.", back);
    if (number.status !== "active" || !number.supports_voice) {
      go("error", "Numret är inte aktivt för utgående samtal och kan inte visas för mottagaren.", back);
    }
  }

  // Grenarna står utskrivna i stället för att tabell- och kolumnnamn räknas ut.
  // Ett dynamiskt namn ser kortare ut men tar bort kompilatorns möjlighet att
  // säga ifrån när ett av de fyra ställena ändrar form.
  const { error } = scope === "tenant"
    ? await admin.from("telephony_policies")
      .update({ default_caller_id_phone_number_id: phoneNumberId })
      .eq("tenant_id", context.tenantId)
    : scope === "team"
      ? await admin.from("teams")
        .update({ caller_id_phone_number_id: phoneNumberId })
        .eq("tenant_id", context.tenantId).eq("id", scopeId!)
      : scope === "list"
        ? await admin.from("customer_lists")
          .update({ caller_id_phone_number_id: phoneNumberId })
          .eq("tenant_id", context.tenantId).eq("id", scopeId!)
        : await admin.from("campaigns")
          .update({ caller_id_phone_number_id: phoneNumberId })
          .eq("tenant_id", context.tenantId).eq("id", scopeId!);
  if (error) go("error", "Det utgående numret kunde inte sparas.", back);

  const { error: auditError } = await admin.from("audit_logs").insert({
    tenant_id: context.tenantId,
    actor_user_id: context.userId,
    action: "telephony.caller_id_changed",
    entity_type: scope,
    entity_id: scopeId ?? context.tenantId,
    after_data: { scope, scope_id: scopeId, phone_number_id: phoneNumberId },
  });
  if (auditError) go("error", "Numret sparades men ändringen kunde inte loggas. Kontakta plattformsadministratören.", back);

  revalidatePath(back);
  go("message", phoneNumberId ? "Det utgående numret är sparat." : "Valet av utgående nummer är rensat.", back);
}

/**
 * Hyr ett nummer hos leverantören och lägg det hos företaget.
 *
 * Ett anrop, en faktura. Därför sker hyrningen först och databasraden sedan --
 * omvänd ordning hade lämnat ett nummer i `phone_numbers` som ingen äger om
 * leverantören sa nej.
 *
 * Och om databasen sviker efter att numret hyrts går det inte att ångra:
 * numret är betalt. Det sägs då rakt ut, med numret i klartext, så att en
 * administratör kan lägga in det för hand i stället för att hyra ett till.
 */
export async function rentPhoneNumber(form: FormData) {
  const context = await adminContext();
  const phoneNumber = value(form, "phone_number");
  if (!/^\+[1-9]\d{7,14}$/.test(phoneNumber)) go("error", "Numret har inte ett giltigt E.164-format.");

  const provider = numberProvider();
  if (!provider.isConfigured()) {
    go("error", "Nummerhyra är inte uppsatt. Plattformsadministratören behöver lägga in leverantörens projekt-id och nyckel.");
  }

  // Ett nummer företaget redan har ska inte hyras en gång till.
  const admin = createAdminClient();
  const { data: existing } = await admin.from("phone_numbers")
    .select("id").eq("tenant_id", context.tenantId).eq("number_e164", phoneNumber).maybeSingle();
  if (existing) go("error", "Företaget har redan det numret.");

  let rented;
  try {
    // Fråga innan vi hyr. Ett tidigare försök vars svar tappades kan ha lyckats,
    // och då är numret redan betalt -- att hyra igen vore en andra faktura för
    // samma nummer. Leverantören dokumenterar uttryckligen den här ordningen för
    // debiterbara anrop.
    rented = await provider.findActive(phoneNumber) ?? await provider.rent(phoneNumber);
  } catch (error) {
    if (error instanceof NumberProviderError) go("error", error.message);
    console.error("number_rent_failed", { name: error instanceof Error ? error.name : "unknown" });
    go("error", "Numret kunde inte hyras. Ingen debitering har skett.");
  }

  const env = serverEnv();
  const token = randomToken();
  const { data: integration } = await admin.from("tenant_integrations").select("id")
    .eq("tenant_id", context.tenantId).eq("provider_type", "sms").eq("status", "active").limit(1).maybeSingle();

  const { error } = await admin.from("phone_numbers").insert({
    tenant_id: context.tenantId,
    integration_id: integration?.id,
    number_e164: rented.phoneNumber,
    // Kapabiliteterna kommer från leverantörens svar, inte från en kryssruta.
    // Ett nummer som markeras för röst utan att bära röst ger ett samtal som
    // avvisas med ett fel som inte pekar tillbaka hit.
    supports_voice: rented.capabilities.includes("voice"),
    supports_sms: rented.capabilities.includes("sms"),
    webhook_token_hash: sha256(token + env.KUNDEXA_WEBHOOK_PEPPER),
    webhook_token_ciphertext: encryptJson({ token }, env.KUNDEXA_ENCRYPTION_KEY),
  });
  if (error) {
    console.error("number_rented_but_not_stored", { code: error.code });
    go("error", `Numret ${rented.phoneNumber} hyrdes hos leverantören men kunde inte sparas i Kundexa. Lägg in det för hand under Nummer — hyr inte ett nytt.`);
  }

  const { error: auditError } = await admin.from("audit_logs").insert({
    tenant_id: context.tenantId,
    actor_user_id: context.userId,
    action: "telephony.number_rented",
    entity_type: "phone_number",
    entity_id: rented.phoneNumber,
    after_data: { number_e164: rented.phoneNumber, capabilities: rented.capabilities, provider: provider.id },
  });
  // En hyrning är en kostnad. Den ska gå att härleda till den som tryckte.
  if (auditError) go("error", "Numret hyrdes och sparades, men ändringen kunde inte loggas. Kontakta plattformsadministratören.");

  revalidatePath("/app/integrations");
  redirect(`/app/integrations?webhookToken=${encodeURIComponent(token)}`);
}
