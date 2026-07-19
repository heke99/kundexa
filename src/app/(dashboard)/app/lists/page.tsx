import Link from "next/link";
import { ListFilter, Plus, Users, PhoneCall } from "@/components/icons";
import { createCustomerList } from "@/app/actions/lists";
import { getAppContext } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { Field, SelectField, TextareaField } from "@/components/ui/form-field";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";

export default async function ListsPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const params = await searchParams;
  const context = await getAppContext();
  const supabase = await createClient();
  const [{ data: lists }, { data: members }, { data: sellers }, { data: teams }] = await Promise.all([
    supabase.from("customer_lists").select("*").order("priority", { ascending: false }).order("created_at", { ascending: false }),
    supabase.from("customer_list_members").select("list_id,state"),
    supabase.from("customer_list_seller_assignments").select("list_id,status"),
    supabase.from("teams").select("id,name").order("name"),
  ]);
  const memberCounts = new Map<string, { total: number; open: number }>();
  for (const row of members ?? []) {
    const current = memberCounts.get(row.list_id) ?? { total: 0, open: 0 };
    current.total += 1;
    if (!["completed", "blocked"].includes(row.state)) current.open += 1;
    memberCounts.set(row.list_id, current);
  }
  const sellerCounts = new Map<string, number>();
  for (const row of sellers ?? []) if (row.status === "active") sellerCounts.set(row.list_id, (sellerCounts.get(row.list_id) ?? 0) + 1);
  const teamNames = new Map((teams ?? []).map((team) => [team.id, team.name]));
  const mayManage = can(context.role, "lists.manage");

  return <>
    <PageHeader title="Prospekterings- och ringlistor" description="En gemensam listmotor för säljtilldelning, manuella flöden, automatisk sekventiell ringning och återkomster." />
    {params.error ? <p className="form-error">{params.error}</p> : null}
    <div className={mayManage ? "split-layout" : "grid"}>
      <Card>
        <CardHeader><h2><ListFilter size={17} /> Tillgängliga listor</h2><Badge>{lists?.length ?? 0}</Badge></CardHeader>
        <CardContent style={{ padding: 0 }}>
          <DataTable headers={["Lista", "Läge", "Team", "Säljare", "Kvar", "Status", "Skapad"]}>
            {lists?.map((list) => {
              const counts = memberCounts.get(list.id) ?? { total: 0, open: 0 };
              return <tr key={list.id}>
                <td><Link href={`/app/lists/${list.id}`}><strong>{list.name}</strong></Link><br /><span className="muted">{list.description ?? list.list_type}</span></td>
                <td><Badge className={list.dialing_mode === "automatic" ? "badge-info" : ""}>{list.dialing_mode === "automatic" ? "Automatisk" : "Manuell"}</Badge></td>
                <td>{list.team_id ? teamNames.get(list.team_id) ?? "Team" : "Organisation"}</td>
                <td><Users size={14} /> {sellerCounts.get(list.id) ?? 0}</td>
                <td>{counts.open} / {counts.total}</td>
                <td><Badge className={list.status === "active" ? "badge-success" : list.status === "paused" ? "badge-warning" : ""}>{list.status}</Badge></td>
                <td>{formatDate(list.created_at)}<br />{list.status === "active" ? <Link className="muted" href={`/app/dialer/lists/${list.id}`}><PhoneCall size={13} /> Ring</Link> : null}</td>
              </tr>;
            })}
          </DataTable>
          {!lists?.length ? <div className="empty-state"><ListFilter size={30} /><h3>Inga listor ännu</h3><p>En teamadministratör skapar listan, tilldelar säljare och aktiverar den.</p></div> : null}
        </CardContent>
      </Card>
      {mayManage ? <Card>
        <CardHeader><h2><Plus size={16} /> Ny lista</h2></CardHeader>
        <CardContent>
          <form action={createCustomerList} className="form-stack">
            <Field label="Listnamn" name="name" required />
            <TextareaField label="Beskrivning" name="description" />
            <div className="form-grid">
              <SelectField label="Listtyp" name="list_type" defaultValue="static">
                <option value="static">Statisk lista</option><option value="dynamic">Dynamisk lista</option><option value="campaign">Kampanjlista</option>
                <option value="personal">Personlig lista</option><option value="callback">Återkomstlista</option><option value="renewal">Förnyelselista</option>
                <option value="import">Importlista</option><option value="upsell">Tidigare kunder / merförsäljning</option><option value="missed_calls">Missade inkommande samtal</option>
              </SelectField>
              <SelectField label="Team" name="team_id" defaultValue=""><option value="">Hela organisationen</option>{teams?.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</SelectField>
              <SelectField label="Ringläge" name="dialing_mode" defaultValue="manual"><option value="manual">Manuellt, en i taget</option><option value="automatic">Automatiskt efter efterarbete</option></SelectField>
              <SelectField label="Återkomster" name="callback_policy" defaultValue="both"><option value="both">Personliga och globala</option><option value="personal">Endast personliga</option><option value="global">Endast globala</option></SelectField>
              <Field label="Ring från" name="start_time" type="time" defaultValue="09:00" />
              <Field label="Ring till" name="end_time" type="time" defaultValue="18:00" />
              <Field label="Max försök" name="max_attempts" type="number" min="1" max="100" defaultValue="7" />
              <Field label="Nytt försök efter minuter" name="retry_delay_minutes" type="number" min="1" defaultValue="1440" />
              <Field label="Automatisk paus i sekunder" name="auto_next_delay_seconds" type="number" min="0" max="300" defaultValue="4" />
              <Field label="Prioritet" name="priority" type="number" min="0" max="10000" defaultValue="100" />
            </div>
            <TextareaField label="Samtalsmanus" name="script" />
            <label className="check-row"><input type="checkbox" name="allow_skip" defaultChecked /> Säljaren får hoppa över en post</label>
            <label className="check-row"><input type="checkbox" name="allow_browse" /> Säljaren får bläddra fritt i listan</label>
            <button className="button button-primary"><Plus size={15} /> Skapa och konfigurera</button>
          </form>
        </CardContent>
      </Card> : null}
    </div>
  </>;
}
