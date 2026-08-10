import Link from "next/link";
import { ArrowLeft, FileSignature, Phone, Plus } from "@/components/icons";
import { createClient } from "@/lib/supabase/server";
import { createContract, createContractCustomer, registerExternalContractCall } from "@/app/actions/contracts";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Field, SelectField, TextareaField } from "@/components/ui/form-field";
import { formatDate } from "@/lib/utils";
import { getAppContext } from "@/lib/auth";
import { CustomerSearchSelect, type CustomerSearchOption } from "@/components/customer-search-select";

type CallOption = {
  id: string; ended_at: string; started_at: string; duration_seconds: number; direction: string;
  disposition: string; notes: string | null; user_id: string | null; registered_manually: boolean; has_recording: boolean;
};
type TemplateRelation = { name: string; audience: string; active: boolean; current_version_id: string | null };
type ActivePrice = { product_id: string; version: number; recurring_fee: number; currency: string; binding_months: number | null; notice_months: number | null; payment_terms_days: number };

export default async function NewContractPage({ searchParams }: { searchParams: Promise<{ customer_id?: string; source_call_id?: string; error?: string; message?: string; warning?: string }> }) {
  const params = await searchParams;
  const ctx = await getAppContext();
  const supabase = await createClient();
  const selectedCustomer = params.customer_id
    ? (await supabase.from("customers")
      .select("id,display_name,customer_type,email,phone_e164,organization_number,do_not_call,do_not_sms,do_not_email")
      .eq("id", params.customer_id).is("deleted_at", null).maybeSingle()).data as CustomerSearchOption | null
    : null;
  const [{ data: products }, { data: prices }, { data: versions }, { data: legalEntities }, { data: dispositions }, { data: members }, { data: teams }] = await Promise.all([
    supabase.from("products").select("id,name").eq("active", true).order("name"),
    supabase.from("product_price_versions").select("product_id,version,recurring_fee,currency,binding_months,notice_months,payment_terms_days").eq("active", true).order("version", { ascending: false }),
    supabase.from("contract_template_versions").select("id,version,status,contract_templates(name,audience,active,current_version_id)").eq("status", "approved").order("created_at", { ascending: false }),
    supabase.from("tenant_legal_entities").select("id,legal_name,organization_number,is_default").eq("active", true).order("is_default", { ascending: false }),
    supabase.from("list_dispositions").select("key,label").eq("contract_eligible", true).order("sort_order"),
    supabase.from("tenant_memberships").select("user_id,role,profiles:user_id(full_name)").eq("status", "active").in("role", ["owner", "admin", "team_lead", "sales", "contract_manager"]),
    supabase.from("teams").select("id,name").eq("status", "active").order("name"),
  ]);
  let eligibleCalls: CallOption[] = [];
  if (selectedCustomer) {
    const { data } = await supabase.rpc("resolve_contract_eligible_calls", { p_customer_id: selectedCustomer.id });
    eligibleCalls = (data ?? []) as CallOption[];
  }
  const selectedCall = eligibleCalls.find((call) => call.id === params.source_call_id) ?? null;
  const approvedVersions = (versions ?? []).filter((version) => {
    const template = Array.isArray(version.contract_templates) ? version.contract_templates[0] : version.contract_templates;
    return template?.active && template.current_version_id === version.id;
  });
  const activePriceByProduct = new Map<string, ActivePrice>();
  for (const item of (prices ?? []) as ActivePrice[]) if (!activePriceByProduct.has(item.product_id)) activePriceByProduct.set(item.product_id, item);
  const selectableMembers = (members ?? []).filter((member) => ctx.role !== "sales" || member.user_id === ctx.userId);
  const selectableTeams = (teams ?? []).filter((team) => ["owner", "admin", "contract_manager"].includes(ctx.role) || ctx.teamIds.includes(team.id));
  const now = new Date();
  const ended = new Date(now.getTime() - 5 * 60_000);
  const localInput = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  const dateInput = (date: Date) => date.toISOString().slice(0, 10);
  const defaultExpiry = new Date(now.getTime() + 7 * 86400000);

  return <>
    <Link href="/app/contracts" className="muted" style={{ display: "inline-flex", gap: 6, alignItems: "center", marginBottom: 16 }}><ArrowLeft size={15} /> Till avtal</Link>
    <PageHeader title="Nytt avtal" description="Välj eller skapa kund, bind avtalet till ett verkligt avslutat samtal och bygg därefter en låsbar avtalsversion." />
    {params.error ? <p className="form-error">{params.error}</p> : null}
    {params.message ? <p className="notice">{params.message}</p> : null}
    {params.warning ? <p className="notice warning">{params.warning}</p> : null}

    <div className="grid" style={{ gap: 18 }}>
      <Card>
        <CardHeader><h2><Badge>1</Badge> Kund</h2>{selectedCustomer ? <Badge className="badge-success">Vald</Badge> : null}</CardHeader>
        <CardContent>
          <form method="get" className="form-stack">
            <CustomerSearchSelect name="customer_id" label="Befintlig kund" channel="contract" defaultValue={selectedCustomer?.id ?? ""} initialCustomer={selectedCustomer} required />
            <button className="button button-secondary">Välj kund</button>
          </form>
          <details style={{ marginTop: 18 }}>
            <summary><strong><Plus size={15} /> Skapa ny kund</strong></summary>
            <form action={createContractCustomer} className="form-stack" style={{ marginTop: 14 }}>
              <SelectField label="Kundtyp" name="customer_type" defaultValue="person"><option value="person">Privatkund</option><option value="company">Företagskund</option></SelectField>
              <div className="grid grid-2"><Field label="Förnamn" name="first_name" /><Field label="Efternamn" name="last_name" /></div>
              <Field label="Företagsnamn" name="company_name" /><Field label="Organisationsnummer" name="organization_number" />
              <div className="grid grid-2"><Field label="Kontaktperson för företag" name="contact_person" /><Field label="Personnummer, endast när avtalet kräver det" name="personal_identity_number" /></div>
              <div className="grid grid-2"><Field label="E-post" name="email" type="email" /><Field label="Mobilnummer" name="phone_e164" placeholder="+46700000000" required /></div>
              <Field label="Adress" name="address_line1" />
              <div className="grid grid-2"><Field label="Postnummer" name="postal_code" /><Field label="Ort" name="city" /></div>
              <Field label="Landkod" name="country_code" defaultValue="SE" maxLength={2} />
              <button className="button button-secondary"><Plus size={15} /> Kontrollera dubblett och skapa</button>
            </form>
          </details>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><h2><Badge>2</Badge> Tidigare samtal</h2>{selectedCall ? <Badge className="badge-success">Avtalsgrundande</Badge> : <Badge className="badge-warning">Krävs före utskick</Badge>}</CardHeader>
        <CardContent>
          {!selectedCustomer ? <div className="notice warning">Välj först en kund. Utkast kan skapas utan samtal, men inget avtal får skickas innan ett giltigt tidigare samtal är länkat.</div> : <>
            {eligibleCalls.length ? <form method="get" className="form-stack">
              <input type="hidden" name="customer_id" value={selectedCustomer.id} />
              <SelectField label="Giltigt avslutat samtal" name="source_call_id" defaultValue={selectedCall?.id ?? ""} required>
                <option value="">Välj samtal</option>
                {eligibleCalls.map((call) => <option key={call.id} value={call.id}>{formatDate(call.ended_at)} · {call.direction === "outbound" ? "Utgående" : "Inkommande"} · {call.disposition} · {call.duration_seconds}s{call.registered_manually ? " · manuellt registrerat" : ""}</option>)}
              </SelectField>
              <button className="button button-secondary"><Phone size={15} /> Använd samtalet</button>
            </form> : <div className="notice warning">Inget giltigt samtal hittades. Starta ett samtal i dialern eller registrera ett verkligt tidigare samtal nedan.</div>}
            <details style={{ marginTop: 18 }} open={!eligibleCalls.length}>
              <summary><strong>Registrera tidigare samtal</strong></summary>
              <form action={registerExternalContractCall} className="form-stack" style={{ marginTop: 14 }}>
                <input type="hidden" name="customer_id" value={selectedCustomer.id} />
                <Field label="Telefonnummer" name="phone_e164" defaultValue={selectedCustomer.phone_e164 ?? ""} required />
                <SelectField label="Riktning" name="direction" defaultValue="outbound"><option value="outbound">Utgående</option><option value="inbound">Inkommande</option></SelectField>
                <div className="grid grid-2"><Field label="Starttid" name="started_at" type="datetime-local" defaultValue={localInput(ended)} required /><Field label="Sluttid" name="ended_at" type="datetime-local" defaultValue={localInput(now)} required /></div>
                <SelectField label="Avtalsgrundande disposition" name="disposition" required><option value="">Välj disposition</option>{dispositions?.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}</SelectField>
                <TextareaField label="Samtalsanteckning" name="note" required />
                <Field label="Extern referens (valfri)" name="external_reference" />
                <label><input type="checkbox" name="confirmed" required /> Jag bekräftar att ett riktigt kundsamtal har genomförts.</label>
                <button className="button button-secondary">Registrera granskningsbart samtal</button>
              </form>
            </details>
          </>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><h2><Badge>3</Badge> Avtalsinnehåll</h2><FileSignature size={18} /></CardHeader>
        <CardContent>
          {!selectedCustomer ? <div className="notice warning">Välj kund för att skapa avtalsutkast.</div> : <form action={createContract} className="form-stack">
            <input type="hidden" name="customer_id" value={selectedCustomer.id} />
            <input type="hidden" name="source_call_id" value={selectedCall?.id ?? ""} />
            <div className="notice"><strong>Kund:</strong> {selectedCustomer.display_name}<br /><strong>Källsamtal:</strong> {selectedCall ? `${formatDate(selectedCall.ended_at)} · ${selectedCall.disposition}` : "Inte valt – utkastet kan sparas men utskick blockeras"}</div>
            <SelectField label="Juridiskt avsändarbolag" name="legal_entity_id" defaultValue={legalEntities?.find((entity) => entity.is_default)?.id ?? ""} required><option value="">Välj juridiskt bolag</option>{legalEntities?.map((entity) => <option key={entity.id} value={entity.id}>{entity.legal_name}{entity.organization_number ? ` · ${entity.organization_number}` : ""}</option>)}</SelectField>
            <SelectField label="Godkänd avtalsmall" name="template_version_id" required><option value="">Välj mall</option>{approvedVersions.map((version) => { const template = (Array.isArray(version.contract_templates) ? version.contract_templates[0] : version.contract_templates) as TemplateRelation | null; return <option key={version.id} value={version.id}>{template?.name ?? "Mall"} · {template?.audience} · version {version.version}</option>; })}</SelectField>
            <SelectField label="Produkt och aktiv prisversion" name="product_id"><option value="">Utan produkt</option>{products?.map((product) => { const price = activePriceByProduct.get(product.id); return <option key={product.id} value={product.id}>{product.name}{price ? ` · v${price.version} · ${price.recurring_fee} ${price.currency}` : " · saknar aktiv prisversion"}</option>; })}</SelectField>
            <Field label="Avtalstitel" name="title" placeholder="Företagsabonnemang" required />
            <div className="grid grid-2"><Field label="Startdatum" name="starts_on" type="date" defaultValue={dateInput(now)} /><Field label="Slutdatum (valfritt)" name="ends_on" type="date" /></div>
            <div className="grid grid-2"><Field label="Bindningstid, månader" name="binding_months" type="number" min={0} max={240} placeholder="Från prisversion" /><Field label="Uppsägningstid, månader" name="notice_months" type="number" min={0} max={120} placeholder="Från prisversion" /></div>
            <div className="grid grid-2"><Field label="Betalningsvillkor, dagar" name="payment_terms_days" type="number" min={0} max={365} placeholder="Från prisversion" /><Field label="Avtalsvärde" name="contract_value" type="number" min={0} step="0.01" placeholder="Från prisversion" /></div>
            <div className="grid grid-2"><Field label="Valuta" name="currency" defaultValue="SEK" minLength={3} maxLength={3} required /><SelectField label="Språk" name="language" defaultValue="sv"><option value="sv">Svenska</option><option value="en">Engelska</option></SelectField></div>
            <TextareaField label="Särskilda kommersiella villkor" name="special_terms" placeholder="Valfria villkor som ska bindas till denna avtalsversion" />
            <div className="grid grid-2"><SelectField label="Ansvarig säljare" name="owner_user_id" defaultValue={ctx.userId} required>{selectableMembers.map((member) => { const profile = Array.isArray(member.profiles) ? member.profiles[0] : member.profiles; return <option key={member.user_id} value={member.user_id}>{profile?.full_name ?? member.user_id} · {member.role}</option>; })}</SelectField><SelectField label="Team" name="team_id" defaultValue={selectableTeams.find((team) => ctx.teamIds.includes(team.id))?.id ?? ""}><option value="">Inget team</option>{selectableTeams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</SelectField></div>
            <div className="grid grid-2"><SelectField label="Försäljningskanal" name="sales_channel" defaultValue="telephone"><option value="telephone">Telefon</option><option value="in_person">Fysiskt möte</option><option value="web">Webb</option><option value="email">E-post</option><option value="partner">Partner</option><option value="api">API</option><option value="other">Övrigt</option></SelectField><Field label="Föreslaget sista svarsdatum" name="expires_at" type="datetime-local" defaultValue={localInput(defaultExpiry)} /></div>
            <div className="notice">Utkastet skapas från mallens aktuella godkända version. Valda kund-, pris-, säljare-, datum- och villkorsuppgifter fryses i snapshoten och kan granskas innan utskick.</div>
            <button className="button button-primary" disabled={!approvedVersions.length || !legalEntities?.length}><FileSignature size={16} /> Skapa utkast och förhandsgranska</button>
          </form>}
        </CardContent>
      </Card>
    </div>
  </>;
}
