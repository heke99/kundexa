import { BarChart3, FileCheck2, PhoneCall, Target, Users } from "@/components/icons";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/page-header";
import { StatCard } from "@/components/ui/stat-card";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { formatCurrency } from "@/lib/utils";

export default async function ReportsPage() {
  const supabase = await createClient();
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const [{ data: calls }, { data: contracts }, { data: campaigns }, { data: lists }, { data: orders }, { data: callbacks }, { data: members }] = await Promise.all([
    supabase.from("calls").select("id,status,disposition,duration_seconds,user_id,list_id,cost,created_at").gte("created_at", since),
    supabase.from("contracts").select("status,value,owner_user_id").gte("created_at", since),
    supabase.from("campaigns").select("id,name,status,max_attempts"),
    supabase.from("customer_lists").select("id,name,status,dialing_mode"),
    supabase.from("sales_orders").select("id,source_list_id,total,currency,created_at").gte("created_at", since),
    supabase.from("activities").select("id,list_id,status,due_at,handled_at").eq("type", "callback").gte("created_at", since),
    supabase.from("customer_list_members").select("list_id,state"),
  ]);
  const answered = (calls ?? []).filter((call) => ["interested", "not_interested", "callback", "order", "do_not_call"].includes(call.disposition ?? "")).length;
  const signed = (contracts ?? []).filter((contract) => ["signed", "active"].includes(contract.status)).length;
  const sent = (contracts ?? []).filter((contract) => !["draft", "ready"].includes(contract.status)).length;
  const callSeconds = (calls ?? []).reduce((sum, call) => sum + (call.duration_seconds ?? 0), 0);
  const listRows = (lists ?? []).map((list) => {
    const listCalls = (calls ?? []).filter((call) => call.list_id === list.id);
    const listOrders = (orders ?? []).filter((order) => order.source_list_id === list.id);
    const listCallbacks = (callbacks ?? []).filter((callback) => callback.list_id === list.id);
    const listMembers = (members ?? []).filter((member) => member.list_id === list.id);
    const contacts = listCalls.filter((call) => ["interested", "not_interested", "callback", "order", "do_not_call"].includes(call.disposition ?? "")).length;
    return {
      ...list,
      attempts: listCalls.length,
      contactRate: listCalls.length ? Math.round(contacts / listCalls.length * 100) : 0,
      orders: listOrders.length,
      revenue: listOrders.reduce((sum, order) => sum + Number(order.total), 0),
      callbacks: listCallbacks.length,
      handledCallbacks: listCallbacks.filter((callback) => callback.status === "completed" && callback.handled_at).length,
      remaining: listMembers.filter((member) => !["completed", "blocked"].includes(member.state)).length,
    };
  });
  return <>
    <PageHeader title="Rapporter" description="Händelsebaserad försäljning, kontaktgrad, ringlistor, återkomster och order de senaste 30 dagarna." />
    <div className="grid grid-4"><StatCard icon={PhoneCall} label="Ringförsök" value={calls?.length ?? 0} /><StatCard icon={Users} label="Kontaktgrad" value={`${calls?.length ? Math.round(answered / calls.length * 100) : 0}%`} /><StatCard icon={FileCheck2} label="Signeringsgrad" value={`${sent ? Math.round(signed / sent * 100) : 0}%`} /><StatCard icon={Target} label="Samtalstid" value={`${Math.round(callSeconds / 60)} min`} /></div>
    <Card style={{ marginTop: 18 }}><CardHeader><h2><BarChart3 size={17} /> List- och dialerresultat</h2></CardHeader><CardContent style={{ padding: 0 }}><DataTable headers={["Lista", "Läge", "Ringförsök", "Kontaktgrad", "Order", "Omsättning", "Återkomster", "Kvar"]}>{listRows.map((row) => <tr key={row.id}><td><strong>{row.name}</strong><br /><span className="muted">{row.status}</span></td><td>{row.dialing_mode === "automatic" ? "Automatisk" : "Manuell"}</td><td>{row.attempts}</td><td>{row.contactRate}%</td><td>{row.orders}</td><td>{formatCurrency(row.revenue, "SEK")}</td><td>{row.handledCallbacks} / {row.callbacks} hanterade</td><td>{row.remaining}</td></tr>)}</DataTable></CardContent></Card>
    <Card style={{ marginTop: 18 }}><CardHeader><h2><BarChart3 size={17} /> Kampanjöversikt</h2></CardHeader><CardContent style={{ padding: 0 }}><DataTable headers={["Kampanj", "Status", "Max försök", "Kopplad rapportering"]}>{campaigns?.map((campaign) => <tr key={campaign.id}><td><strong>{campaign.name}</strong></td><td>{campaign.status}</td><td>{campaign.max_attempts}</td><td>Kund-, samtals- och avtalsdata via tenant-ID</td></tr>)}</DataTable></CardContent></Card>
  </>;
}
