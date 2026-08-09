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
  teamIds: string[];
  platformRole: PlatformRole | null;
};

export type PlatformContext = {
  userId: string;
  email: string;
  platformRole: PlatformRole;
};

type TenantRecord = { name?: string; legal_name?: string; timezone?: string; status?: string };

function oneTenant(value: TenantRecord | TenantRecord[] | null | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Tenant workspace context. Platform membership is checked before tenant redirects so
 * control-plane users are never forced to manufacture or keep an active tenant merely
 * to administer Kundexa itself.
 */
export const getAppContext = cache(async (): Promise<AppContext> => {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [{ data: profile }, { data: platformMembership, error: platformMembershipError }] = await Promise.all([
    supabase.from("profiles").select("active_tenant_id").eq("id", user.id).maybeSingle(),
    supabase.from("platform_memberships").select("role").eq("user_id", user.id).eq("status", "active").maybeSingle(),
  ]);
  if (platformMembershipError) {
    console.error("platform_membership_lookup_failed", { userId: user.id, code: platformMembershipError.code ?? null });
  }
  const platformRole = (platformMembership?.role as PlatformRole | undefined) ?? null;

  if (!profile?.active_tenant_id) {
    if (platformRole) redirect("/app/platform");
    redirect("/onboarding");
  }

  const { data: membership } = await supabase
    .from("tenant_memberships")
    .select("role, tenants(name,legal_name,timezone,status)")
    .eq("tenant_id", profile.active_tenant_id)
    .eq("user_id", user.id)
    .eq("status", "active")
    .maybeSingle();

  if (!membership) {
    if (platformRole) redirect("/app/platform");
    redirect("/onboarding");
  }

  const tenant = oneTenant(membership.tenants as TenantRecord | TenantRecord[] | null);
  if (!tenant?.status || !["trial", "active"].includes(tenant.status)) {
    if (platformRole) redirect("/app/platform");
    redirect("/login?error=Tenantkontot är pausat eller avslutat");
  }

  const { data: teamRows } = await supabase
    .from("team_members")
    .select("team_id")
    .eq("tenant_id", profile.active_tenant_id)
    .eq("user_id", user.id);

  return {
    userId: user.id,
    email: user.email ?? "",
    tenantId: profile.active_tenant_id,
    tenantName: tenant.name ?? "Kundexa",
    tenantLegalName: tenant.legal_name ?? tenant.name ?? "Kundexa",
    tenantTimezone: tenant.timezone ?? "Europe/Stockholm",
    role: membership.role,
    teamIds: (teamRows ?? []).map((row) => row.team_id),
    platformRole,
  };
});

export function isAdmin(role: string) {
  return role === "owner" || role === "admin";
}

export function isPlatformAdmin(role: string | null) {
  return role === "platform_owner" || role === "platform_admin";
}

export function isPlatformOwner(role: string | null) {
  return role === "platform_owner";
}

export function canReadPlatformAdministration(role: string | null) {
  return isPlatformAdmin(role) || role === "platform_auditor";
}

/**
 * Platform control-plane context is intentionally independent from profiles.active_tenant_id,
 * tenant membership and tenant lifecycle. Platform authorization comes exclusively from an
 * active platform_memberships row; tenant authorization remains in getAppContext().
 */
export const getPlatformContext = cache(async (): Promise<PlatformContext> => {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: membership, error } = await supabase
    .from("platform_memberships")
    .select("role,status")
    .eq("user_id", user.id)
    .eq("status", "active")
    .maybeSingle();

  if (error) {
    console.error("platform_context_lookup_failed", { userId: user.id, code: error.code ?? null });
    redirect("/app");
  }
  if (!membership) redirect("/app");

  return {
    userId: user.id,
    email: user.email ?? "",
    platformRole: membership.role as PlatformRole,
  };
});
