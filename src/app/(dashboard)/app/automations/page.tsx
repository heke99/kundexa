import { Bot, Plus } from "@/components/icons";
import { createClient } from "@/lib/supabase/server";
import { activateAutomation, createAutomation, pauseAutomation } from "@/app/actions/admin";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { Badge } from "@/components/ui/badge";
import { Field, SelectField, TextareaField } from "@/components/ui/form-field";

type AutomationVersion = { version: number; test_mode: boolean; actions: Array<{ type?: string }> };

export default async function AutomationsPage() {
  const supabase = await createClient();
  const { data } = await supabase.from("automation_rules")
    .select("*,automation_versions(version,test_mode,actions)")
    .order("created_at", { ascending: false });

  return <>
    <PageHeader title="Automatiseringar" description="Databasdrivna triggers, testläge, fördröjningar, idempotenta åtgärder, spärrkontroll och felkö." />
    <div className="split-layout">
      <Card>
        <CardHeader><h2><Bot size={17} /> Regelverk</h2><Badge>{data?.length ?? 0}</Badge></CardHeader>
        <CardContent style={{ padding: 0 }}>
          <DataTable headers={["Automation", "Trigger", "Version", "Status", "Testläge", "Styrning"]}>
            {data?.map((automation) => {
              const versions = (Array.isArray(automation.automation_versions) ? automation.automation_versions : []) as AutomationVersion[];
              const current = [...versions].sort((a, b) => b.version - a.version)[0];
              return <tr key={automation.id}>
                <td><strong>{automation.name}</strong><br /><small>{current?.actions?.map((action) => action.type).join(", ") || "Ingen åtgärd"}</small></td>
                <td><code>{automation.trigger_key}</code></td>
                <td>{automation.current_version}</td>
                <td><Badge className={automation.status === "active" ? "badge-success" : "badge-warning"}>{automation.status}</Badge></td>
                <td>{current?.test_mode ? "Ja" : "Nej"}</td>
                <td>
                  {automation.status === "active" ?
                    <form action={pauseAutomation}><input type="hidden" name="automation_id" value={automation.id} /><button className="button button-secondary" type="submit">Pausa</button></form> :
                    <form action={activateAutomation}><input type="hidden" name="automation_id" value={automation.id} /><button className="button button-primary" type="submit">Godkänn och aktivera</button></form>}
                </td>
              </tr>;
            })}
          </DataTable>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><h2><Plus size={16} /> Ny regel</h2></CardHeader>
        <CardContent>
          <form action={createAutomation} className="form-stack">
            <Field label="Namn" name="name" required />
            <SelectField label="Trigger" name="trigger_key" required>
              <option value="customer.created">Ny kund skapad</option>
              <option value="call.completed">Samtal avslutat</option>
              <option value="call.no_answer">Inget svar</option>
              <option value="call.busy">Upptaget</option>
              <option value="contract.sent">Avtal skickat</option>
              <option value="contract.accepted">Avtal accepterat</option>
              <option value="contract.signed">Avtal signerat</option>
              <option value="customer.blocked">Kund spärrad</option>
            </SelectField>
            <Field label="Fördröjning i minuter" name="delay_minutes" type="number" min="0" defaultValue="0" />
            <SelectField label="Första åtgärd" name="action_type" required>
              <option value="create_activity">Skapa aktivitet</option>
              <option value="send_sms">Skicka SMS</option>
              <option value="send_email">Skicka e-post</option>
              <option value="update_status">Ändra kundstatus</option>
              <option value="block_contact">Stoppa kontakt</option>
            </SelectField>
            <Field label="Rubrik/ämnesrad" name="action_title" placeholder="Automatiserad uppföljning" />
            <Field label="E-postämne" name="action_subject" placeholder="Vi följer upp" />
            <TextareaField label="Meddelande eller beskrivning" name="action_body" placeholder="Hej {{customer}}, ..." rows={4} />
            <button className="button button-primary"><Bot size={16} /> Skapa i testläge</button>
          </form>
          <div className="notice warning" style={{ marginTop: 16 }}>Regeln skapas alltid som draft och simuleras tills en administratör uttryckligen aktiverar den.</div>
        </CardContent>
      </Card>
    </div>
  </>;
}
