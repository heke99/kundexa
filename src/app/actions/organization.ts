"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getAppContext } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { serverEnv } from "@/lib/env";

const value = (form: FormData, key: string) => String(form.get(key) ?? "").trim();
const checked = (form: FormData, key: string) => form.get(key) === "on";
const errorText = (error: { message?: string } | null | undefined) => encodeURIComponent((error?.message ?? "Åtgärden misslyckades").replaceAll("_", " "));

async function findAuthUserByEmail(email: string) {
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

export async function createTeam(form: FormData) {
  const context = await getAppContext();
  if (!["owner", "admin", "team_lead"].includes(context.role)) redirect("/app/teams?error=Teambehörighet krävs");
  const parsed = z.object({
    name: z.string().min(2).max(120),
    description: z.string().max(1000),
    department: z.string().max(120),
    office: z.string().max(120),
    code: z.string().max(40),
    maxMembers: z.union([z.coerce.number().int().min(1).max(10000), z.literal("")]),
    defaultDialingMode: z.enum(["manual", "automatic"]),
  }).safeParse({
    name: value(form, "name"), description: value(form, "description"), department: value(form, "department"),
    office: value(form, "office"), code: value(form, "code"), maxMembers: value(form, "max_members"),
    defaultDialingMode: value(form, "default_dialing_mode") || "manual",
  });
  if (!parsed.success) redirect("/app/teams?error=Kontrollera teamets uppgifter");
  const supabase = await createClient();
  const { error } = await supabase.rpc("create_managed_team", {
    p_name: parsed.data.name,
    p_description: parsed.data.description || null,
    p_department: parsed.data.department || null,
    p_office: parsed.data.office || null,
    p_code: parsed.data.code || null,
    p_invite_sellers_enabled: checked(form, "invite_sellers_enabled"),
    p_max_members: parsed.data.maxMembers === "" ? null : parsed.data.maxMembers,
    p_default_dialing_mode: parsed.data.defaultDialingMode,
  });
  if (error) redirect(`/app/teams?error=${errorText(error)}`);
  revalidatePath("/app/teams");
  redirect("/app/teams?message=Teamet skapades och du är teamledare");
}

export async function inviteUser(form: FormData) {
  const context = await getAppContext();
  if (!["owner", "admin", "team_lead"].includes(context.role)) redirect("/app/users?error=Inbjudningsbehörighet krävs");
  const parsed = z.object({
    email: z.email(),
    role: z.enum(["owner", "admin", "team_lead", "sales", "contract_manager", "quality", "backoffice", "finance", "viewer"]),
    teamIds: z.array(z.uuid()).max(50),
    message: z.string().max(1000),
  }).safeParse({
    email: value(form, "email").toLowerCase(), role: value(form, "role") || "sales",
    teamIds: form.getAll("team_ids").map(String).filter(Boolean), message: value(form, "message"),
  });
  if (!parsed.success) redirect("/app/users?error=Kontrollera e-post, roll och team");
  if (context.role === "team_lead" && parsed.data.role !== "sales") redirect("/app/users?error=Teamledare får endast bjuda in säljare");
  if (context.role !== "owner" && parsed.data.role === "owner") redirect("/app/users?error=Endast tenantägaren får bjuda in en annan ägare");
  if (context.role === "team_lead" && !parsed.data.teamIds.length) redirect("/app/users?error=Välj minst ett av dina team");

  const admin = createAdminClient();
  const env = serverEnv();
  let user = await findAuthUserByEmail(parsed.data.email);
  if (!user) {
    const invited = await admin.auth.admin.inviteUserByEmail(parsed.data.email, {
      redirectTo: `${env.NEXT_PUBLIC_APP_URL}/auth/callback`,
      data: { invited_tenant_id: context.tenantId, invited_role: parsed.data.role },
    });
    if (invited.error || !invited.data.user) redirect(`/app/users?error=${errorText(invited.error)}`);
    user = invited.data.user;
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("register_tenant_invitation", {
    p_tenant_id: context.tenantId,
    p_invited_user_id: user.id,
    p_email: parsed.data.email,
    p_role: parsed.data.role,
    p_team_ids: parsed.data.teamIds,
    p_message: parsed.data.message || null,
    p_expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  });
  if (error) redirect(`/app/users?error=${errorText(error)}`);
  revalidatePath("/app/users");
  revalidatePath("/app/teams");
  redirect(`/app/users?message=${encodeURIComponent(user.last_sign_in_at ? "Användaren kopplades till tenant och valda team" : "Inbjudan skickades och teamtilldelningen är förberedd")}`);
}

export async function updateTeam(form: FormData) {
  const context = await getAppContext();
  if (!["owner", "admin", "team_lead"].includes(context.role)) redirect("/app/teams?error=Teambehörighet krävs");
  const parsed = z.object({
    teamId: z.uuid(),
    name: z.string().min(2).max(120),
    description: z.string().max(1000),
    department: z.string().max(120),
    office: z.string().max(120),
    code: z.string().max(40),
    status: z.enum(["active", "paused", "archived"]),
    maxMembers: z.union([z.coerce.number().int().min(1).max(10000), z.literal("")]),
    defaultDialingMode: z.enum(["manual", "automatic"]),
  }).safeParse({
    teamId: value(form, "team_id"), name: value(form, "name"), description: value(form, "description"),
    department: value(form, "department"), office: value(form, "office"), code: value(form, "code"),
    status: value(form, "status") || "active", maxMembers: value(form, "max_members"),
    defaultDialingMode: value(form, "default_dialing_mode") || "manual",
  });
  if (!parsed.success) redirect("/app/teams?error=Kontrollera teamets inställningar");
  const supabase = await createClient();
  const { error } = await supabase.rpc("update_managed_team", {
    p_team_id: parsed.data.teamId,
    p_name: parsed.data.name,
    p_description: parsed.data.description || null,
    p_department: parsed.data.department || null,
    p_office: parsed.data.office || null,
    p_code: parsed.data.code || null,
    p_status: parsed.data.status,
    p_invite_sellers_enabled: checked(form, "invite_sellers_enabled"),
    p_max_members: parsed.data.maxMembers === "" ? null : parsed.data.maxMembers,
    p_default_dialing_mode: parsed.data.defaultDialingMode,
  });
  if (error) redirect(`/app/teams?error=${errorText(error)}`);
  revalidatePath("/app/teams");
  revalidatePath("/app/lists");
  redirect("/app/teams?message=Teamets inställningar uppdaterades");
}

export async function updateTenantMember(form: FormData) {
  const context = await getAppContext();
  if (!["owner", "admin"].includes(context.role)) redirect("/app/users?error=Tenantadmin krävs");
  const parsed = z.object({
    userId: z.uuid(),
    role: z.enum(["owner", "admin", "team_lead", "sales", "contract_manager", "quality", "backoffice", "finance", "viewer"]),
    status: z.enum(["invited", "active", "suspended", "removed"]),
    reassignUserId: z.union([z.uuid(), z.literal("")]),
  }).safeParse({
    userId: value(form, "user_id"), role: value(form, "role"), status: value(form, "status"),
    reassignUserId: value(form, "reassign_user_id"),
  });
  if (!parsed.success) redirect("/app/users?error=Kontrollera medlemsrollen och statusen");
  const supabase = await createClient();
  const { error } = await supabase.rpc("update_tenant_member", {
    p_user_id: parsed.data.userId,
    p_role: parsed.data.role,
    p_status: parsed.data.status,
    p_reassign_user_id: parsed.data.reassignUserId || null,
  });
  if (error) redirect(`/app/users?error=${errorText(error)}`);
  revalidatePath("/app/users");
  revalidatePath("/app/teams");
  revalidatePath("/app/lists");
  redirect("/app/users?message=Medlemmen och öppna arbetsobjekt uppdaterades");
}

export async function setTeamMember(form: FormData) {
  const context = await getAppContext();
  if (!["owner", "admin", "team_lead"].includes(context.role)) redirect("/app/teams?error=Teambehörighet krävs");
  const parsed = z.object({
    teamId: z.uuid(), userId: z.uuid(), teamRole: z.enum(["manager", "member"]),
    dailyLeadLimit: z.union([z.coerce.number().int().min(1).max(10000), z.literal("")]),
  }).safeParse({
    teamId: value(form, "team_id"), userId: value(form, "user_id"), teamRole: value(form, "team_role") || "member",
    dailyLeadLimit: value(form, "daily_lead_limit"),
  });
  if (!parsed.success) redirect("/app/teams?error=Kontrollera teammedlemmen");
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_managed_team_member", {
    p_team_id: parsed.data.teamId,
    p_user_id: parsed.data.userId,
    p_team_role: parsed.data.teamRole,
    p_is_primary: checked(form, "is_primary"),
    p_daily_lead_limit: parsed.data.dailyLeadLimit === "" ? null : parsed.data.dailyLeadLimit,
    p_assignment_paused: checked(form, "assignment_paused"),
  });
  if (error) redirect(`/app/teams?error=${errorText(error)}`);
  revalidatePath("/app/teams");
  redirect("/app/teams?message=Teammedlemmen uppdaterades");
}

