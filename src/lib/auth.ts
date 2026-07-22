import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export type AppContext = {
  userId: string;
  email: string;
  tenantId: string;
  tenantName: string;
  tenantLegalName: string;
  tenantTimezone: string;
  role: string;
  teamIds: string[];
  platformRole: string | null;
};

export const getAppContext = cache(async (): Promise<AppContext> => {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("active_tenant_id, full_name")
    .eq("id", user.id)
    .single();

  if (!profile?.active_tenant_id) redirect("/onboarding");

  const { data: membership } = await supabase
    .from("tenant_memberships")
    .select("role, tenants(name,legal_name,timezone,status)")
    .eq("tenant_id", profile.active_tenant_id)
    .eq("user_id", user.id)
    .eq("status", "active")
    .single();

  if (!membership) redirect("/onboarding");

  const [{ data: teamRows }, { data: platformMembership }] = await Promise.all([
    supabase
    .from("team_members")
    .select("team_id")
    .eq("tenant_id", profile.active_tenant_id)
    .eq("user_id", user.id),
    supabase
      .from("platform_memberships")
      .select("role,status")
      .eq("user_id", user.id)
      .eq("status", "active")
      .maybeSingle(),
  ]);

  const tenantsValue = membership.tenants as unknown as { name?: string; legal_name?: string; timezone?: string; status?: string } | { name?: string; legal_name?: string; timezone?: string; status?: string }[] | null;
  const tenantName = Array.isArray(tenantsValue) ? tenantsValue[0]?.name : tenantsValue?.name;
  const tenantLegalName = Array.isArray(tenantsValue) ? tenantsValue[0]?.legal_name : tenantsValue?.legal_name;
  const tenantTimezone = Array.isArray(tenantsValue) ? tenantsValue[0]?.timezone : tenantsValue?.timezone;
  const tenantStatus = Array.isArray(tenantsValue) ? tenantsValue[0]?.status : tenantsValue?.status;
  if (!tenantStatus || !["trial", "active"].includes(tenantStatus)) redirect("/login?error=Tenantkontot är pausat eller avslutat");

  return {
    userId: user.id,
    email: user.email ?? "",
    tenantId: profile.active_tenant_id,
    tenantName: tenantName ?? "Kundexa",
    tenantLegalName: tenantLegalName ?? tenantName ?? "Kundexa",
    tenantTimezone: tenantTimezone ?? "Europe/Stockholm",
    role: membership.role,
    teamIds: (teamRows ?? []).map((row) => row.team_id),
    platformRole: platformMembership?.role ?? null,
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

export async function getPlatformContext() {
  const context = await getAppContext();
  if (!context.platformRole) redirect("/app");
  return context;
}
