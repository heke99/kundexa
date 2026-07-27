import Link from "next/link";
import { setCallDisposition } from "@/app/actions/communications";
import { Headphones } from "@/components/icons";
import { PageHeader } from "@/components/ui/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { Field } from "@/components/ui/form-field";
import { createClient } from "@/lib/supabase/server";
import { formatDate } from "@/lib/utils";

const defaultContractEligible = new Set(["interested", "contract", "contract_requested", "sale", "sold", "order"]);

export default async function CallsPage() {
  const supabase = await createClient();
  const [{ data }, { data: eligibleRows }] = await Promise.all([
    supabase.from("calls").select("*,customers(display_name)").order("created_at", { ascending: false }).limit(100),
    supabase.from("list_dispositions").select("key").eq("active", true).eq("contract_eligible", true),
  ]);
  const eligible = new Set([...(eligibleRows ?? []).map((row) => row.key), ...defaultContractEligible]);

  return <>
    <PageHeader title="Mina samtal" description="Samtalshistorik, resultat, anteckningar, återuppringningar och avtalsgrundande samtal." />
    <Card><CardHeader><h2><Headphones size={17} /> Samtal</h2><Badge>{data?.length ?? 0}</Badge></CardHeader><CardContent style={{ padding: 0 }}>
      <DataTable headers={["Kund / nummer", "Riktning", "Status", "Resultat", "Tid", "Efterarbete"]}>
        {data?.map((call) => {
          const customer = Array.isArray(call.customers) ? call.customers[0] : call.customers;
          const contractEligible = call.status === "completed" && call.answered_at && call.ended_at && call.disposition && eligible.has(call.disposition);
          return <tr key={call.id}>
            <td><strong>{customer?.display_name ?? call.to_number}</strong><br /><span className="muted">{call.from_number} → {call.to_number}</span></td>
            <td>{call.direction}</td>
            <td><Badge className={call.status === "completed" ? "badge-success" : "badge-info"}>{call.status}</Badge></td>
            <td>{call.disposition ?? "—"}{call.metadata && typeof call.metadata === "object" && (call.metadata as Record<string, unknown>).registered_manually === true ? <><br /><span className="muted">Manuellt registrerat</span></> : null}</td>
            <td>{formatDate(call.created_at)}</td>
            <td>{call.disposition ? <div className="toolbar-left"><span>Klart</span>{contractEligible && call.customer_id ? <Link className="button button-secondary button-sm" href={`/app/contracts/new?customer_id=${call.customer_id}&source_call_id=${call.id}`}>Skapa avtal</Link> : null}</div> : <form action={setCallDisposition} className="toolbar-left"><input type="hidden" name="call_id" value={call.id} /><select name="disposition" aria-label="Samtalsresultat" required><option value="">Resultat</option><option value="no_answer">Inget svar</option><option value="busy">Upptaget</option><option value="callback">Ring senare</option><option value="interested">Intresserad</option><option value="contract">Avtal ska skickas</option><option value="not_interested">Inte intresserad</option><option value="do_not_call">Ring ej igen</option></select><Field label="" name="notes" placeholder="Anteckning" /><button className="button button-primary button-sm">Spara</button></form>}</td>
          </tr>;
        })}
      </DataTable>
    </CardContent></Card>
  </>;
}
