import Link from "next/link";
import { BookUser } from "@/components/icons";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";

const PAGE_SIZE = 100;

export default async function ProspectsPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const params = await searchParams;
  const page = Math.max(1, Number.parseInt(params.page ?? "1", 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;
  const supabase = await createClient();
  const { data } = await supabase.from("customers")
    .select("id,display_name,customer_type,phone_e164,city,call_attempts,next_activity_at,do_not_call")
    .in("lifecycle", ["prospect", "lead"])
    .is("deleted_at", null)
    .order("next_activity_at", { ascending: true, nullsFirst: false })
    .order("id")
    .range(offset, offset + PAGE_SIZE);
  const rows = (data ?? []).slice(0, PAGE_SIZE);
  const hasNext = (data?.length ?? 0) > PAGE_SIZE;
  return <>
    <PageHeader title="Prospekt" description="Arbetslistan för nya, tilldelade och pågående leads." />
    <Card><CardHeader><h2><BookUser size={17} /> Prospekt och leads</h2><Badge>{rows.length} på sidan</Badge></CardHeader>
      <CardContent style={{ padding: 0 }}><DataTable headers={["Prospekt", "Typ", "Telefon", "Ort", "Försök", "Nästa aktivitet", "Spärr"]}>
        {rows.map((customer) => <tr key={customer.id}><td><Link href={`/app/customers/${customer.id}`}><strong>{customer.display_name}</strong></Link></td><td>{customer.customer_type}</td><td>{customer.phone_e164 ?? "—"}</td><td>{customer.city ?? "—"}</td><td>{customer.call_attempts}</td><td>{formatDate(customer.next_activity_at)}</td><td><Badge className={customer.do_not_call ? "badge-danger" : "badge-success"}>{customer.do_not_call ? "Spärrad" : "Tillåten"}</Badge></td></tr>)}
      </DataTable><div className="toolbar-left" style={{ padding: 14 }}>
        {page > 1 ? <Link className="button button-ghost button-sm" href={`/app/prospects?page=${page - 1}`}>Föregående</Link> : null}
        <span className="muted">Sida {page}</span>
        {hasNext ? <Link className="button button-ghost button-sm" href={`/app/prospects?page=${page + 1}`}>Nästa</Link> : null}
      </div></CardContent></Card>
  </>;
}
