import { ok } from "@/lib/supabase/read";
import Link from "next/link";
import { setCallDisposition } from "@/app/actions/communications";
import { Headphones } from "@/components/icons";
import { PageHeader } from "@/components/ui/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { Field } from "@/components/ui/form-field";
import { createClient } from "@/lib/supabase/server";
import { getAppContext } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { manualContractDispositions } from "@/lib/contracts/manual-dispositions";
import { formatDate } from "@/lib/utils";
import { callStatusLabel, dispositionLabel } from "@/lib/ui/labels";


export default async function CallsPage({ searchParams }: { searchParams: Promise<{ error?: string; message?: string; call?: string }> }) {
  const params = await searchParams;
  const [supabase, context] = await Promise.all([createClient(), getAppContext()]);
  // `calls.read` opens the page, but registering efterarbete goes through
  // setCallDisposition, which requires `calls.create`. Kvalitet and viewer
  // saw a form the server action would always refuse.
  const mayLog = can(context.role, "calls.create");
  const [{ data }, { data: eligibleRows }] = await Promise.all([
    ok(supabase.from("calls").select("*,customers(display_name)").order("created_at", { ascending: false }).limit(100)),
    ok(supabase.from("list_dispositions").select("list_id,key").eq("active", true).eq("contract_eligible", true)),
  ]);
  // Samma regel som `is_contract_call_eligible`: ett listsamtal följer sin egen
  // listas utfall, ett manuellt samtal företagets inställning. En gemensam
  // mängd visade "Skapa avtal" för samtal databasen sedan vägrade.
  const manualEligible = new Set((await manualContractDispositions(supabase, context.tenantId)).map((item) => item.key));
  const listEligible = new Set((eligibleRows ?? []).map((row) => `${row.list_id}:${row.key}`));
  const isEligible = (call: { list_id: string | null; disposition: string | null }) => Boolean(call.disposition) && (
    call.list_id ? listEligible.has(`${call.list_id}:${call.disposition}`) : manualEligible.has(String(call.disposition)));

  return <>
    <PageHeader title="Mina samtal" description="Dina samtal och deras utfall." />
    {/* The action used to fail silently in both directions: a refusal had nowhere
        to be shown, and a success looked the same as a no-op. */}
    {params.error ? <p className="form-error">{params.error}</p> : null}
    {params.message ? <p className="notice">{params.message}</p> : null}
    <Card><CardHeader><h2><Headphones size={17} /> Samtal</h2><Badge>{data?.length ?? 0}</Badge></CardHeader><CardContent style={{ padding: 0 }}>
      <DataTable headers={["Kund", "Samtal", "Utfall", "Tid", ""]}>
        {data?.map((call) => {
          const customer = Array.isArray(call.customers) ? call.customers[0] : call.customers;
          const contractEligible = call.status === "completed" && call.answered_at && call.ended_at && isEligible(call);
          return <tr key={call.id}>
            <td><Link href={`/app/calls/${call.id}`}><strong>{customer?.display_name ?? call.to_number}</strong></Link></td>
            <td><Badge className={call.status === "completed" ? "badge-success" : "badge-info"}>{callStatusLabel(call.status)}</Badge>{call.direction === "inbound" ? <><br /><span className="muted">Inkommande</span></> : null}</td>
            <td>{dispositionLabel(call.disposition)}{call.metadata && typeof call.metadata === "object" && (call.metadata as Record<string, unknown>).registered_manually === true ? <><br /><span className="muted">Manuellt registrerat</span></> : null}</td>
            <td>{formatDate(call.created_at)}</td>
            <td>{call.disposition ? <div className="toolbar-left"><span>Klart</span>{contractEligible && call.customer_id ? <Link className="button button-secondary button-sm" href={`/app/contracts/new?customer_id=${call.customer_id}&source_call_id=${call.id}`}>Skapa avtal</Link> : null}</div> : mayLog ? <details open={Boolean(params.error && params.call === call.id)}><summary className="button button-secondary button-sm">Registrera utfall</summary><form action={setCallDisposition} className="form-stack" style={{ marginTop: 8, minWidth: 220 }}>
              <input type="hidden" name="call_id" value={call.id} />
              {/* Exactly the set complete_manual_call_work accepts. "Avtal ska
                  skickas" is gone because the database refuses it — the contract
                  button appears on "Intresserad" anyway. */}
              <select name="disposition" aria-label="Samtalsresultat" required>
                <option value="">Resultat</option>
                <option value="interested">Intresserad</option>
                <option value="callback">Ring senare</option>
                <option value="not_interested">Inte intresserad</option>
                <option value="no_answer">Inget svar</option>
                <option value="busy">Upptaget</option>
                <option value="voicemail">Telefonsvarare</option>
                <option value="wrong_number">Fel nummer</option>
                <option value="do_not_call">Ring inte igen</option>
                <option value="nix_listed">Nixat nummer</option>
              </select>
              <Field label="" name="notes" placeholder="Anteckning" />
              {/* A callback needs a time and a queue; the old form invented
                  "+24 timmar, personlig" without asking. */}
              <input type="datetime-local" name="callback_due_at" aria-label="Tidpunkt för återkomst" />
              <select name="callback_scope" aria-label="Återkomsttyp" defaultValue="personal">
                <option value="personal">Personlig återkomst</option>
                <option value="global">Global teamkö</option>
              </select>
              <button className="button button-primary button-sm">Spara</button>
            </form></details> : <span className="muted">Väntar på efterarbete</span>}</td>
          </tr>;
        })}
      </DataTable>
    </CardContent></Card>
  </>;
}
