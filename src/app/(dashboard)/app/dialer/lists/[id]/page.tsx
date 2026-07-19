import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ShieldCheck } from "@/components/icons";
import { createClient } from "@/lib/supabase/server";
import { ListDialerWorkspace } from "@/components/list-dialer-workspace";
import { Card, CardContent } from "@/components/ui/card";

export default async function ListDialerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const [{ data: list }, { data: dispositions }, { data: products }] = await Promise.all([
    supabase.from("customer_lists").select("id,name,status,dialing_mode").eq("id", id).single(),
    supabase.from("list_dispositions").select("key,label,outcome_group,terminal,retry_after_minutes,requires_note,requires_callback,requires_order").eq("list_id", id).eq("active", true).order("sort_order"),
    supabase.from("products").select("id,name").eq("active", true).order("name"),
  ]);
  if (!list) notFound();
  if (list.status !== "active") return <Card><CardContent><h2>Listan är inte aktiv</h2><p>En teamadministratör måste aktivera listan innan den kan ringas.</p><Link className="button button-secondary" href={`/app/lists/${id}`}><ArrowLeft size={15} /> Till listan</Link></CardContent></Card>;
  return <>
    <Link href="/app/dialer" className="muted back-link"><ArrowLeft size={15} /> Till dialer</Link>
    <ListDialerWorkspace listId={list.id} listName={list.name} mode={list.dialing_mode as "manual" | "automatic"} dispositions={dispositions ?? []} products={products ?? []} />
    <div className="notice dialer-policy-note"><ShieldCheck size={16} /> Varje post låses till den aktiva sessionen. Kontaktspärr, NIX-policy, tenantbehörighet och tillåten ringtid kontrolleras på serversidan före samtalet.</div>
  </>;
}
