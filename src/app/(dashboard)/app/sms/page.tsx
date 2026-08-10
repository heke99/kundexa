import { MessageSquareText, Send } from "@/components/icons";
import { createClient } from "@/lib/supabase/server";
import { queueSms } from "@/app/actions/communications";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { TextareaField } from "@/components/ui/form-field";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
import { CustomerSearchSelect, type CustomerSearchOption } from "@/components/customer-search-select";

export default async function SmsPage({ searchParams }: { searchParams: Promise<{ customer?: string; error?: string }> }) {
  const params = await searchParams;
  const supabase = await createClient();
  const initialCustomer = params.customer
    ? (await supabase.from("customers")
      .select("id,customer_type,display_name,email,phone_e164,organization_number,do_not_call,do_not_sms,do_not_email")
      .eq("id", params.customer).not("phone_e164", "is", null).maybeSingle()).data as CustomerSearchOption | null
    : null;
  const { data: messages } = await supabase.from("sms_messages")
    .select("id,direction,status,body,to_number,from_number,created_at,customers(display_name)")
    .order("created_at", { ascending: false }).limit(60);

  return <>
    <PageHeader title="SMS" description="Tenantseparerad SMS-inkorg, leveransstatus och avtalsaccept via riktiga nummer." />
    {params.error ? <p className="form-error">{params.error}</p> : null}
    <div className="split-layout">
      <Card><CardHeader><h2>Historik</h2><Badge>{messages?.length ?? 0}</Badge></CardHeader><CardContent>
        {messages?.map((message) => {
          const customer = Array.isArray(message.customers) ? message.customers[0] : message.customers;
          return <div className="activity-line" key={message.id}><span className="activity-dot"><MessageSquareText size={14} /></span><div><strong>{customer?.display_name ?? (message.direction === "outbound" ? message.to_number : message.from_number)}</strong><p>{message.body}</p><small className="muted">{message.direction} · {message.status}</small></div><time>{formatDate(message.created_at)}</time></div>;
        })}
      </CardContent></Card>
      <Card><CardHeader><h2><Send size={16} /> Nytt SMS</h2></CardHeader><CardContent>
        <form action={queueSms} className="form-stack">
          <input type="hidden" name="idempotency_key" value={crypto.randomUUID()} />
          <CustomerSearchSelect name="customer_id" channel="sms" defaultValue={params.customer ?? ""} initialCustomer={initialCustomer} required />
          <TextareaField label="Meddelande" name="body" maxLength={1600} required />
          <button className="button button-primary"><Send size={16} /> Lägg i säker sändkö</button>
        </form>
        <div className="notice warning" style={{ marginTop: 16 }}>För svar och avtalsaccept måste avsändaren vara ett SMS-kompatibelt telefonnummer, inte endast ett alfanumeriskt avsändarnamn.</div>
      </CardContent></Card>
    </div>
  </>;
}
