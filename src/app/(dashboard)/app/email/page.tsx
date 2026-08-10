import { Mail, Send } from "@/components/icons";
import { createClient } from "@/lib/supabase/server";
import { queueEmail } from "@/app/actions/communications";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Field, TextareaField } from "@/components/ui/form-field";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
import { CustomerSearchSelect, type CustomerSearchOption } from "@/components/customer-search-select";

export default async function EmailPage({ searchParams }: { searchParams: Promise<{ customer?: string; error?: string }> }) {
  const params = await searchParams;
  const supabase = await createClient();
  const initialCustomer = params.customer
    ? (await supabase.from("customers")
      .select("id,customer_type,display_name,email,phone_e164,organization_number,do_not_call,do_not_sms,do_not_email")
      .eq("id", params.customer).not("email", "is", null).maybeSingle()).data as CustomerSearchOption | null
    : null;
  const { data: messages } = await supabase.from("email_messages")
    .select("id,subject,to_addresses,status,created_at,customers(display_name)")
    .order("created_at", { ascending: false }).limit(60);

  return <>
    <PageHeader title="E-post" description="Transaktionella utskick med tenantens verifierade domän, mallar och leveranshändelser." />
    {params.error ? <p className="form-error">{params.error}</p> : null}
    <div className="split-layout">
      <Card><CardHeader><h2>Utskick</h2><Badge>{messages?.length ?? 0}</Badge></CardHeader><CardContent>
        {messages?.map((message) => {
          const customer = Array.isArray(message.customers) ? message.customers[0] : message.customers;
          return <div className="activity-line" key={message.id}><span className="activity-dot"><Mail size={14} /></span><div><strong>{message.subject}</strong><p>{customer?.display_name ?? message.to_addresses.join(", ")}</p><small className="muted">{message.status}</small></div><time>{formatDate(message.created_at)}</time></div>;
        })}
      </CardContent></Card>
      <Card><CardHeader><h2><Send size={16} /> Nytt e-postmeddelande</h2></CardHeader><CardContent>
        <form action={queueEmail} className="form-stack">
          <input type="hidden" name="idempotency_key" value={crypto.randomUUID()} />
          <CustomerSearchSelect name="customer_id" channel="email" defaultValue={params.customer ?? ""} initialCustomer={initialCustomer} required />
          <Field label="Ämne" name="subject" required />
          <TextareaField label="Meddelande" name="body" required />
          <button className="button button-primary"><Send size={16} /> Lägg i sändkö</button>
        </form>
      </CardContent></Card>
    </div>
  </>;
}
