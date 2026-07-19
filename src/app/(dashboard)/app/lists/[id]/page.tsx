import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ListFilter, PhoneCall, Settings, Users } from "@/components/icons";
import { addCustomersToList, materializeSegmentToList, setCustomerListSellers, updateCustomerList, updateCustomerListSellerAssignment, upsertListDisposition } from "@/app/actions/lists";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { Field, SelectField, TextareaField } from "@/components/ui/form-field";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
import { isoToZonedLocalDateTime } from "@/lib/domain/time";

export default async function ListDetailPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; saved?: string; imported?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const supabase = await createClient();
  // Kandidatstatus och medlemsantal aggregeras i databasen i stället för att hämta alla rader.
  const [{ data: list }, { data: mayManage }, { data: members }, { data: assignments }, { data: memberships }, { data: teamMembers }, { data: customers }, { data: dispositions }, { data: segments }, { data: candidateCounts }, { data: listOverview }, { data: phoneNumbers }] = await Promise.all([
    supabase.from("customer_lists").select("*").eq("id", id).single(),
    supabase.rpc("can_manage_customer_list", { p_list_id: id }),
    supabase.from("customer_list_members").select("id,customer_id,assigned_user_id,state,attempts,outcome,next_attempt_at,customers(display_name,phone_e164,city,do_not_call)").eq("list_id", id).order("priority", { ascending: false }).limit(500),
    supabase.from("customer_list_seller_assignments").select("user_id,status,weight,daily_capacity,starts_at,ends_at").eq("list_id", id),
    supabase.from("tenant_memberships").select("user_id,role,status,profiles:user_id(full_name)").eq("status", "active").in("role", ["owner", "admin", "team_lead", "sales"]),
    supabase.from("team_members").select("team_id,user_id"),
    supabase.from("customers").select("id,display_name,phone_e164,city,lifecycle").in("lifecycle", ["prospect", "lead", "customer"]).is("deleted_at", null).order("updated_at", { ascending: false }).limit(500),
    supabase.from("list_dispositions").select("key,label,outcome_group,terminal,retry_after_minutes,requires_callback,requires_order").eq("list_id", id).eq("active", true).order("sort_order"),
    supabase.from("segments").select("id,name,segment_type,last_refreshed_at").eq("active", true).order("name"),
    supabase.rpc("customer_list_candidate_counts", { p_list_id: id }),
    supabase.rpc("customer_list_overview", { p_list_id: id }),
    supabase.from("phone_numbers").select("id,number_e164").eq("status", "active").eq("supports_voice", true).order("number_e164"),
  ]);
  if (!list) notFound();
  const memberStats = (listOverview?.[0] ?? { total_members: members?.length ?? 0, open_members: 0, active_sellers: 0 }) as { total_members: number; open_members: number; active_sellers: number };
  const policyCounts = (candidateCounts ?? { approved: 0, pendingNix: 0, blocked: 0, pending: 0 }) as { approved: number; pendingNix: number; blocked: number; pending: number };
  const selectedSellers = new Set((assignments ?? []).filter((item) => item.status === "active").map((item) => item.user_id));
  const teamUserIds = list.team_id ? new Set((teamMembers ?? []).filter((item) => item.team_id === list.team_id).map((item) => item.user_id)) : null;
  const availableSellers = (memberships ?? []).filter((member) => !teamUserIds || teamUserIds.has(member.user_id));
  const sellerNames = new Map(availableSellers.map((member) => { const profile=Array.isArray(member.profiles)?member.profiles[0]:member.profiles; return [member.user_id,profile?.full_name??member.user_id]; }));
  const existingCustomerIds = new Set((members ?? []).map((member) => member.customer_id));
  const sellerWorkload = new Map<string, number>();
  for (const member of members ?? []) if (member.assigned_user_id && !["completed", "blocked"].includes(member.state)) sellerWorkload.set(member.assigned_user_id, (sellerWorkload.get(member.assigned_user_id) ?? 0) + 1);
  const settings = list.settings && typeof list.settings === "object" && !Array.isArray(list.settings) ? list.settings as Record<string, unknown> : {};
  const allowedDays = new Set(list.allowed_days ?? [1, 2, 3, 4, 5]);

  return <>
    <Link href="/app/lists" className="muted back-link"><ArrowLeft size={15} /> Till listor</Link>
    <PageHeader title={list.name} description={`${list.list_type} · ${list.dialing_mode === "automatic" ? "automatisk sekventiell dialer" : "manuell ringning"}`} action={list.status === "active" ? <Link className="button button-primary" href={`/app/dialer/lists/${id}`}><PhoneCall size={16} /> Öppna ringsession</Link> : <Badge>{list.status}</Badge>} />
    {query.error ? <p className="form-error">{query.error}</p> : null}
    {query.saved ? <div className="notice" style={{ marginBottom: 16 }}>Listan är uppdaterad och synkroniserad med säljarvyn.</div> : null}
    {query.imported ? <div className="notice" style={{ marginBottom: 16 }}>Prospekteringen är synkroniserad: {query.imported}</div> : null}
    <div className="grid grid-4" style={{ marginBottom: 18 }}>
      <Card><CardContent><strong>{Number(memberStats.total_members)}</strong><div className="muted">Prospekt totalt</div></CardContent></Card>
      <Card><CardContent><strong>{Number(memberStats.open_members)}</strong><div className="muted">Kvar att bearbeta</div></CardContent></Card>
      <Card><CardContent><strong>{selectedSellers.size}</strong><div className="muted">Aktiva säljare</div></CardContent></Card>
      <Card><CardContent><strong>{String(list.allowed_start_time).slice(0, 5)}–{String(list.allowed_end_time).slice(0, 5)}</strong><div className="muted">Tillåten ringtid</div></CardContent></Card>
    </div>
    <div className="split-layout">
      <div className="grid">
        <Card>
          <CardHeader><h2><ListFilter size={17} /> Listmedlemmar</h2><Badge>{members?.length ?? 0}</Badge></CardHeader>
          <CardContent style={{ padding: 0 }}><DataTable headers={["Prospekt", "Telefon", "Ort", "Status", "Försök", "Nästa", "Utfall"]}>
            {members?.map((member) => {
              const customer = Array.isArray(member.customers) ? member.customers[0] : member.customers;
              return <tr key={member.id}><td><Link href={`/app/customers/${member.customer_id}`}><strong>{customer?.display_name ?? "Okänt prospekt"}</strong></Link></td><td>{customer?.phone_e164 ?? "—"}</td><td>{customer?.city ?? "—"}</td><td><Badge className={member.state === "completed" ? "badge-success" : member.state === "blocked" ? "badge-danger" : ""}>{member.state}</Badge></td><td>{member.attempts}</td><td>{formatDate(member.next_attempt_at)}</td><td>{member.outcome ?? "—"}</td></tr>;
            })}
          </DataTable></CardContent>
        </Card>
        <Card>
          <CardHeader><h2>Samtalsutfall</h2><Badge>{dispositions?.length ?? 0}</Badge></CardHeader>
          <CardContent style={{ padding: 0 }}><DataTable headers={["Utfall", "Grupp", "Nästa steg"]}>
            {dispositions?.map((item) => <tr key={item.key}><td><strong>{item.label}</strong><br /><code>{item.key}</code></td><td>{item.outcome_group}</td><td>{item.requires_order ? "Skapa order" : item.requires_callback ? "Boka återkomst" : item.retry_after_minutes ? `Försök igen efter ${item.retry_after_minutes} min` : item.terminal ? "Avsluta listpost" : "Fortsätt"}</td></tr>)}
          </DataTable></CardContent>
        </Card>
      </div>
      {mayManage ? <div className="grid">
        <Card>
          <CardHeader><h3><Settings size={16} /> Listinställningar</h3></CardHeader>
          <CardContent><form action={updateCustomerList} className="form-stack">
            <input type="hidden" name="list_id" value={id} />
            <Field label="Namn" name="name" defaultValue={list.name} required />
            <TextareaField label="Beskrivning" name="description" defaultValue={list.description ?? ""} />
            <div className="form-grid">
              <SelectField label="Status" name="status" defaultValue={list.status}><option value="draft">Utkast</option><option value="active">Aktiv</option><option value="paused">Pausad</option><option value="completed">Avslutad</option><option value="archived">Arkiverad</option></SelectField>
              <SelectField label="Ringläge" name="dialing_mode" defaultValue={list.dialing_mode}><option value="manual">Manuellt</option><option value="automatic">Automatiskt</option></SelectField>
              <SelectField label="Återkomster" name="callback_policy" defaultValue={list.callback_policy}><option value="both">Personliga och globala</option><option value="personal">Personliga</option><option value="global">Globala</option></SelectField>
              <Field label="Prioritet" name="priority" type="number" defaultValue={list.priority} />
              <Field label="Ring från" name="start_time" type="time" defaultValue={String(list.allowed_start_time).slice(0, 5)} />
              <Field label="Ring till" name="end_time" type="time" defaultValue={String(list.allowed_end_time).slice(0, 5)} />
              <Field label="Tidszon" name="timezone" defaultValue={list.timezone} placeholder="Europe/Stockholm" required />
              <SelectField label="Utgående nummer" name="outbound_phone_number_id" defaultValue={list.outbound_phone_number_id ?? ""}><option value="">Tenantens standardnummer</option>{phoneNumbers?.map((number) => <option key={number.id} value={number.id}>{number.number_e164}</option>)}</SelectField>
              <Field label="Liststart (valfritt)" name="starts_at" type="datetime-local" defaultValue={isoToZonedLocalDateTime(list.starts_at, list.timezone)} />
              <Field label="Listslut (valfritt)" name="ends_at" type="datetime-local" defaultValue={isoToZonedLocalDateTime(list.ends_at, list.timezone)} />
              <Field label="Max försök" name="max_attempts" type="number" min="1" max="100" defaultValue={list.max_attempts} />
              <Field label="Försök igen, minuter" name="retry_delay_minutes" type="number" min="1" defaultValue={list.retry_delay_minutes} />
              <Field label="Automatisk paus, sekunder" name="auto_next_delay_seconds" type="number" min="0" max="300" defaultValue={list.auto_next_delay_seconds} />
            </div>
            <fieldset className="form-section"><legend>Tillåtna ringdagar</legend><div className="toolbar-left">{[[1, "Mån"], [2, "Tis"], [3, "Ons"], [4, "Tor"], [5, "Fre"], [6, "Lör"], [7, "Sön"]].map(([day, label]) => <label className="check-row" key={day}><input type="checkbox" name="allowed_days" value={day} defaultChecked={allowedDays.has(Number(day))} /> {label}</label>)}</div></fieldset>
            <TextareaField label="Samtalsmanus" name="script" defaultValue={list.script ?? ""} />
            <label className="check-row"><input type="checkbox" name="allow_skip" defaultChecked={list.allow_skip} /> Säljare får hoppa över</label>
            <label className="check-row"><input type="checkbox" name="allow_browse" defaultChecked={list.allow_browse} /> Säljare får bläddra</label>
            <label className="check-row"><input type="checkbox" name="lock_to_seller" defaultChecked={list.lock_to_seller} /> Lås bearbetat prospekt till säljaren</label>
            <label className="check-row"><input type="checkbox" name="recording_enabled" defaultChecked={settings.recordingEnabled === true} /> Spela in samtal enligt tenantens policy och retention</label>
            <button className="button button-primary">Spara inställningar</button>
          </form></CardContent>
        </Card>
        <Card>
          <CardHeader><h3><ListFilter size={16} /> Prospektering till lista</h3></CardHeader>
          <CardContent><form action={materializeSegmentToList} className="form-stack">
            <input type="hidden" name="list_id" value={id} />
            <SelectField label="Sparat prospekteringssegment" name="segment_id" defaultValue="" required>
              <option value="" disabled>Välj segment</option>
              {segments?.map((segment) => <option key={segment.id} value={segment.id}>{segment.name} · {segment.segment_type === "dynamic" ? "dynamiskt" : "ögonblicksbild"}</option>)}
            </SelectField>
            <p className="muted">Filtret körs mot den befintliga katalogen. Godkända träffar blir kanoniska kundkort och listmedlemmar; spärrade träffar rings aldrig.</p>
            <div className="muted">Policyresultat: {Number(policyCounts.approved)} godkända · {Number(policyCounts.pendingNix)} inväntar NIX · {Number(policyCounts.blocked)} blockerade</div>
            <button className="button button-secondary" disabled={!segments?.length}>Kör segment och synkronisera</button>
          </form></CardContent>
        </Card>
        <Card>
          <CardHeader><h3><Users size={16} /> Tilldela säljare</h3></CardHeader>
          <CardContent><form action={setCustomerListSellers} className="form-stack"><input type="hidden" name="list_id" value={id} />
            <div className="selection-list">{availableSellers.map((member) => {
              const profile = Array.isArray(member.profiles) ? member.profiles[0] : member.profiles;
              return <label className="check-row" key={member.user_id}><input type="checkbox" name="seller_ids" value={member.user_id} defaultChecked={selectedSellers.has(member.user_id)} /><span><strong>{profile?.full_name ?? "Användare"}</strong><small>{member.role} · {sellerWorkload.get(member.user_id) ?? 0} låsta/återstående prospekt</small></span></label>;
            })}</div>
            <button className="button button-secondary">Synkronisera säljare</button>
          </form>{assignments?.length ? <details className="assignment-settings"><summary>Pausa, tidsstyr eller kapacitetsbegränsa säljare</summary><div className="grid">{assignments.map((assignment) => <form action={updateCustomerListSellerAssignment} className="form-section form-stack" key={assignment.user_id}><strong>{sellerNames.get(assignment.user_id) ?? assignment.user_id}</strong><input type="hidden" name="list_id" value={id}/><input type="hidden" name="user_id" value={assignment.user_id}/><input type="hidden" name="timezone" value={list.timezone}/><div className="form-grid"><SelectField label="Status" name="status" defaultValue={assignment.status}><option value="active">Aktiv</option><option value="paused">Pausad</option><option value="ended">Avslutad</option></SelectField><Field label="Vikt" name="weight" type="number" min="1" max="10000" defaultValue={assignment.weight}/><Field label="Daglig kapacitet" name="daily_capacity" type="number" min="1" defaultValue={assignment.daily_capacity??""}/><Field label="Start" name="starts_at" type="datetime-local" defaultValue={isoToZonedLocalDateTime(assignment.starts_at,list.timezone)}/><Field label="Slut" name="ends_at" type="datetime-local" defaultValue={isoToZonedLocalDateTime(assignment.ends_at,list.timezone)}/></div><button className="button button-secondary button-sm">Spara tilldelning</button></form>)}</div></details> : null}</CardContent>
        </Card>
        <Card>
          <CardHeader><h3>Lägg till prospekt</h3></CardHeader>
          <CardContent><form action={addCustomersToList} className="form-stack"><input type="hidden" name="list_id" value={id} />
            <label className="field"><span>Prospekt och kunder</span><select name="customer_ids" multiple size={10}>{customers?.filter((customer) => !existingCustomerIds.has(customer.id)).map((customer) => <option key={customer.id} value={customer.id}>{customer.display_name} · {customer.phone_e164 ?? "telefon saknas"} · {customer.city ?? "ort saknas"}</option>)}</select><small>Markera flera med Cmd/Ctrl.</small></label>
            <button className="button button-secondary">Lägg till valda</button>
          </form></CardContent>
        </Card>
        <Card>
          <CardHeader><h3>Nytt eller uppdaterat samtalsutfall</h3></CardHeader>
          <CardContent><form action={upsertListDisposition} className="form-stack"><input type="hidden" name="list_id" value={id} /><div className="form-grid"><Field label="Nyckel" name="key" placeholder="offer_sent" required /><Field label="Namn" name="label" placeholder="Offert skickad" required /><SelectField label="Grupp" name="outcome_group" defaultValue="neutral"><option value="positive">Positivt</option><option value="neutral">Neutralt</option><option value="negative">Negativt</option><option value="unreachable">Ej nådd</option><option value="blocked">Spärr</option></SelectField><Field label="Nytt försök efter minuter" name="retry_after_minutes" type="number" min="1" /></div><label className="check-row"><input type="checkbox" name="terminal" /> Avslutar listposten</label><label className="check-row"><input type="checkbox" name="requires_note" /> Kräver anteckning</label><label className="check-row"><input type="checkbox" name="requires_callback" /> Kräver återkomst</label><label className="check-row"><input type="checkbox" name="requires_order" /> Kräver order</label><button className="button button-secondary">Spara samtalsutfall</button></form></CardContent>
        </Card>
      </div> : null}
    </div>
  </>;
}
