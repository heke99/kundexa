import { Sidebar } from "@/components/app-shell/sidebar";
import { Topbar } from "@/components/app-shell/topbar";
import { getAppContext } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { RealtimeRefresh } from "@/components/app-shell/realtime-refresh";

export const dynamic="force-dynamic";
export default async function AppLayout({ children }: { children: React.ReactNode }) { const ctx=await getAppContext(); const supabase=await createClient(); const now=Date.now(); const [{data:callbacks},{count:listCount}]=await Promise.all([supabase.from("activities").select("due_at,snoozed_until").eq("type","callback").eq("status","open").limit(500),supabase.from("customer_lists").select("id",{count:"exact",head:true}).eq("status","active")]); const dueCallbacks=(callbacks??[]).filter((item)=>new Date(item.snoozed_until??item.due_at??0).getTime()<=now).length; return <div className="app-shell"><RealtimeRefresh /><Sidebar platformRole={ctx.platformRole} dueCallbacks={dueCallbacks} activeLists={listCount??0} /><main className="app-main"><Topbar tenantName={ctx.tenantName} email={ctx.email} notificationCount={dueCallbacks} /><div className="page-content">{children}</div></main></div>; }
