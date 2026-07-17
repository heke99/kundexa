"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { getPlatformContext, isPlatformAdmin, isPlatformOwner } from "@/lib/auth";

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

  const admin = createAdminClient();
  let page = 1;
  let targetUserId: string | null = null;
  while (page <= 20 && !targetUserId) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) redirect(`/app/platform?error=${encodeURIComponent(error.message)}`);
    targetUserId = data.users.find((user) => user.email?.toLowerCase() === parsed.data.email)?.id ?? null;
    if (data.users.length < 1000) break;
    page += 1;
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
