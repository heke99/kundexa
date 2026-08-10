"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { getAppContext } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { provisionUser } from "@/lib/users/provision-user";
import { sendProvisioningNotification } from "@/lib/users/provisioning-notifications";

const value = (form: FormData, key: string) => String(form.get(key) ?? "").trim();
const checked = (form: FormData, key: string) => form.get(key) === "on";
const errorText = (error: { message?: string } | null | undefined) => encodeURIComponent((error?.message ?? "Åtgärden misslyckades").replaceAll("_", " "));


export async function createTeam(form: FormData) {
  const context = await getAppContext();
  if (!["owner", "admin", "team_lead"].includes(context.role)) redirect("/app/teams?error=Teambehörighet krävs");
  const parsed = z.object({
    name: z.string().min(2).max(120), description: z.string().max(1000), department: z.string().max(120),
    office: z.string().max(120), code: z.string().max(40), managerUserId: z.union([z.uuid(), z.literal("")]),
    maxMembers: z.union([z.coerce.number().int().min(1).max(10000), z.literal("")]),
    defaultDialingMode: z.enum(["manual", "automatic"]),
  }).safeParse({
    name: value(form, "name"), description: value(form, "description"), department: value(form, "department"), office: value(form, "office"),
    code: value(form, "code"), managerUserId: value(form, "manager_user_id"), maxMembers: value(form, "max_members"),
    defaultDialingMode: value(form, "default_dialing_mode") || "manual",
  });
  if (!parsed.success) redirect("/app/teams?error=Kontrollera teamets uppgifter");
  const supabase = await createClient();
  const { error } = await supabase.rpc("create_managed_team_v2", {
    p_name: parsed.data.name,
    p_description: parsed.data.description || null,
    p_department: parsed.data.department || null,
    p_office: parsed.data.office || null,
    p_code: parsed.data.code || null,
    p_invite_sellers_enabled: checked(form, "invite_sellers_enabled"),
    p_max_members: parsed.data.maxMembers === "" ? null : parsed.data.maxMembers,
    p_default_dialing_mode: parsed.data.defaultDialingMode,
    p_manager_user_id: context.role === "team_lead" ? context.userId : parsed.data.managerUserId || null,
  });
  if (error) redirect(`/app/teams?error=${errorText(error)}`);
  revalidatePath("/app/teams");
  redirect("/app/teams?message=Teamet skapades med vald teamledare");
}

