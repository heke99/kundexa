import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Sidebar } from "@/components/app-shell/sidebar";
import { Topbar } from "@/components/app-shell/topbar";
import { getAppContext, getPlatformContext } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { RealtimeRefresh } from "@/components/app-shell/realtime-refresh";
import { canAccessRoute } from "@/lib/permissions";

export const dynamic = "force-dynamic";

type TenantOption = { tenant_id: string; tenant_name: string; membership_role: string; is_active: boolean };

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const requestHeaders = await headers();
  const pathname = requestHeaders.get("x-kundexa-path") ?? "";
  const platformMode = pathname === "/app/platform" || pathname.startsWith("/app/platform/");
  const supabase = await createClient();

  if (platformMode) {
    const platform = await getPlatformContext();
    const { data: tenantOptions } = await supabase.rpc("list_current_user_tenants");
    const tenants = (tenantOptions ?? []) as TenantOption[];
    return <div className="app-shell">
      <Sidebar
        platformRole={platform.platformRole}
        platformMode
        hasActiveTenant={tenants.some((tenant) => tenant.is_active)}
      />
      <main className="app-main">
        <Topbar
          tenantName="Kundexa Plattform"
          email={platform.email}
          tenants={tenants}
          platformMode
        />
        <div className="page-content">{children}</div>
      </main>
    </div>;
  }

  const ctx = await getAppContext();
  if (pathname.startsWith("/app/") && !canAccessRoute(ctx.role, pathname)) redirect("/app?error=Du saknar behörighet till den arbetsytan");
  const [{ data: badges }, { data: tenantOptions }] = await Promise.all([
    supabase.rpc("navigation_badges"),
    supabase.rpc("list_current_user_tenants"),
  ]);
  const navigationBadges = (badges ?? { dueCallbacks: 0, activeLists: 0 }) as { dueCallbacks?: number; activeLists?: number };
  const dueCallbacks = Number(navigationBadges.dueCallbacks ?? 0);
  const activeLists = Number(navigationBadges.activeLists ?? 0);

  return <div className="app-shell">
    <RealtimeRefresh />
    <Sidebar platformRole={ctx.platformRole} role={ctx.role} dueCallbacks={dueCallbacks} activeLists={activeLists} />
    <main className="app-main">
      <Topbar
        tenantName={ctx.tenantName}
        email={ctx.email}
        notificationCount={dueCallbacks}
        tenants={(tenantOptions ?? []) as TenantOption[]}
      />
      <div className="page-content">{children}</div>
    </main>
  </div>;
}
