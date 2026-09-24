import { ok } from "@/lib/supabase/read";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "@/components/icons";
import { createClient } from "@/lib/supabase/server";
import { ListDialerWorkspace } from "@/components/list-dialer-workspace";
import { countSellableProducts } from "@/lib/contracts/sellable-products";
import { Card, CardContent } from "@/components/ui/card";

// `setCallDisposition` bounces a list-bound call here with
// `?error=Listans efterarbete måste slutföras i ringsessionen`. The page took no
// searchParams at all, so the seller was thrown from "Mina samtal" into the ring
// session with their saved efterarbete gone and nothing said about why.
export default async function ListDialerPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const { id } = await params;
  const query = await searchParams;
  const supabase = await createClient();
  const [{ data: list }, { data: dispositions }, { data: products }] = await Promise.all([
    ok(supabase.from("customer_lists").select("id,name,status,dialing_mode").eq("id", id).single()),
    ok(supabase.from("list_dispositions").select("key,label,outcome_group,terminal,retry_after_minutes,requires_note,requires_callback,requires_order,contract_eligible").eq("list_id", id).eq("active", true).order("sort_order")),
    ok(supabase.from("products").select("id,name").eq("active", true).order("name")),
  ]);
  if (!list) notFound();
  const sellableProducts = await countSellableProducts(supabase);
  if (list.status !== "active") return <Card><CardContent><h2>Listan är inte aktiv</h2><p>En teamadministratör måste aktivera listan innan den kan ringas.</p><Link className="button button-secondary" href={`/app/lists/${id}`}><ArrowLeft size={15} /> Till listan</Link></CardContent></Card>;
  return <>
    <Link href="/app/dialer" className="muted back-link"><ArrowLeft size={15} /> Till dialer</Link>
    {query.error ? <p className="form-error">{query.error}</p> : null}
    <ListDialerWorkspace listId={list.id} listName={list.name} mode={list.dialing_mode as "manual" | "automatic"} dispositions={dispositions ?? []} products={products ?? []} sellableProducts={sellableProducts} />
  </>;
}
