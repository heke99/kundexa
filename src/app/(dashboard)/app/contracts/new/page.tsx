import { ok } from "@/lib/supabase/read";
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
import { manualContractDispositions } from "@/lib/contracts/manual-dispositions";
import { can, canCreateContractFromProduct } from "@/lib/permissions";
import { isoToZonedDateOnly, isoToZonedLocalDateTime } from "@/lib/domain/time";
import { CustomerSearchSelect, type CustomerSearchOption } from "@/components/customer-search-select";

type CallOption = {
  id: string; ended_at: string; started_at: string; duration_seconds: number; direction: string;
  disposition: string; notes: string | null; user_id: string | null; registered_manually: boolean; has_recording: boolean;
};
type ProductContract = { product_id: string | null; audience: string; current_version_id: string | null };
type ActivePrice = { product_id: string; version: number; recurring_fee: number; currency: string; binding_months: number | null; notice_months: number | null; payment_terms_days: number };

export default async function NewContractPage({ searchParams }: { searchParams: Promise<{ customer_id?: string; source_call_id?: string; error?: string; message?: string; warning?: string }> }) {
  const params = await searchParams;
  const ctx = await getAppContext();
  // `/app/contracts` opens on contracts.read, so kvalitet, ekonomi and viewer
  // could reach this page and every one of its three forms would be refused.
  // The two inner forms have their own permissions again: a contract_manager
  // may write contracts but not create customers or register calls.
  const mayWrite = canCreateContractFromProduct(ctx.role, ctx.platformRole);
  const mayCreateCustomer = can(ctx.role, "customers.write");
  const mayRegisterCall = can(ctx.role, "calls.create");
  // Säljaren ringer, äger sitt avtal och säljer i kronor på svenska. Valuta,
  // språk, kanal och ägare följer med som dolda fält i stället för fyra val
  // med ett enda rimligt svar.
  const isSeller = ctx.role === "sales";
  if (!mayWrite) {
    return <>
      <Link href="/app/contracts" className="muted" style={{ display: "inline-flex", gap: 6, alignItems: "center", marginBottom: 16 }}><ArrowLeft size={15} /> Till avtal</Link>
      <PageHeader title="Nytt avtal" description="Din roll kan inte skapa avtal." />
      <Card><CardContent><p className="muted">Din roll kan läsa avtal men inte skapa dem. Be säljaren eller teamledaren skapa avtalet.</p></CardContent></Card>
    </>;
  }
  const supabase = await createClient();
  const selectedCustomer = params.customer_id
    ? (await supabase.from("customers")
      .select("id,display_name,customer_type,email,phone_e164,organization_number,do_not_call,do_not_sms,do_not_email")
      .eq("id", params.customer_id).is("deleted_at", null).maybeSingle()).data as CustomerSearchOption | null
    : null;
  const [{ data: products }, { data: prices }, { data: productContracts }, { data: dispositions }, { data: members }, { data: teams }] = await Promise.all([
    ok(supabase.from("products").select("id,name").eq("active", true).order("name")),
    ok(supabase.from("product_price_versions").select("product_id,version,recurring_fee,currency,binding_months,notice_months,payment_terms_days").eq("active", true).order("version", { ascending: false })),
    // Avtalet ligger i produkten. Säljaren väljer produkten, och det här är hur
    // sidan vet vilka produkter som faktiskt har ett avtal att skicka.
    ok(supabase.from("contract_templates").select("product_id,audience,current_version_id").eq("active", true).not("product_id", "is", null)),
    manualContractDispositions(supabase, ctx.tenantId).then((data) => ({ data })),
    ok(supabase.from("tenant_memberships").select("user_id,role,profiles:user_id(full_name)").eq("status", "active").in("role", ["owner", "admin", "team_lead", "sales", "contract_manager"])),
    ok(supabase.from("teams").select("id,name").eq("status", "active").order("name")),
  ]);
  let eligibleCalls: CallOption[] = [];
  if (selectedCustomer) {
    const { data } = await ok(supabase.rpc("resolve_contract_eligible_calls", { p_customer_id: selectedCustomer.id }));
    eligibleCalls = (data ?? []) as CallOption[];
  }
  const selectedCall = eligibleCalls.find((call) => call.id === params.source_call_id) ?? null;
  const activePriceByProduct = new Map<string, ActivePrice>();
  for (const item of (prices ?? []) as ActivePrice[]) if (!activePriceByProduct.has(item.product_id)) activePriceByProduct.set(item.product_id, item);
  const contractByProduct = new Map(((productContracts ?? []) as ProductContract[]).map((row) => [row.product_id as string, row]));
  const audience = selectedCustomer?.customer_type === "person" ? "B2C" : "B2B";
  // Varför en produkt inte går att välja, sagt i listan i stället för som ett
  // fel efter att säljaren tryckt.
  const productBlocker = (productId: string) => {
    const contract = contractByProduct.get(productId);
    if (!contract) return "inget avtal";
    if (!contract.current_version_id) return "avtalet väntar på godkännande";
    if (!activePriceByProduct.has(productId)) return "saknar pris";
    if (![audience, "BOTH"].includes(contract.audience)) return contract.audience === "B2B" ? "bara företag" : "bara privatkunder";
    return null;
  };
  const sellable = (products ?? []).filter((product) => !productBlocker(product.id));
  const selectableMembers = (members ?? []).filter((member) => ctx.role !== "sales" || member.user_id === ctx.userId);
  const selectableTeams = (teams ?? []).filter((team) => ["owner", "admin", "contract_manager"].includes(ctx.role) || ctx.teamIds.includes(team.id));
  const now = new Date();
  const ended = new Date(now.getTime() - 5 * 60_000);
  // These values are pre-filled here and parsed back by the action with
  // `zonedLocalDateTimeToIso(..., ctx.tenantTimezone)`. The old helpers read the
  // *server's* own UTC offset, which is zero on Vercel, so a field shown as 12:00
  // was read back as 12:00 Stockholm for a call that actually happened at 14:00,
  // and the date-only default rolled back a day between midnight and 02:00. The
  // pre-fill and the parse have to agree on whose clock they mean.
  const localInput = (date: Date) => isoToZonedLocalDateTime(date.toISOString(), ctx.tenantTimezone);
  const dateInput = (date: Date) => isoToZonedDateOnly(date.toISOString(), ctx.tenantTimezone);
  const defaultExpiry = new Date(now.getTime() + 7 * 86400000);

  return <>
    <Link href="/app/contracts" className="muted" style={{ display: "inline-flex", gap: 6, alignItems: "center", marginBottom: 16 }}><ArrowLeft size={15} /> Till avtal</Link>
    <PageHeader title="Nytt avtal" description="Välj kund och produkt. Avtalet hämtas från produkten och fylls i med kundens uppgifter." />
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
          {mayCreateCustomer ? <details style={{ marginTop: 18 }}>
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
          </details> : <p className="muted" style={{ marginTop: 18 }}>Din roll kan inte lägga upp nya kunder. Välj en befintlig kund ovan.</p>}
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
            {mayRegisterCall ? <details style={{ marginTop: 18 }} open={!eligibleCalls.length}>
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
            </details> : <p className="muted" style={{ marginTop: 18 }}>Din roll kan inte registrera tidigare samtal. Be säljaren som ringde att registrera samtalet.</p>}
          </>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><h2><Badge>3</Badge> Produkt</h2><FileSignature size={18} /></CardHeader>
        <CardContent>
          {!selectedCustomer ? <div className="notice warning">Välj kund först.</div> : <form action={createContract} className="form-stack">
            <input type="hidden" name="customer_id" value={selectedCustomer.id} />
            <input type="hidden" name="source_call_id" value={selectedCall?.id ?? ""} />
            <SelectField label="Produkt" name="product_id" defaultValue={sellable.length === 1 ? sellable[0].id : ""} required>
              <option value="">Välj produkt</option>
              {products?.map((product) => { const blocker = productBlocker(product.id); const price = activePriceByProduct.get(product.id); return <option key={product.id} value={product.id} disabled={Boolean(blocker)}>{product.name}{blocker ? ` · ${blocker}` : price ? ` · ${price.recurring_fee} ${price.currency}/mån` : ""}</option>; })}
            </SelectField>
            <p className="muted">Avtalet som hör till produkten fylls i med {selectedCustomer.display_name}s uppgifter från kundkortet. Du ser det innan det skickas.</p>
            {!sellable.length ? <div className="notice warning">Ingen produkt har ett godkänt avtal för {audience === "B2C" ? "privatkunder" : "företagskunder"} än. En teamledare eller administratör lägger in avtalet under Produkter.</div> : null}
            <details>
              <summary style={{ cursor: "pointer" }}><strong>Fler val</strong> <span className="muted">— titel, datum, villkor, ansvarig</span></summary>
              <div className="form-stack" style={{ marginTop: 12 }}>
                <Field label="Avtalstitel" name="title" placeholder="Produktens namn" />
                <div className="grid grid-2"><Field label="Startdatum" name="starts_on" type="date" defaultValue={dateInput(now)} /><Field label="Slutdatum (valfritt)" name="ends_on" type="date" /></div>
                <div className="grid grid-2"><Field label="Bindningstid, månader" name="binding_months" type="number" min={0} max={240} placeholder="Från produkten" /><Field label="Uppsägningstid, månader" name="notice_months" type="number" min={0} max={120} placeholder="Från produkten" /></div>
                <div className="grid grid-2"><Field label="Betalningsvillkor, dagar" name="payment_terms_days" type="number" min={0} max={365} placeholder="Från produkten" /><Field label="Avtalsvärde" name="contract_value" type="number" min={0} step="0.01" placeholder="Från produkten" /></div>
                {isSeller ? <><input type="hidden" name="currency" value="SEK" /><input type="hidden" name="language" value="sv" /></> : <div className="grid grid-2"><Field label="Valuta" name="currency" defaultValue="SEK" minLength={3} maxLength={3} required /><SelectField label="Språk" name="language" defaultValue="sv"><option value="sv">Svenska</option><option value="en">Engelska</option></SelectField></div>}
                <TextareaField label="Särskilda villkor" name="special_terms" placeholder="Valfritt" />
                {isSeller ? <><input type="hidden" name="owner_user_id" value={ctx.userId} /><input type="hidden" name="team_id" value={selectableTeams.find((team) => ctx.teamIds.includes(team.id))?.id ?? ""} /></> : <div className="grid grid-2"><SelectField label="Ansvarig säljare" name="owner_user_id" defaultValue={ctx.userId} required>{selectableMembers.map((member) => { const profile = Array.isArray(member.profiles) ? member.profiles[0] : member.profiles; return <option key={member.user_id} value={member.user_id}>{profile?.full_name ?? member.user_id} · {member.role}</option>; })}</SelectField><SelectField label="Team" name="team_id" defaultValue={selectableTeams.find((team) => ctx.teamIds.includes(team.id))?.id ?? ""}><option value="">Inget team</option>{selectableTeams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</SelectField></div>}
                {isSeller ? <><input type="hidden" name="sales_channel" value="telephone" /><Field label="Sista svarsdatum" name="expires_at" type="datetime-local" defaultValue={localInput(defaultExpiry)} /></> : <div className="grid grid-2"><SelectField label="Försäljningskanal" name="sales_channel" defaultValue="telephone"><option value="telephone">Telefon</option><option value="in_person">Fysiskt möte</option><option value="web">Webb</option><option value="email">E-post</option><option value="partner">Partner</option><option value="api">API</option><option value="other">Övrigt</option></SelectField><Field label="Sista svarsdatum" name="expires_at" type="datetime-local" defaultValue={localInput(defaultExpiry)} /></div>}
              </div>
            </details>
            <button className="button button-primary" disabled={!sellable.length}><FileSignature size={16} /> Skapa avtalet och visa det</button>
          </form>}
        </CardContent>
      </Card>
    </div>
  </>;
}
