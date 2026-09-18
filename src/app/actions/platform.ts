"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getPlatformContext, isPlatformAdmin, isPlatformOwner } from "@/lib/auth";
import { findAuthUserByEmail } from "@/lib/supabase/auth-admin-users";
import { createAdminClient } from "@/lib/supabase/admin";
import { serverEnv } from "@/lib/env";
import { encryptJson, randomToken, sha256 } from "@/lib/crypto";
import { NumberProviderError, numberProvider } from "@/lib/telephony/numbers";

const value = (form: FormData, key: string) => String(form.get(key) ?? "").trim();

export async function updateTenantPlatformStatus(form: FormData) {
  const context = await getPlatformContext();
  if (!isPlatformAdmin(context.platformRole)) redirect("/app/platform?error=Plattformsadmin krävs");

  const parsed = z.object({
    tenantId: z.uuid(),
    status: z.enum(["trial", "active", "suspended", "cancelled"]),
    reason: z.string().min(5).max(500),
  }).safeParse({
    tenantId: value(form, "tenant_id"),
    status: value(form, "status"),
    reason: value(form, "reason"),
  });
  if (!parsed.success) redirect("/app/platform?error=Status och en tydlig anledning krävs");

  const supabase = await createClient();
  const { error } = await supabase.rpc("set_tenant_platform_status", {
    p_tenant_id: parsed.data.tenantId,
    p_status: parsed.data.status,
    p_reason: parsed.data.reason,
  });
  if (error) redirect(`/app/platform?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/app/platform");
  redirect("/app/platform?message=Tenantstatus uppdaterad och revisionsloggad");
}

export async function updatePlatformMembership(form: FormData) {
  const context = await getPlatformContext();
  if (!isPlatformOwner(context.platformRole)) redirect("/app/platform?error=Endast plattformsägare får ändra plattformsroller");

  const parsed = z.object({
    email: z.email(),
    role: z.enum(["platform_owner", "platform_admin", "platform_support", "platform_auditor"]),
    status: z.enum(["active", "suspended", "removed"]),
    reason: z.string().min(5).max(500),
  }).safeParse({
    email: value(form, "email").toLowerCase(),
    role: value(form, "role"),
    status: value(form, "status"),
    reason: value(form, "reason"),
  });
  if (!parsed.success) redirect("/app/platform?error=E-post, roll, status och anledning måste vara giltiga");

  let targetUserId: string | null = null;
  try {
    targetUserId = (await findAuthUserByEmail(parsed.data.email))?.id ?? null;
  } catch (error) {
    redirect(`/app/platform?error=${encodeURIComponent(error instanceof Error ? error.message : "Auth-katalogen kunde inte läsas")}`);
  }
  if (!targetUserId) redirect("/app/platform?error=Användaren måste registreras i Kundexa innan en plattformsroll kan tilldelas");

  const supabase = await createClient();
  const { error } = await supabase.rpc("set_platform_membership", {
    p_user_id: targetUserId,
    p_role: parsed.data.role,
    p_status: parsed.data.status,
    p_reason: parsed.data.reason,
  });
  if (error) redirect(`/app/platform?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/app/platform");
  redirect("/app/platform?message=Plattformsrollen uppdaterades och revisionsloggades");
}

/**
 * Hyr ett nummer åt ett företag.
 *
 * Ligger på plattformen och inte hos företaget, av ett skäl som inte är
 * behörighetsteori: numren hyrs i Kundexas leverantörskonto och faktureras
 * Kundexa. En företagsadministratör som kunde trycka på knappen skulle alltså
 * skicka en räkning till någon annan, varje månad tills någon säger upp numret.
 *
 * Företaget väljs uttryckligen. Plattformskontexten har ingen tenant, och att
 * gissa "den senast besökta" vore att lägga ett nummer och en månadskostnad på
 * fel företag.
 */
export async function rentPhoneNumberForTenant(form: FormData) {
  const context = await getPlatformContext();
  if (!isPlatformAdmin(context.platformRole)) redirect("/app/platform?error=Plattformsadmin krävs");

  const parsed = z.object({
    tenantId: z.uuid(),
    phoneNumber: z.string().regex(/^\+[1-9]\d{7,14}$/),
  }).safeParse({ tenantId: value(form, "tenant_id"), phoneNumber: value(form, "phone_number") });
  if (!parsed.success) redirect("/app/platform?error=Välj företag och ett nummer i E.164-format");
  const { tenantId, phoneNumber } = parsed.data;

  const fail = (message: string): never => redirect(`/app/platform?error=${encodeURIComponent(message)}`);

  const provider = numberProvider();
  if (!provider.isConfigured()) {
    fail("Nummerhyra är inte uppsatt. Lägg in leverantörens projekt-id och nyckel i miljön först.");
  }

  const admin = createAdminClient();
  const { data: existing } = await admin.from("phone_numbers")
    .select("id,tenant_id").eq("number_e164", phoneNumber).maybeSingle();
  // Numret prövas mot hela plattformen, inte mot ett företag. Två företag som
  // visar samma A-nummer är en nummerkonflikt vi inte kan reda ut i efterhand.
  if (existing) fail("Numret finns redan i Kundexa, hos det här eller ett annat företag.");

  let rented;
  try {
    // Fråga innan vi hyr. Ett tidigare försök vars svar tappades kan ha lyckats,
    // och då är numret redan betalt -- att hyra igen vore en andra faktura för
    // samma nummer. Leverantören dokumenterar uttryckligen den ordningen för
    // debiterbara anrop.
    rented = await provider.findActive(phoneNumber) ?? await provider.rent(phoneNumber);
  } catch (error) {
    if (error instanceof NumberProviderError) fail(error.message);
    console.error("number_rent_failed", { name: error instanceof Error ? error.name : "unknown" });
    fail("Numret kunde inte hyras. Ingen debitering har skett.");
  }

  const env = serverEnv();
  const token = randomToken();
  const { data: integration } = await admin.from("tenant_integrations").select("id")
    .eq("tenant_id", tenantId).eq("provider_type", "sms").eq("status", "active").limit(1).maybeSingle();

  const { error } = await admin.from("phone_numbers").insert({
    tenant_id: tenantId,
    integration_id: integration?.id,
    number_e164: rented!.phoneNumber,
    // Kapabiliteterna kommer från leverantörens svar, inte från en kryssruta.
    // Ett nummer som markeras för röst utan att bära röst ger ett samtal som
    // avvisas med ett fel som inte pekar tillbaka hit.
    supports_voice: rented!.capabilities.includes("voice"),
    supports_sms: rented!.capabilities.includes("sms"),
    webhook_token_hash: sha256(token + env.KUNDEXA_WEBHOOK_PEPPER),
    webhook_token_ciphertext: encryptJson({ token }, env.KUNDEXA_ENCRYPTION_KEY),
  });
  if (error) {
    console.error("number_rented_but_not_stored", { code: error.code });
    fail(`Numret ${rented!.phoneNumber} hyrdes hos leverantören men kunde inte sparas i Kundexa. Lägg in det för hand — hyr inte ett nytt.`);
  }

  const { error: auditError } = await admin.from("audit_logs").insert({
    tenant_id: tenantId,
    actor_user_id: context.userId,
    action: "telephony.number_rented",
    entity_type: "phone_number",
    entity_id: rented!.phoneNumber,
    after_data: { number_e164: rented!.phoneNumber, capabilities: rented!.capabilities, provider: provider.id, rented_by: "platform" },
  });
  // En hyrning är en kostnad. Den ska gå att härleda till den som tryckte.
  if (auditError) fail("Numret hyrdes och sparades, men ändringen kunde inte loggas. Kontrollera revisionsloggen.");

  revalidatePath("/app/platform");
  redirect(`/app/platform?webhookToken=${encodeURIComponent(token)}`);
}
