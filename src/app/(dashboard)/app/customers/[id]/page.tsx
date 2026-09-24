import { ok } from "@/lib/supabase/read";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Ban, CalendarPlus, ClipboardList, FileSignature, Mail, MessageSquareText, Phone, PhoneOff, StickyNote, Users } from "@/components/icons";
import { addActivity, addNote, archiveNote, blockCustomer, reportCustomerNix, scheduleCallback, updateCustomerDetails, updateNote } from "@/app/actions/customers";
import { getAppContext } from "@/lib/auth";
import { manualContractDispositions } from "@/lib/contracts/manual-dispositions";
import { contractStatusLabel } from "@/lib/contracts/status-labels";
import { callStatusLabel, dispositionLabel, lifecycleLabel, noteTypeLabel, visibilityLabel } from "@/lib/ui/labels";
import { can, canCreateContractFromProduct } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DialerPanel } from "@/components/dialer-panel";
import { Field, SelectField, TextareaField } from "@/components/ui/form-field";
import { formatCurrency, formatDate, initials } from "@/lib/utils";

export default async function CustomerDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; message?: string; callback?: string; note?: string }> }) {
  const { id } = await params;
  const query = await searchParams;
  const context = await getAppContext();
  // `customers.read` opens the card; every write block below has its own
  // permission. Avtalsansvarig, kvalitet, ekonomi and viewer could reach all
  // of them and none would have been accepted.
  const mayWrite = can(context.role, "customers.write");
  const mayCall = can(context.role, "calls.create");
  const isSeller = context.role === "sales";
  const mayScheduleCallback = can(context.role, "callbacks.create");
  // Samma regel som avtalssidan. Knappen stod kvar på den gamla rättigheten och
  // hade visat sig för en säljare som sedan nekats på sidan bakom -- en knapp
  // som leder till ett nej är ett sämre besked än ingen knapp.
  const mayCreateContract = canCreateContractFromProduct(context.role, context.platformRole);
  const supabase = await createClient();
  const contractDispositionKeys = (await manualContractDispositions(supabase, context.tenantId)).map((item) => item.key);
  const [{ data: customer }, { data: contacts }, { data: notes }, { data: activities }, { data: calls }, { data: contracts }, { data: deals }, { data: orders }, { data: lists }, { data: callerIdData }] = await Promise.all([
    ok(supabase.from("customers").select("*").eq("id", id).single()),
    ok(supabase.from("contact_people").select("id,full_name,title,role,email,phone_e164,alternate_phone_e164,is_primary,is_signatory,source_external_id").eq("customer_id", id).order("is_primary", { ascending: false }).order("full_name")),
    ok(supabase.from("notes").select("id,body,is_pinned,visibility,note_type,created_by,created_at,profiles:created_by(full_name)").eq("customer_id", id).is("archived_at", null).order("is_pinned", { ascending: false }).order("created_at", { ascending: false }).limit(30)),
    ok(supabase.from("activities").select("id,title,description,status,callback_scope,due_at,created_at").eq("customer_id", id).order("created_at", { ascending: false }).limit(30)),
    ok(supabase.from("calls").select("id,direction,status,disposition,duration_seconds,created_at").eq("customer_id", id).order("created_at", { ascending: false }).limit(15)),
    ok(supabase.from("contracts").select("id,contract_number,title,status,value,currency").eq("customer_id", id).order("created_at", { ascending: false }).limit(10)),
    ok(supabase.from("deals").select("id,name,status,probability,value,currency").eq("customer_id", id).order("created_at", { ascending: false })),
    ok(supabase.from("sales_orders").select("id,order_number,status,total,currency,created_at").eq("customer_id", id).order("created_at", { ascending: false })),
    ok(supabase.from("customer_lists").select("id,name,callback_policy,status").eq("status", "active").order("name")),
    ok(supabase.rpc("caller_id_options_for_current_user")),
  ]);
  if (!customer) notFound();
  // The card is the canonical CRM record, so the person actually responsible has to be
  // named on it. `assigned_user_id` alone said only "Tilldelad användare".
  const { data: owner } = customer.assigned_user_id
    ? await supabase.from("profiles").select("full_name").eq("id", customer.assigned_user_id).maybeSingle()
    : { data: null };
  const ownerName = owner?.full_name ?? (customer.assigned_user_id ? "Tilldelad användare" : "Ej tilldelad");
  return <>
    <Link href="/app/customers" className="muted back-link"><ArrowLeft size={15} /> Till kunder</Link>
    <PageHeader title={customer.display_name} description={`${customer.customer_type === "company" ? "Företag" : "Privatperson"} · ${lifecycleLabel(customer.lifecycle)}`} action={<div className="toolbar-right">{mayCall && customer.phone_e164 && !customer.do_not_call
      ? <a className="button button-primary" href="#kundkort-dialer"><Phone size={16} /> Ring {customer.phone_e164}</a>
      : mayCall ? <span className="badge badge-warning">{customer.do_not_call ? "Spärrad för samtal" : "Telefonnummer saknas"}</span> : null}{mayCreateContract ? <Link className="button button-secondary" href={`/app/contracts/new?customer_id=${customer.id}`}><FileSignature size={16} /> Skapa avtal</Link> : null}<Link className="button button-ghost" href={`/app/sms?customer=${customer.id}`}><MessageSquareText size={16} /> SMS</Link><Link className="button button-ghost" href={`/app/email?customer=${customer.id}`}><Mail size={16} /> E-post</Link></div>} />
    {query.error ? <p className="form-error">{query.error}</p> : null}
    {query.message ? <div className="notice" style={{ marginBottom: 16 }}>{query.message}</div> : null}
    {query.callback ? <div className="notice" style={{ marginBottom: 16 }}>Återkomsten är skapad och syns i säljarens eller teamets återkomstkö.</div> : null}
    {query.note ? <div className="notice" style={{ marginBottom: 16 }}>Anteckningen är {query.note === "archived" ? "arkiverad med revisionsspåret bevarat" : "uppdaterad och tidigare version historikförd"}.</div> : null}
    <div className="split-layout">
      <div className="grid">
        <Card><CardHeader><div className="detail-title"><span className="avatar">{initials(customer.display_name)}</span><div><h2>{customer.display_name}</h2><span className="muted">{customer.organization_number ?? customer.personal_identity_number ?? "Identifiering saknas"}</span></div></div><div className="toolbar-right"><Badge>{customer.organization_number || customer.personal_identity_number ? "Identifierad" : "Ofullständig"}</Badge><Badge className={customer.do_not_call ? "badge-danger" : "badge-success"}>{customer.do_not_call ? "Spärrad" : "Kontakt tillåten"}</Badge></div></CardHeader><CardContent><dl className="key-value"><dt>Telefon</dt><dd>{customer.phone_e164 ?? "—"}</dd><dt>E-post</dt><dd>{customer.email ?? "—"}</dd><dt>Adress</dt><dd>{[customer.address_line1, customer.postal_code, customer.city].filter(Boolean).join(", ") || "—"}</dd><dt>Bransch / SNI</dt><dd>{[customer.industry, customer.sni_code].filter(Boolean).join(" · ") || "—"}</dd><dt>Ansvarig</dt><dd>{ownerName}</dd><dt>Datakälla</dt><dd>{customer.source_name ?? "Manuellt skapad"}</dd><dt>Rättslig grund</dt><dd>{customer.legal_basis ?? "Ej dokumenterad"}</dd><dt>Ringförsök</dt><dd>{customer.call_attempts}</dd></dl>
            {/* Uppgifterna och redigeringen i samma kort. Två kort, där det andra
                bara innehöll knappen "Redigera", tog plats utan att visa något. */}
            {mayWrite ? <details open={Boolean(query.error)} style={{ marginTop: 14 }}><summary className="button button-secondary button-sm">Redigera kunduppgifter</summary><form action={updateCustomerDetails} className="form-grid" style={{ marginTop: 12 }}>
              <input type="hidden" name="customer_id" value={customer.id} />
              <Field label="Namn" name="display_name" defaultValue={customer.display_name} required hint="Visas som kundkortets rubrik." />
              <Field label="Företagsnamn" name="company_name" defaultValue={customer.company_name ?? ""} />
              <SelectField label="Kundtyp" name="customer_type" defaultValue={customer.customer_type}>
                <option value="company">Företag</option>
                <option value="person">Privatperson</option>
              </SelectField>
              <Field
                label="Organisationsnummer"
                name="organization_number"
                defaultValue={customer.organization_number ?? ""}
                placeholder="556016-0680"
              />
              <Field
                label="Personnummer"
                name="personal_identity_number"
                defaultValue={customer.personal_identity_number ?? ""}
                placeholder="ÅÅÅÅMMDD-XXXX"
                hint="Bara för privatpersoner."
              />
              {isSeller || customer.lifecycle === "blocked"
                ? <><input type="hidden" name="lifecycle" value={customer.lifecycle} />{customer.lifecycle === "blocked" ? <p className="muted">Kunden är spärrad. Spärren hävs under Spärrar, inte här.</p> : null}</>
                : <SelectField label="Kundstatus" name="lifecycle" defaultValue={customer.lifecycle}>
                <option value="prospect">Prospekt</option>
                <option value="lead">Lead</option>
                <option value="customer">Kund</option>
                <option value="former_customer">Tidigare kund</option>
                <option value="lost">Förlorad</option>
              </SelectField>}
              <Field label="Telefon" name="phone" type="tel" defaultValue={customer.phone_e164 ?? ""} />
              <Field label="Alternativt telefonnummer" name="alternate_phone" type="tel" defaultValue={customer.alternate_phone_e164 ?? ""} />
              <Field label="E-post" name="email" type="email" defaultValue={customer.email ?? ""} />
              <Field label="Webbplats" name="website" defaultValue={customer.website ?? ""} />
              <Field label="Adress" name="address_line1" defaultValue={customer.address_line1 ?? ""} />
              <Field label="Postnummer" name="postal_code" defaultValue={customer.postal_code ?? ""} />
              <Field label="Ort" name="city" defaultValue={customer.city ?? ""} />
              <Field label="Bransch" name="industry" defaultValue={customer.industry ?? ""} />
              {/* Rättslig grund sätts vid import och av ansvariga, inte i säljarens
                  vardag. Värdet skickas ändå med: formuläret skriver varje fält,
                  och ett utelämnat fält hade tömt det. */}
              {isSeller ? <input type="hidden" name="legal_basis" value={customer.legal_basis ?? ""} /> : <Field
                label="Rättslig grund för marknadsföring"
                name="legal_basis"
                defaultValue={customer.legal_basis ?? ""}
                placeholder="t.ex. berättigat intresse, samtycke"
                hint="Krävs för marknadsföringssamtal till privatpersoner. Påverkar inte företagskunder."
              />}
              <div className="span-2"><button className="button button-primary">Spara kunduppgifter</button></div>
            </form></details> : null}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><h2><Users size={17} /> Kontaktpersoner</h2><Badge>{contacts?.length ?? 0}</Badge></CardHeader>
          <CardContent>
            {contacts?.length ? contacts.map((contact) => <div className="activity-line" key={contact.id}>
              <span className="activity-dot"><Users size={14} /></span>
              <div>
                <strong>{contact.full_name}{contact.is_primary ? " · Primär" : ""}{contact.is_signatory ? " · Firmatecknare" : ""}</strong>
                <p>{[contact.title, contact.role].filter(Boolean).join(" · ") || "Roll ej angiven"}</p>
                <p>{[contact.phone_e164, contact.alternate_phone_e164, contact.email].filter(Boolean).join(" · ") || "Inga kontaktuppgifter"}</p>
              </div>
            </div>) : <p className="muted">Inga kontaktpersoner är registrerade på kunden.</p>}
          </CardContent>
        </Card>
        <Card><CardHeader><h2>Historik</h2><Badge>{(activities?.length ?? 0) + (calls?.length ?? 0)} händelser</Badge></CardHeader><CardContent>{calls?.map((call) => <div className="activity-line" key={call.id}><span className="activity-dot"><Phone size={14} /></span><div><strong>{call.direction === "outbound" ? "Utgående samtal" : "Inkommande samtal"}</strong><p>{call.disposition ? dispositionLabel(call.disposition) : callStatusLabel(call.status)} · {call.duration_seconds ?? 0} sek</p></div><time>{formatDate(call.created_at)}</time></div>)}{activities?.map((activity) => <div className="activity-line" key={activity.id}><span className="activity-dot"><CalendarPlus size={14} /></span><div><strong>{activity.title}</strong><p>{activity.description ?? activity.status}{activity.callback_scope ? ` · ${activity.callback_scope}` : ""}</p></div><time>{formatDate(activity.due_at ?? activity.created_at)}</time></div>)}</CardContent></Card>
        <Card><CardHeader><h2>Order, avtal och affärer</h2></CardHeader><CardContent>{orders?.map((order) => <div className="activity-line" key={order.id}><span className="activity-dot"><ClipboardList size={14} /></span><div><strong>{order.order_number}</strong><p>{order.status} · {formatCurrency(Number(order.total), order.currency)}</p></div><time>{formatDate(order.created_at)}</time></div>)}{contracts?.map((contract) => <div className="activity-line" key={contract.id}><span className="activity-dot"><FileSignature size={14} /></span><div><Link href={`/app/contracts/${contract.id}`}><strong>{contract.contract_number} · {contract.title}</strong></Link><p>{contractStatusLabel(contract.status)}</p></div><time>{formatCurrency(Number(contract.value), contract.currency)}</time></div>)}{deals?.map((deal) => <div className="activity-line" key={deal.id}><span className="activity-dot"><FileSignature size={14} /></span><div><strong>{deal.name}</strong><p>{deal.status} · {deal.probability}%</p></div><time>{formatCurrency(Number(deal.value), deal.currency)}</time></div>)}</CardContent></Card>
      </div>
      <div className="grid">
        {/* Samtalet sker på kundkortet. Tidigare skickade "Ring" säljaren till
            /app/dialer, alltså bort från kortet med kundens historik, anteckningar
            och avtal — precis det underlag samtalet handlar om. Dialern är låst
            till det här kundkortet, så det går inte att stå på ett kort och ringa
            ett annat. */}
        {mayCall && customer.phone_e164 && !customer.do_not_call ? <Card id="kundkort-dialer" className="customer-card-dialer">
          <CardHeader><h3><Phone size={16} /> Ring kunden</h3></CardHeader>
          <CardContent>
            <div className="phone-panel">
              <DialerPanel
                customers={[{
                  id: customer.id,
                  display_name: customer.display_name,
                  phone_e164: customer.phone_e164,
                  do_not_call: customer.do_not_call,
                }]}
                mayManageIntegrations={can(context.role, "integrations.manage")} contractDispositions={contractDispositionKeys}
                initialCustomer={customer.id}
                callbackActivityId={query.callback}
                lockedToCustomer
                callerIdOptions={(callerIdData ?? []) as Array<{ id: string; number_e164: string }>}
              />
            </div>
          </CardContent>
        </Card> : null}
        {mayScheduleCallback ? <Card><CardHeader><h3><CalendarPlus size={16} /> Boka återkomst</h3></CardHeader><CardContent><details open={Boolean(query.error)}><summary className="button button-secondary button-sm">Välj tid</summary><form action={scheduleCallback} className="form-stack" style={{ marginTop: 12 }}><input type="hidden" name="customer_id" value={customer.id} /><Field label="Rubrik" name="title" defaultValue="Återkomst" /><Field label="Tidpunkt" name="due_at" type="datetime-local" required /><SelectField label="Typ" name="scope" defaultValue="personal"><option value="personal">Personlig – endast jag</option><option value="global">Global – teamets gemensamma kö</option></SelectField><SelectField label="Ringlista (valfritt)" name="list_id" defaultValue=""><option value="">Ingen specifik lista</option>{lists?.map((list) => <option key={list.id} value={list.id}>{list.name} · {list.callback_policy}</option>)}</SelectField><TextareaField label="Vad ska följas upp?" name="description" /><button className="button button-primary">Skapa återkomst</button></form></details></CardContent></Card> : null}
        <Card><CardHeader><h3><StickyNote size={16} /> Anteckningar</h3><Badge>{notes?.length ?? 0}</Badge></CardHeader><CardContent>{mayWrite ? <details style={{ marginBottom: 12 }}><summary style={{ cursor: "pointer" }}>Ny anteckning</summary><form action={addNote} className="form-stack"><input type="hidden" name="customer_id" value={customer.id} /><TextareaField label="Anteckning" name="body" required /><div className="form-grid"><SelectField label="Typ" name="note_type" defaultValue="general"><option value="general">Allmän</option><option value="call">Samtal</option><option value="callback">Återkomst</option><option value="order">Order</option><option value="internal">Intern</option></SelectField><SelectField label="Synlighet" name="visibility" defaultValue="team"><option value="private">Privat</option><option value="team">Team</option><option value="tenant">Hela företaget</option></SelectField></div><label className="check-row"><input type="checkbox" name="is_pinned" /> Fäst högst upp på kundkortet</label><button className="button button-primary">Spara</button></form></details> : null}{notes?.map((note) => { const canEdit=mayWrite&&(note.created_by===context.userId||["owner","admin"].includes(context.role)); return <div className="activity-line" key={note.id}><span className="activity-dot"><StickyNote size={14} /></span><div><strong>{note.is_pinned ? "Fäst" : noteTypeLabel(note.note_type)} · {visibilityLabel(note.visibility)}</strong><p>{note.body}</p>{canEdit?<details><summary>Redigera eller arkivera</summary><form action={updateNote} className="form-stack note-edit-form"><input type="hidden" name="customer_id" value={customer.id}/><input type="hidden" name="note_id" value={note.id}/><TextareaField label="Text" name="body" defaultValue={note.body} required/><SelectField label="Synlighet" name="visibility" defaultValue={note.visibility}><option value="private">Privat</option><option value="team">Team</option><option value="tenant">Hela företaget</option></SelectField><label className="check-row"><input type="checkbox" name="is_pinned" defaultChecked={note.is_pinned}/> Fäst högst upp</label><button className="button button-secondary button-sm">Spara ny version</button></form><form action={archiveNote}><input type="hidden" name="customer_id" value={customer.id}/><input type="hidden" name="note_id" value={note.id}/><button className="button button-ghost button-sm">Arkivera</button></form></details>:null}</div><time>{formatDate(note.created_at)}</time></div>; })}</CardContent></Card>
        {mayWrite && !isSeller ? <Card><CardHeader><h3>Aktivitet</h3></CardHeader><CardContent><details><summary style={{ cursor: "pointer" }}>Ny aktivitet</summary><form action={addActivity} className="form-stack"><input type="hidden" name="customer_id" value={customer.id} /><Field label="Aktivitet" name="title" required /><Field label="Förfallotid" name="due_at" type="datetime-local" /><button className="button button-secondary">Skapa aktivitet</button></form></details></CardContent></Card> : null}
        {mayWrite ? <Card><CardHeader><h3><Ban size={16} /> Spärrar</h3></CardHeader><CardContent><details><summary style={{ cursor: "pointer" }}><PhoneOff size={14} /> NIX-spärr</summary><p className="muted">Följer numret och gäller även på ett kundkort som skapas senare.</p><form action={reportCustomerNix} className="form-stack"><input type="hidden" name="customer_id" value={customer.id} /><Field label="Hur framkom det? (valfritt)" name="notes" placeholder="Kunden uppgav NIX i samtalet" /><button className="button button-danger"><PhoneOff size={15} /> Registrera som NIX</button></form></details><details style={{ marginTop: 10 }}><summary style={{ cursor: "pointer" }}><Ban size={14} /> Kontaktspärr</summary><p className="muted">Stoppar samtal, SMS, e-post, kampanjer och automationer.</p><form action={blockCustomer} className="form-stack"><input type="hidden" name="customer_id" value={customer.id} /><Field label="Orsak" name="reason" placeholder="Kundens invändning" /><button className="button button-danger"><Ban size={15} /> Spärra kunden</button></form></details></CardContent></Card> : null}
      </div>
    </div>
  </>;
}
