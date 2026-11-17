import { isTemporaryAuthReadError } from "@/lib/security/auth-read-error";
import { enforceMfaGate } from "@/lib/security/mfa";
import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export type PlatformRole = "platform_owner" | "platform_admin" | "platform_support" | "platform_auditor";

export type AppContext = {
  userId: string;
  email: string;
  tenantId: string;
  tenantName: string;
  tenantLegalName: string;
  tenantTimezone: string;
  role: string;
  primaryTeamId: string | null;
  teamIds: string[];
  platformRole: PlatformRole | null;
};

export type PlatformContext = {
  userId: string;
  email: string;
  platformRole: PlatformRole;
};

type TenantRecord = { name?: string; legal_name?: string; timezone?: string; status?: string; onboarding_status?: string };

function oneTenant(value: TenantRecord | TenantRecord[] | null | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

async function enforceFirstLoginGate(supabase: Awaited<ReturnType<typeof createClient>>) {
  const { data: rows, error } = await supabase.rpc("current_user_security_state");
  if (error) {
    // A failed read is not a failed login. This gate runs on every page load, in
    // both the tenant and the platform context, so sending the user to /login on
    // any database blip turns one slow query into "you are signed out" — and the
    // session was never invalid.
    //
    // It is also no safer. The gate exists to force a password change, and a user
    // bounced to /login simply signs back in and meets the same gate. Logging them
    // out buys nothing and costs the session, so this throws instead: nothing is
    // rendered, the boundary shows a real error, and they stay signed in.
    console.error("user_security_state_lookup_failed", { code: error.code ?? null });
    throw new Error("security_state_unavailable");
  }
  const state = Array.isArray(rows) ? rows[0] : rows;
  if (state?.must_change_password) redirect("/change-password");
}

/** Tenant workspace context. Authorization comes from database membership, never Auth user metadata. */
export const getAppContext = cache(async (): Promise<AppContext> => {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (isTemporaryAuthReadError(authError)) throw new Error("authentication_service_unavailable");
  if (!user) redirect("/login");
  await enforceFirstLoginGate(supabase);
  await enforceMfaGate(supabase);

  const [{ data: profile, error: profileError }, { data: platformMembership, error: platformMembershipError }] = await Promise.all([
    supabase.from("profiles").select("active_tenant_id").eq("id", user.id).maybeSingle(),
    supabase.from("platform_memberships").select("role").eq("user_id", user.id).eq("status", "active").maybeSingle(),
  ]);
  if (profileError || platformMembershipError) {
    console.error("workspace_context_lookup_failed", { code: profileError?.code ?? platformMembershipError?.code ?? null });
    throw new Error("workspace_context_unavailable");
  }
  const platformRole = (platformMembership?.role as PlatformRole | undefined) ?? null;

  if (!profile?.active_tenant_id) {
    if (platformRole) redirect("/app/platform");
    redirect("/onboarding");
  }

  const { data: membership, error: membershipError } = await supabase
    .from("tenant_memberships")
    .select("role,primary_team_id, tenants(name,legal_name,timezone,status,onboarding_status)")
    .eq("tenant_id", profile.active_tenant_id)
    .eq("user_id", user.id)
    .eq("status", "active")
    .maybeSingle();

  if (membershipError) throw new Error("tenant_membership_unavailable");

  if (!membership) {
    if (platformRole) redirect("/app/platform");
    redirect("/onboarding");
  }

  const tenant = oneTenant(membership.tenants as TenantRecord | TenantRecord[] | null);
  if (!tenant?.status || !["trial", "active"].includes(tenant.status)) {
    if (platformRole) redirect("/app/platform");
    redirect("/login?error=Tenantkontot är pausat eller avslutat");
  }
  if (tenant.onboarding_status && tenant.onboarding_status !== "active") {
    if (membership.role === "owner") redirect("/onboarding");
    redirect("/login?error=Organisationens onboarding är inte slutförd");
  }

  const { data: teamRows, error: teamError } = await supabase
    .from("team_members")
    .select("team_id,teams!inner(status)")
    .eq("tenant_id", profile.active_tenant_id)
    .eq("user_id", user.id)
    .eq("assignment_paused", false)
    .eq("teams.status", "active");
  if (teamError) throw new Error("team_membership_unavailable");
  const activeTeamIds = (teamRows ?? []).map(row => row.team_id);

  return {
    userId: user.id,
    email: user.email ?? "",
    tenantId: profile.active_tenant_id,
    tenantName: tenant.name ?? "Kundexa",
    tenantLegalName: tenant.legal_name ?? tenant.name ?? "Kundexa",
    tenantTimezone: tenant.timezone ?? "Europe/Stockholm",
    role: membership.role,
    primaryTeamId: membership.primary_team_id && activeTeamIds.includes(membership.primary_team_id) ? membership.primary_team_id : null,
    teamIds: activeTeamIds,
    platformRole,
  };
});

export function isAdmin(role: string) { return role === "owner" || role === "admin"; }
export function isPlatformAdmin(role: string | null) { return role === "platform_owner" || role === "platform_admin"; }
export function isPlatformOwner(role: string | null) { return role === "platform_owner"; }
export function canReadPlatformAdministration(role: string | null) { return isPlatformAdmin(role) || role === "platform_auditor"; }

/** Platform control-plane authorization is independent of tenant membership. */
export const getPlatformContext = cache(async (): Promise<PlatformContext> => {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (isTemporaryAuthReadError(authError)) throw new Error("authentication_service_unavailable");
  if (!user) redirect("/login");
  await enforceFirstLoginGate(supabase);
  await enforceMfaGate(supabase);

  const { data: membership, error } = await supabase
    .from("platform_memberships")
    .select("role,status")
    .eq("user_id", user.id)
    .eq("status", "active")
    .maybeSingle();
  if (error) {
    console.error("platform_context_lookup_failed", { userId: user.id, code: error.code ?? null });
    throw new Error("platform_context_unavailable");
  }
  if (!membership) redirect("/app");
  return { userId: user.id, email: user.email ?? "", platformRole: membership.role as PlatformRole };
});