export async function createUser(form: FormData) {
  const context = await getAppContext();
  if (!["owner", "admin", "team_lead"].includes(context.role)) redirect("/app/users?error=Användarbehörighet krävs");
  const parsed = z.object({
    firstName: z.string().min(1).max(100), lastName: z.string().min(1).max(100), email: z.email(),
    role: z.enum(["owner", "admin", "team_lead", "sales", "contract_manager", "quality", "backoffice", "finance", "viewer"]),
    primaryTeamId: z.union([z.uuid(), z.literal("")]), temporaryPassword: z.string().max(128), temporaryPasswordConfirm: z.string().max(128),
    message: z.string().max(1000),
  }).safeParse({
    firstName: value(form, "first_name"), lastName: value(form, "last_name"), email: value(form, "email").toLowerCase(),
    role: value(form, "role") || "sales", primaryTeamId: value(form, "primary_team_id"),
    temporaryPassword: String(form.get("temporary_password") ?? ""), temporaryPasswordConfirm: String(form.get("temporary_password_confirm") ?? ""),
    message: value(form, "message"),
  });
  if (!parsed.success) redirect("/app/users?error=Kontrollera namn, e-post, roll, team och lösenord");
  if (parsed.data.temporaryPassword !== parsed.data.temporaryPasswordConfirm) redirect("/app/users?error=De tillfälliga lösenorden matchar inte");
  if (context.role === "team_lead" && parsed.data.role !== "sales") redirect("/app/users?error=Teamledare får endast skapa säljare");
  if (context.role !== "owner" && parsed.data.role === "owner") redirect("/app/users?error=Endast tenantägaren får skapa en annan ägare");
  if (["sales", "team_lead"].includes(parsed.data.role) && !parsed.data.primaryTeamId) redirect("/app/users?error=Välj användarens primära team");
  if (context.role === "team_lead" && !parsed.data.primaryTeamId) redirect("/app/users?error=Välj ett av dina team");

  const supabase = await createClient();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const teamIds = parsed.data.primaryTeamId ? [parsed.data.primaryTeamId] : [];
  const reservation = await supabase.rpc("reserve_tenant_invitation_v2", {
    p_tenant_id: context.tenantId,
    p_email: parsed.data.email,
    p_role: parsed.data.role,
    p_team_ids: teamIds,
    p_primary_team_id: parsed.data.primaryTeamId || null,
    p_message: parsed.data.message || null,
    p_expires_at: expiresAt,
    p_idempotency_key: `create-user:${randomUUID()}`,
  });
  if (reservation.error || !reservation.data) redirect(`/app/users?error=${errorText(reservation.error)}`);
  const invitationId = String(reservation.data);

  let provisioned: Awaited<ReturnType<typeof provisionUser>>;
  try {
    provisioned = await provisionUser({
      email: parsed.data.email,
      firstName: parsed.data.firstName,
      lastName: parsed.data.lastName,
      temporaryPassword: parsed.data.temporaryPassword,
      invitationId,
      provisionedBy: context.userId,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "auth_provisioning_failed";
    await supabase.rpc("fail_tenant_invitation", { p_invitation_id: invitationId, p_reason: reason });
    redirect(`/app/users?error=${encodeURIComponent("Användaren kunde inte provisioneras. Försök igen; ett eventuellt skapat Auth-konto återanvänds säkert.")}`);
  }

  const finalized = await supabase.rpc("finalize_tenant_invitation", { p_invitation_id: invitationId, p_invited_user_id: provisioned.user.id });
  if (finalized.error) {
    await supabase.rpc("fail_tenant_invitation", { p_invitation_id: invitationId, p_reason: finalized.error.message });
    redirect(`/app/users?error=${errorText(finalized.error)}`);
  }

  const notification = await sendProvisioningNotification({ email: parsed.data.email, tenantName: context.tenantName, created: provisioned.created });
  if (!notification.sent) console.warn("user_provisioning_notification_not_sent", { tenantId: context.tenantId, userId: provisioned.user.id, reason: notification.reason });
  revalidatePath("/app/users");
  revalidatePath("/app/teams");
  const resultMessage = provisioned.created
    ? "Användaren skapades. Lämna det tillfälliga lösenordet via separat kanal; lösenordsbyte krävs vid första inloggningen."
    : "Det befintliga Kundexa-kontot lades till utan att lösenordet ändrades.";
  redirect(`/app/users?message=${encodeURIComponent(resultMessage)}`);
}

/** Legacy action name kept for internal compatibility. All provisioning uses the canonical create-user flow. */
export async function inviteUser(form: FormData) {
  return createUser(form);
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
    teamIds: z.array(z.uuid()).max(50), primaryTeamId: z.union([z.uuid(), z.literal("")]),
  }).safeParse({
    userId: value(form, "user_id"), role: value(form, "role"), status: value(form, "status"),
    reassignUserId: value(form, "reassign_user_id"), teamIds: form.getAll("team_ids").map(String).filter(Boolean), primaryTeamId: value(form, "primary_team_id"),
  });
  if (!parsed.success) redirect("/app/users?error=Kontrollera medlemsrollen, statusen och teamen");
  if (["sales", "team_lead"].includes(parsed.data.role) && parsed.data.status === "active" && !parsed.data.primaryTeamId) redirect("/app/users?error=Välj ett primärt team");
  if (parsed.data.role === "team_lead" && parsed.data.status === "active" && !parsed.data.teamIds.length) redirect("/app/users?error=Välj minst ett team som teamledaren ska leda");
  if (parsed.data.primaryTeamId && !parsed.data.teamIds.includes(parsed.data.primaryTeamId)) parsed.data.teamIds.push(parsed.data.primaryTeamId);
  const supabase = await createClient();
  const { error } = await supabase.rpc("update_tenant_member_v3", {
    p_user_id: parsed.data.userId,
    p_role: parsed.data.role,
    p_status: parsed.data.status,
    p_reassign_user_id: parsed.data.reassignUserId || null,
    p_team_ids: parsed.data.teamIds,
    p_primary_team_id: parsed.data.primaryTeamId || null,
    p_restore_team_assignments: checked(form, "restore_team_assignments"),
  });
  if (error) redirect(`/app/users?error=${errorText(error)}`);
  revalidatePath("/app/users");
  revalidatePath("/app/teams");
  revalidatePath("/app/lists");
  redirect("/app/users?message=Medlemmen, teamrollen och öppna arbetsobjekt uppdaterades atomiskt");
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
  const returnTo = value(form, "return_to") === "/app/platform" ? "/app/platform" : "/app";
  const parsed = z.uuid().safeParse(value(form, "tenant_id"));
  if (!parsed.success) redirect(`${returnTo}?error=Ogiltig tenant`);
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const { error } = await supabase.rpc("switch_active_tenant", { p_tenant_id: parsed.data });
  if (error) redirect(`${returnTo}?error=${errorText(error)}`);
  revalidatePath("/app", "layout");
  redirect("/app");
}
