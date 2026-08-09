import { headers } from "next/headers";
import { Sidebar } from "@/components/app-shell/sidebar";
import { Topbar } from "@/components/app-shell/topbar";
import { getAppContext, getPlatformContext } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { RealtimeRefresh } from "@/components/app-shell/realtime-refresh";

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
  const now = Date.now();
  const [{ data: callbacks }, { count: listCount }, { data: tenantOptions }] = await Promise.all([
    supabase.from("activities").select("due_at,snoozed_until").eq("type", "callback").eq("status", "open").limit(500),
    supabase.from("customer_lists").select("id", { count: "exact", head: true }).eq("status", "active"),
    supabase.rpc("list_current_user_tenants"),
  ]);
  const dueCallbacks = (callbacks ?? []).filter((item) => new Date(item.snoozed_until ?? item.due_at ?? 0).getTime() <= now).length;

  return <div className="app-shell">
    <RealtimeRefresh />
    <Sidebar platformRole={ctx.platformRole} dueCallbacks={dueCallbacks} activeLists={listCount ?? 0} />
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
