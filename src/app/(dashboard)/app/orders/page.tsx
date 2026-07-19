import Link from "next/link";
import { ClipboardList } from "@/components/icons";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDate } from "@/lib/utils";

export default async function OrdersPage() {
  const supabase = await createClient();
  const { data: orders } = await supabase.from("sales_orders").select("*").order("created_at", { ascending: false }).limit(250);
  const customerIds = [...new Set((orders ?? []).map((order) => order.customer_id))];
  const { data: customers } = customerIds.length ? await supabase.from("customers").select("id,display_name").in("id", customerIds) : { data: [] };
  const customerNames = new Map((customers ?? []).map((customer) => [customer.id, customer.display_name]));
  return <>
    <PageHeader title="Order" description="Order skapade från samtal, med spårbar koppling till kund, säljare, samtal och ringlista." />
    <Card><CardHeader><h2><ClipboardList size={17} /> Försäljningsorder</h2><Badge>{orders?.length ?? 0}</Badge></CardHeader><CardContent style={{ padding: 0 }}><DataTable headers={["Order", "Kund", "Status", "Värde", "Källa", "Skapad"]}>{orders?.map((order) => <tr key={order.id}><td><strong>{order.order_number}</strong></td><td><Link href={`/app/customers/${order.customer_id}`}>{customerNames.get(order.customer_id) ?? "Okänd kund"}</Link></td><td><Badge className={order.status === "confirmed" || order.status === "fulfilled" ? "badge-success" : ""}>{order.status}</Badge></td><td>{formatCurrency(Number(order.total), order.currency)}</td><td>{order.source_list_id ? "Ringlista" : order.source_call_id ? "Samtal" : "Manuell"}</td><td>{formatDate(order.created_at)}</td></tr>)}</DataTable></CardContent></Card>
  </>;
}
