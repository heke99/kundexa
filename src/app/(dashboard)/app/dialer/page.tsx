import { can } from "@/lib/permissions";
import { ok } from "@/lib/supabase/read";
import Link from "next/link";
import { Clock3, ListFilter, PhoneCall, Plus } from "@/components/icons";
import { createManualProspect } from "@/app/actions/customers";
import { createClient } from "@/lib/supabase/server";
import { getAppContext } from "@/lib/auth";
import { manualContractDispositions } from "@/lib/contracts/manual-dispositions";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DialerPanel } from "@/components/dialer-panel";
import { Badge } from "@/components/ui/badge";
import { Field } from "@/components/ui/form-field";
import { formatDate } from "@/lib/utils";

export default async function DialerPage({ searchParams }: { searchParams: Promise<{ customer?: string; callback?: string; error?: string }> }) {
  const params = await searchParams;
  const [supabase, context] = await Promise.all([createClient(), getAppContext()]);
  const now = new Date().toISOString();
  const contractDispositionKeys = (await manualContractDispositions(supabase, context.tenantId)).map((item) => item.key);
  const [{ data: selectedCustomer }, { data: lists }, { data: callbacks }, { data: callerIdData }] = await Promise.all([
    params.customer
      ? supabase.from("customers").select("id,display_name,phone_e164,do_not_call").eq("id", params.customer).not("phone_e164", "is", null).is("deleted_at", null).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    ok(supabase.from("customer_lists").select("id,name,dialing_mode,priority,status").eq("status", "active").order("priority", { ascending: false })),
    ok(supabase.from("activities").select("id,customer_id,list_id,callback_scope,due_at,title,customers(display_name,phone_e164)").eq("type", "callback").eq("status", "open").lte("due_at", now).order("due_at").limit(20)),
    ok(supabase.from("phone_numbers").select("id,number_e164").eq("status","active").eq("supports_voice",true).order("number_e164")),
  ]);
  return <>
    <PageHeader title="Dialer" description="Välj en ringlista eller ring ett enskilt nummer." />
    {params.error ? <p className="form-error">{params.error}</p> : null}
    <div className="grid grid-3" style={{ marginBottom: 18 }}>
      {lists?.map((list) => <Link key={list.id} href={`/app/dialer/lists/${list.id}`} className="list-launch-card"><span className="stat-icon"><ListFilter size={18} /></span><div><strong>{list.name}</strong><p>{list.dialing_mode === "automatic" ? "Automatisk sekventiell ringning" : "Manuell ringning"}</p></div><Badge className="badge-success">Starta</Badge></Link>)}
      {!lists?.length ? <div className="notice">Du har inga aktiva och tilldelade ringlistor.</div> : null}
    </div>
    <div className="dialer-grid">
      <div className="phone-panel"><DialerPanel customers={selectedCustomer ? [selectedCustomer] : []} initialCustomer={selectedCustomer?.id} callbackActivityId={params.callback} callerIdOptions={(callerIdData ?? []) as Array<{ id: string; number_e164: string }>} mayManageIntegrations={can(context.role, "integrations.manage")} contractDispositions={contractDispositionKeys} /></div>
      <div className="grid">
        <Card><CardHeader><h2><Plus size={17} /> Ring ett nytt nummer</h2></CardHeader><CardContent>
          <p className="muted">Kundkortet öppnas, eller skapas om numret är nytt. Du ringer därifrån.</p>
          <form action={createManualProspect} className="form-grid">
            <Field label="Namn eller nummer" name="display_name" placeholder="Nytt prospekt" />
            <Field label="Telefonnummer" name="phone" type="tel" required placeholder="070 123 45 67" />
            {/* Kundtypen rättas på kundkortet vid behov; här räcker numret. */}
            <input type="hidden" name="customer_type" value="person" />
            <button className="button button-secondary" style={{ alignSelf: "end" }}>Matcha och öppna</button>
          </form>
        </CardContent></Card>
        <Card><CardHeader><h2><Clock3 size={17} /> Förfallna återkomster</h2><Badge className={callbacks?.length ? "badge-warning" : ""}>{callbacks?.length ?? 0}</Badge></CardHeader><CardContent>{callbacks?.map((callback) => {
          const customer = Array.isArray(callback.customers) ? callback.customers[0] : callback.customers;
          const href = callback.list_id ? `/app/dialer/lists/${callback.list_id}` : `/app/dialer?customer=${callback.customer_id}`;
          return <Link className="activity-line" href={href} key={callback.id}><span className="activity-dot"><PhoneCall size={14} /></span><div><strong>{customer?.display_name ?? callback.title}</strong><p>{callback.callback_scope === "global" ? "Global återkomst" : "Personlig återkomst"} · {customer?.phone_e164 ?? "telefon saknas"}</p></div><time>{formatDate(callback.due_at)}</time></Link>;
        })}{!callbacks?.length ? <p className="muted">Inga förfallna återkomster.</p> : null}</CardContent></Card>
        {/* "Senaste samtal" låg här och upprepade Mina samtal i menyn. */}
      </div>
    </div>
  </>;
}