export async function removeTeamMember(form: FormData) {
  const context = await getAppContext();
  if (!["owner", "admin", "team_lead"].includes(context.role)) redirect("/app/teams?error=Teambehörighet krävs");
  const teamId = value(form, "team_id");
  const userId = value(form, "user_id");
  const supabase = await createClient();
  const { error } = await supabase.rpc("remove_managed_team_member", { p_team_id: teamId, p_user_id: userId });
  if (error) redirect(`/app/teams?error=${errorText(error)}`);
  revalidatePath("/app/teams");
  redirect("/app/teams?message=Användaren togs bort från teamet");
}

export async function splitListToTeam(form: FormData) {
  const context = await getAppContext();
  if (!["owner", "admin"].includes(context.role)) redirect(`/app/lists/${value(form, "source_list_id")}?error=Tenantadmin krävs`);
  const parsed = z.object({
    sourceListId: z.uuid(), teamId: z.uuid(), name: z.string().min(2).max(120),
    count: z.coerce.number().int().min(1).max(1000000), strategy: z.enum(["shared_queue", "round_robin", "fixed_owner", "manual"]),
  }).safeParse({
    sourceListId: value(form, "source_list_id"), teamId: value(form, "team_id"), name: value(form, "name"),
    count: value(form, "count"), strategy: value(form, "distribution_strategy") || "shared_queue",
  });
  if (!parsed.success) redirect(`/app/lists/${value(form, "source_list_id")}?error=Kontrollera teamfördelningen`);
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("split_customer_list_to_team", {
    p_source_list_id: parsed.data.sourceListId,
    p_team_id: parsed.data.teamId,
    p_name: parsed.data.name,
    p_count: parsed.data.count,
    p_distribution_strategy: parsed.data.strategy,
  });
  if (error || !data) redirect(`/app/lists/${parsed.data.sourceListId}?error=${errorText(error)}`);
  revalidatePath("/app/lists");
  redirect(`/app/lists/${data}?saved=1`);
}

export async function switchTenant(form: FormData) {
  await getAppContext();
  const parsed = z.uuid().safeParse(value(form, "tenant_id"));
  if (!parsed.success) redirect("/app?error=Ogiltig tenant");
  const supabase = await createClient();
  const { error } = await supabase.rpc("switch_active_tenant", { p_tenant_id: parsed.data });
  if (error) redirect(`/app?error=${errorText(error)}`);
  revalidatePath("/app", "layout");
  redirect("/app");
}
