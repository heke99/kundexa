"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { getPlatformContext, isPlatformAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { provisionUser } from "@/lib/users/provision-user";
import { sendProvisioningNotification } from "@/lib/users/provisioning-notifications";

const value = (form: FormData, key: string) => String(form.get(key) ?? "").trim();
const message = (error: { message?: string } | null | undefined) => encodeURIComponent((error?.message ?? "Åtgärden misslyckades").replaceAll("_", " "));


export async function createPlatformTenantAndInviteOwner(form: FormData) {
  const context = await getPlatformContext();
  if (!isPlatformAdmin(context.platformRole)) redirect("/app/platform?error=Plattformsadmin krävs");
  const parsed = z.object({
    name: z.string().min(2).max(120), legalName: z.string().min(2).max(200), organizationNumber: z.string().max(40),
    ownerFirstName: z.string().min(1).max(100), ownerLastName: z.string().min(1).max(100), ownerEmail: z.email(),
    temporaryPassword: z.string().max(128), temporaryPasswordConfirm: z.string().max(128), timezone: z.string().min(3).max(80), locale: z.string().min(2).max(20),
  }).safeParse({
    name: value(form, "name"), legalName: value(form, "legal_name"), organizationNumber: value(form, "organization_number"),
    ownerFirstName: value(form, "owner_first_name"), ownerLastName: value(form, "owner_last_name"), ownerEmail: value(form, "owner_email").toLowerCase(),
    temporaryPassword: String(form.get("temporary_password") ?? ""), temporaryPasswordConfirm: String(form.get("temporary_password_confirm") ?? ""),
    timezone: value(form, "timezone") || "Europe/Stockholm", locale: value(form, "locale") || "sv-SE",
  });
  if (!parsed.success) redirect("/app/platform?error=Kontrollera tenant- och ägaruppgifterna");
  if (parsed.data.temporaryPassword !== parsed.data.temporaryPasswordConfirm) redirect("/app/platform?error=De tillfälliga lösenorden matchar inte");

  const supabase = await createClient();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const bootstrap = await supabase.rpc("create_or_resume_platform_tenant_owner", {
    p_name: parsed.data.name, p_legal_name: parsed.data.legalName, p_organization_number: parsed.data.organizationNumber || null,
    p_country_code: "SE", p_timezone: parsed.data.timezone, p_locale: parsed.data.locale, p_owner_email: parsed.data.ownerEmail,
    p_expires_at: expiresAt, p_idempotency_key: `platform-owner:${randomUUID()}`,
  });
  if (bootstrap.error || !bootstrap.data || typeof bootstrap.data !== "object" || Array.isArray(bootstrap.data)) redirect(`/app/platform?error=${message(bootstrap.error)}`);
  const tenantId = String((bootstrap.data as { tenant_id?: string }).tenant_id ?? "");
  const invitationId = String((bootstrap.data as { invitation_id?: string }).invitation_id ?? "");
  if (!tenantId || !invitationId) redirect("/app/platform?error=Tenantbasen kunde inte provisioneras komplett");

  let provisioned: Awaited<ReturnType<typeof provisionUser>>;
  try {
    provisioned = await provisionUser({
      email: parsed.data.ownerEmail,
      firstName: parsed.data.ownerFirstName,
      lastName: parsed.data.ownerLastName,
      temporaryPassword: parsed.data.temporaryPassword,
      invitationId,
      provisionedBy: context.userId,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "owner_auth_provisioning_failed";
    await supabase.rpc("fail_tenant_invitation", { p_invitation_id: invitationId, p_reason: reason });
    redirect("/app/platform?error=Tenant skapades men ägaren kunde inte provisioneras. Flödet kan återupptas säkert.");
  }

  const finalized = await supabase.rpc("finalize_tenant_invitation", { p_invitation_id: invitationId, p_invited_user_id: provisioned.user.id });
  if (finalized.error) {
    await supabase.rpc("fail_tenant_invitation", { p_invitation_id: invitationId, p_reason: finalized.error.message });
    redirect(`/app/platform?error=${message(finalized.error)}`);
  }
  const notification = await sendProvisioningNotification({ email: parsed.data.ownerEmail, tenantName: parsed.data.name, created: provisioned.created });
  if (!notification.sent) console.warn("owner_provisioning_notification_not_sent", { tenantId, userId: provisioned.user.id, reason: notification.reason });
  revalidatePath("/app/platform");
  redirect(`/app/platform?message=${encodeURIComponent(provisioned.created ? "Tenant och ägare skapades. Ägaren måste byta det tillfälliga lösenordet vid första inloggningen." : "Tenant skapades och det befintliga Kundexa-kontot lades till som ägare utan lösenordsändring.")}`);
}

export async function allocatePlatformList(form: FormData) {
  const context = await getPlatformContext();
  if (!isPlatformAdmin(context.platformRole)) redirect("/app/platform/lists?error=Plattformsadmin krävs");
  const parsed = z.object({
    platformListId: z.uuid(), tenantId: z.uuid(), name: z.string().min(2).max(120),
    count: z.coerce.number().int().min(1).max(1000000), exclusivity: z.enum(["exclusive", "shared", "time_limited"]),
    city: z.string().max(120), municipality: z.string().max(120), county: z.string().max(120), industry: z.string().max(160),
    postalPrefix: z.string().max(10), minEmployees: z.union([z.coerce.number().int().min(0), z.literal("")]), maxEmployees: z.union([z.coerce.number().int().min(0), z.literal("")]),
  }).safeParse({
    platformListId: value(form, "platform_list_id"), tenantId: value(form, "tenant_id"), name: value(form, "name"),
    count: value(form, "count"), exclusivity: value(form, "exclusivity_mode") || "exclusive",
    city: value(form, "city"), municipality: value(form, "municipality"), county: value(form, "county"), industry: value(form, "industry"),
    postalPrefix: value(form, "postal_prefix"), minEmployees: value(form, "min_employees"), maxEmployees: value(form, "max_employees"),
  });
  if (!parsed.success) redirect("/app/platform/lists?error=Kontrollera tilldelningens uppgifter");
  const filters = Object.fromEntries(Object.entries({
    city: parsed.data.city, municipality: parsed.data.municipality, county: parsed.data.county,
    industry: parsed.data.industry, postal_prefix: parsed.data.postalPrefix,
    min_employees: parsed.data.minEmployees === "" ? "" : String(parsed.data.minEmployees),
    max_employees: parsed.data.maxEmployees === "" ? "" : String(parsed.data.maxEmployees),
  }).filter(([, entry]) => entry !== ""));
  const supabase = await createClient();
  const { error } = await supabase.rpc("allocate_platform_list_to_tenant", {
    p_platform_list_id: parsed.data.platformListId, p_tenant_id: parsed.data.tenantId, p_name: parsed.data.name,
    p_requested_count: parsed.data.count, p_filters: filters, p_exclusivity_mode: parsed.data.exclusivity,
    p_starts_at: null, p_ends_at: null,
  });
  if (error) redirect(`/app/platform/lists?error=${message(error)}`);
  revalidatePath("/app/platform/lists");
  revalidatePath("/app/lists");
  redirect("/app/platform/lists?message=Listan tilldelades tenant och materialiserades till deras CRM");
}

export async function revokePlatformAllocation(form: FormData) {
  const context = await getPlatformContext();
  if (!isPlatformAdmin(context.platformRole)) redirect("/app/platform/lists?error=Plattformsadmin krävs");
  const allocationId = value(form, "allocation_id");
  const reason = value(form, "reason");
  if (!allocationId || reason.length < 5) redirect("/app/platform/lists?error=Ange en tydlig anledning");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("revoke_platform_list_allocation", { p_allocation_id: allocationId, p_reason: reason });
  if (error) redirect(`/app/platform/lists?error=${message(error)}`);
  revalidatePath("/app/platform/lists");
  redirect(`/app/platform/lists?message=${encodeURIComponent(`${Number(data ?? 0)} obearbetade poster återkallades`)}`);
}
