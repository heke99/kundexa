import { Sidebar } from "@/components/app-shell/sidebar";
import { Topbar } from "@/components/app-shell/topbar";
import { getAppContext } from "@/lib/auth";

export const dynamic="force-dynamic";
export default async function AppLayout({ children }: { children: React.ReactNode }) { const ctx=await getAppContext(); return <div className="app-shell"><Sidebar /><main className="app-main"><Topbar tenantName={ctx.tenantName} email={ctx.email} /><div className="page-content">{children}</div></main></div>; }
