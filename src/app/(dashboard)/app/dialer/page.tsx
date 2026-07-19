import Link from "next/link";
import { Clock3, ListFilter, PhoneCall, Plus, ShieldCheck } from "@/components/icons";
import { createManualProspect } from "@/app/actions/customers";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { WebRtcDialer } from "@/components/webrtc-dialer";
import { Badge } from "@/components/ui/badge";
import { Field, SelectField } from "@/components/ui/form-field";
import { formatDate } from "@/lib/utils";

export default async function DialerPage({ searchParams }: { searchParams: Promise<{ customer?: string; callback?: string; error?: string }> }) {
  const params = await searchParams;
  const supabase = await createClient();
  const now = new Date().toISOString();
  const [{ data: customers }, { data: recent }, { data: lists }, { data: callbacks }] = await Promise.all([
    supabase.from("customers").select("id,display_name,phone_e164,do_not_call").not("phone_e164", "is", null).is("deleted_at", null).order("display_name").limit(500),
    supabase.from("calls").select("id,to_number,status,disposition,created_at,customers(display_name)").order("created_at", { ascending: false }).limit(8),
    supabase.from("customer_lists").select("id,name,dialing_mode,priority,status").eq("status", "active").order("priority", { ascending: false }),
    supabase.from("activities").select("id,customer_id,list_id,callback_scope,due_at,title,customers(display_name,phone_e164)").eq("type", "callback").eq("status", "open").lte("due_at", now).order("due_at").limit(20),
  ]);
  return <>
    <PageHeader title="Dialer" description="Välj en tilldelad ringlista eller ring ett enskilt nummer från det kanoniska kundkortet." />
    {params.error ? <p className="form-error">{params.error}</p> : null}
    <div className="grid grid-3" style={{ marginBottom: 18 }}>
      {lists?.map((list) => <Link key={list.id} href={`/app/dialer/lists/${list.id}`} className="list-launch-card"><span className="stat-icon"><ListFilter size={18} /></span><div><strong>{list.name}</strong><p>{list.dialing_mode === "automatic" ? "Automatisk sekventiell ringning" : "Manuell ringning"}</p></div><Badge className="badge-success">Starta</Badge></Link>)}
      {!lists?.length ? <div className="notice">Du har inga aktiva och tilldelade ringlistor.</div> : null}
    </div>
    <div className="dialer-grid">
      <div className="phone-panel"><WebRtcDialer customers={customers ?? []} initialCustomer={params.customer} callbackActivityId={params.callback} /></div>
      <div className="grid">
        <Card><CardHeader><h2><Plus size={17} /> Ring ett nytt nummer</h2></CardHeader><CardContent><p className="muted">Numret matchas först mot befintliga kundkort. Finns ingen träff skapas ett enda nytt prospekt.</p><form action={createManualProspect} className="form-grid"><Field label="Namn eller nummer" name="display_name" placeholder="Nytt prospekt" /><Field label="Telefonnummer" name="phone" type="tel" required placeholder="070 123 45 67" /><SelectField label="Typ" name="customer_type" defaultValue="person"><option value="person">Privatperson</option><option value="company">Företag</option></SelectField><button className="button button-secondary" style={{ alignSelf: "end" }}>Matcha och öppna</button></form></CardContent></Card>
        <Card><CardHeader><h2><Clock3 size={17} /> Förfallna återkomster</h2><Badge className={callbacks?.length ? "badge-warning" : ""}>{callbacks?.length ?? 0}</Badge></CardHeader><CardContent>{callbacks?.map((callback) => {
          const customer = Array.isArray(callback.customers) ? callback.customers[0] : callback.customers;
          const href = callback.list_id ? `/app/dialer/lists/${callback.list_id}` : `/app/dialer?customer=${callback.customer_id}`;
          return <Link className="activity-line" href={href} key={callback.id}><span className="activity-dot"><PhoneCall size={14} /></span><div><strong>{customer?.display_name ?? callback.title}</strong><p>{callback.callback_scope === "global" ? "Global återkomst" : "Personlig återkomst"} · {customer?.phone_e164 ?? "telefon saknas"}</p></div><time>{formatDate(callback.due_at)}</time></Link>;
        })}{!callbacks?.length ? <p className="muted">Inga förfallna återkomster.</p> : null}</CardContent></Card>
        <Card><CardHeader><h2><ShieldCheck size={17} /> Säkerhetskontroller</h2></CardHeader><CardContent><div className="grid grid-3"><div className="notice">Aktivt tenantmedlemskap och listbehörighet.</div><div className="notice">Intern spärr, samtycke och NIX-policy.</div><div className="notice">Ett tidsbegränsat kölås per prospekt.</div></div></CardContent></Card>
        <Card><CardHeader><h2><Clock3 size={17} /> Senaste samtal</h2></CardHeader><CardContent>{recent?.map((call) => { const customer = Array.isArray(call.customers) ? call.customers[0] : call.customers; return <div className="activity-line" key={call.id}><span className="activity-dot"><PhoneCall size={14} /></span><div><strong>{customer?.display_name ?? call.to_number}</strong><p>{call.disposition ?? call.status}</p></div><time>{formatDate(call.created_at)}</time></div>; })}</CardContent></Card>
      </div>
    </div>
  </>;
}
