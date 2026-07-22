"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getPlatformContext, isPlatformAdmin } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { serverEnv } from "@/lib/env";

const value = (form: FormData, key: string) => String(form.get(key) ?? "").trim();
const message = (error: { message?: string } | null | undefined) => encodeURIComponent((error?.message ?? "Åtgärden misslyckades").replaceAll("_", " "));

async function findAuthUser(email: string) {
  const admin = createAdminClient();
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const user = data.users.find((candidate) => candidate.email?.toLowerCase() === email.toLowerCase());
    if (user) return user;
    if (data.users.length < 1000) break;
  }
  return null;
}

export async function createPlatformTenantAndInviteOwner(form: FormData) {
  const context = await getPlatformContext();
  if (!isPlatformAdmin(context.platformRole)) redirect("/app/platform?error=Plattformsadmin krävs");
  const parsed = z.object({
    name: z.string().min(2).max(120), legalName: z.string().min(2).max(200),
    organizationNumber: z.string().max(40), ownerEmail: z.email(), timezone: z.string().min(3).max(80),
  }).safeParse({
    name: value(form, "name"), legalName: value(form, "legal_name"), organizationNumber: value(form, "organization_number"),
    ownerEmail: value(form, "owner_email").toLowerCase(), timezone: value(form, "timezone") || "Europe/Stockholm",
  });
  if (!parsed.success) redirect("/app/platform?error=Kontrollera tenant- och ägaruppgifterna");
  const supabase = await createClient();
  const created = await supabase.rpc("create_platform_tenant", {
    p_name: parsed.data.name, p_legal_name: parsed.data.legalName,
    p_organization_number: parsed.data.organizationNumber || null, p_country_code: "SE",
    p_timezone: parsed.data.timezone, p_locale: "sv-SE",
  });
  if (created.error || !created.data) redirect(`/app/platform?error=${message(created.error)}`);
  const tenantId = String(created.data);
  const admin = createAdminClient();
  const team = await admin.from("teams").select("id").eq("tenant_id", tenantId).eq("is_default", true).limit(1).single();
  if (team.error || !team.data) redirect("/app/platform?error=Tenant skapades men standardteamet kunde inte hittas");
  let user = await findAuthUser(parsed.data.ownerEmail);
  if (!user) {
    const invited = await admin.auth.admin.inviteUserByEmail(parsed.data.ownerEmail, {
      redirectTo: `${serverEnv().NEXT_PUBLIC_APP_URL}/auth/callback`,
      data: { invited_tenant_id: tenantId, invited_role: "owner" },
    });
    if (invited.error || !invited.data.user) redirect(`/app/platform?error=${message(invited.error)}`);
    user = invited.data.user;
  }
  const registered = await supabase.rpc("register_tenant_invitation", {
    p_tenant_id: tenantId, p_invited_user_id: user.id, p_email: parsed.data.ownerEmail,
    p_role: "owner", p_team_ids: [team.data.id], p_message: "Du har bjudits in som tenantägare i Kundexa.",
    p_expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  });
  if (registered.error) redirect(`/app/platform?error=${message(registered.error)}`);
  revalidatePath("/app/platform");
  redirect(`/app/platform?message=${encodeURIComponent("Tenant skapades och ägaren bjöds in")}`);
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
