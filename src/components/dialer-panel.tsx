"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { Phone, PhoneOff, Radio } from "@/components/icons";
import { useDialerPanel } from "@/hooks/use-dialer";
import { useCallRealtime } from "@/hooks/use-call-realtime";
import { WebphoneAudioPanel } from "@/components/webphone-audio-panel";
import { LiveCustomerCard } from "@/components/call-workspace/live-customer-card";
import { CallbackTimeField, OutcomePicker } from "@/components/call-workspace/outcome-picker";
import { manualOutcomeOptions } from "@/lib/dialer/outcomes";

type Customer = { id: string; display_name: string; phone_e164: string | null; do_not_call: boolean };
// Numret som visas för mottagaren, ur företagets egna nummer. Tidigare kom det
// från leverantörens allokeringsmodell; nu är det bara ett nummer.
type CallerIdOption = {
  id: string;
  number_e164: string;
};

export function DialerPanel({
  customers,
  initialCustomer,
  callbackActivityId,
  callerIdOptions = [],
  lockedToCustomer = false,
  mayManageIntegrations = false,
  contractDispositions = ["interested"],
  sellableProducts = null,
  mayManageProducts = false,
}: {
  customers: Customer[];
  initialCustomer?: string;
  callbackActivityId?: string;
  callerIdOptions?: CallerIdOption[];
  /**
   * The dial-path warning used to end with 'kör "Rätta uppringningsvägen" under
   * Integrationer'. That page sits in the Inställningar section, which is
   * collapsed by default, so the instruction named a place the reader could not
   * see — and a seller cannot open it at all. Whoever can act gets a link;
   * whoever cannot gets told who to ask.
   */
  mayManageIntegrations?: boolean;
  /** Utfallen som får leda till avtal, enligt företagets inställning (samma regel som databasen). */
  contractDispositions?: string[];
  /**
   * Antal produkter med godkänt avtal och pris. Noll betyder att inget avtal kan
   * skickas; det sägs i efterarbetet i stället för på avtalssidan efteråt.
   * `null` när sidan inte räknat.
   */
  sellableProducts?: number | null;
  mayManageProducts?: boolean;
  /**
   * On the customer card the dialer belongs to the record it sits on. Locking
   * it removes the search and the picker rather than hiding them, so there is
   * no way to be on one card and dial another.
   */
  lockedToCustomer?: boolean;
}) {
  const [selected, setSelected] = useState(initialCustomer ?? "");
  const [customerQuery, setCustomerQuery] = useState("");
  const [customerOptions, setCustomerOptions] = useState<Customer[]>(customers);
  const [customerSearchLoading, setCustomerSearchLoading] = useState(false);
  const [pickingCustomer, setPickingCustomer] = useState(false);
  // Kunden som klickades fram. Sparas som post: en sökning som svarar efter
  // klicket får inte ta bort den ur listan och lämna ringknappen utan nummer.
  const [pickedCustomer, setPickedCustomer] = useState<Customer | null>(null);
  // Sidan kan ge kortet en egen plats (`#dialer-live-slot`) bredvid telefonen.
  // I den smala telefonpanelen hamnade det under knapparna och syntes inte.
  const [liveSlot, setLiveSlot] = useState<HTMLElement | null>(null);
  useEffect(() => { setLiveSlot(document.getElementById("dialer-live-slot")); }, []);
  const [callId, setCallId] = useState<string | null>(null);
  // Tomt betyder automatiskt: numret följer kampanj, team och företagets förval,
  // så som en administratör eller teamledare har bestämt.
  const [callerIdPhoneNumberId, setCallerIdPhoneNumberId] = useState("");
  const [afterCall, setAfterCall] = useState(false);
  const [disposition, setDisposition] = useState("");
  const [notes, setNotes] = useState("");
  const [callbackScope, setCallbackScope] = useState<"personal" | "global">("personal");
  const [callbackDueAt, setCallbackDueAt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [endMessage, setEndMessage] = useState<string | null>(null);
  const requestKeyRef = useRef<string | null>(null);
  const afterCallFormRef = useRef<HTMLFormElement>(null);
  const dialer = useDialerPanel();
  const callState = useCallRealtime(callId, (status) => {
    dialer.markEnded();
    preselectOutcome(status);
    setAfterCall(true);
  });

  // Ingen svarade: utfallet är redan känt, så det förväljs och Enter sparar.
  // Ett besvarat samtal får ingen gissning; där väljer säljaren själv.
  function preselectOutcome(status: string | null | undefined) {
    const known: Record<string, string> = { unanswered: "no_answer", no_answer: "no_answer", busy: "busy", voicemail: "voicemail" };
    const key = status ? known[status] : undefined;
    if (key) setDisposition((current) => current || key);
  }
  // Once the customer has picked up, Kundexa can no longer end anything: the
  // provider exposes no hangup, so all that is left is releasing the seat.
  const callAnswered = callState.status === "answered" || callState.status === "in_progress";

  useEffect(() => {
    if (lockedToCustomer) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      const normalizedQuery = customerQuery.trim();
      if (normalizedQuery.length === 1) {
        setCustomerOptions(customers);
        return;
      }
      setCustomerSearchLoading(true);
      try {
        const url = new URL("/api/v1/customers", window.location.origin);
        url.searchParams.set("limit", "30");
        if (normalizedQuery) url.searchParams.set("q", normalizedQuery);
        const response = await fetch(url, { signal: controller.signal, credentials: "same-origin", cache: "no-store" });
        if (!response.ok) return;
        const payload = await response.json() as { data?: Customer[] };
        const next = payload.data ?? [];
        const initial = customers.find((customer) => customer.id === initialCustomer);
        setCustomerOptions(initial && !next.some((customer) => customer.id === initial.id) ? [initial, ...next] : next);
      } catch (caught) {
        if (!(caught instanceof DOMException && caught.name === "AbortError")) console.error("Dialer customer search failed", caught);
      } finally {
        if (!controller.signal.aborted) setCustomerSearchLoading(false);
      }
    }, 350);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [customerQuery, customers, initialCustomer, lockedToCustomer]);

  const visibleCustomers = useMemo(() => {
    const byId = new Map<string, Customer>();
    for (const customer of customerOptions) byId.set(customer.id, customer);
    for (const customer of customers) byId.set(customer.id, customer);
    if (pickedCustomer) byId.set(pickedCustomer.id, pickedCustomer);
    return [...byId.values()];
  }, [customerOptions, customers, pickedCustomer]);

  const selectedCustomer = visibleCustomers.find((customer) => customer.id === selected) ?? null;

  async function call() {
    if (!selected || dialer.calling) return;
    if (callerIdOptions.length === 0) {
      setError("Företaget har inget utgående nummer ännu. Be en administratör lägga till ett.");
      return;
    }
    const customer = visibleCustomers.find((item) => item.id === selected);
    if (!customer?.phone_e164) return;
    requestKeyRef.current ??= `dialer.call:${crypto.randomUUID()}`;
    setError(null);
    try {
      const id = await dialer.startCall({
        customerId: selected,
        targetPhone: customer.phone_e164,
        callbackActivityId: callbackActivityId ?? null,
        callerIdPhoneNumberId: callerIdPhoneNumberId || null,
        clientRequestId: crypto.randomUUID(),
        idempotencyKey: requestKeyRef.current,
      });
      setCallId(id);
      requestKeyRef.current = null;
    } catch (caught) {
      const outcomeUnknown = Boolean(caught && typeof caught === "object" && "outcomeUnknown" in caught
        && (caught as { outcomeUnknown?: unknown }).outcomeUnknown === true);
      // Definitiva fel får en ny nyckel vid nästa manuella försök. Vid ett osäkert
      // nätverksutfall behålls samma nyckel och dialern blockeras mot dubbelringning.
      if (!outcomeUnknown) requestKeyRef.current = null;
      setError(caught instanceof Error ? caught.message : "Samtalet kunde inte startas");
    }
  }

  async function endCurrentCall() {
    if (!callId || dialer.ending) return;
    setError(null);
    try {
      // Lägg på först, släpp platsen sedan. Omvänd ordning lämnar ett halvt
      // sekunds fönster där platsen är fri medan ljudet fortfarande går.
      // Ett fel i webbläsarens avslut får inte hindra att platsen släpps.
      try { dialer.hangupWebphone(); } catch (hangupError) { console.error("webphone_hangup_failed", hangupError); }
      const result = await dialer.endCall(callId);
      setEndMessage(result.message);
      // An unanswered call is closed here and now, so the after-call form must
      // open immediately rather than waiting for a realtime update that will
      // never carry anything new. A call that was already answered is left to
      // the provider, and its own terminal event opens the form.
      if (result.callClosed) { preselectOutcome(result.callStatus); setAfterCall(true); }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Samtalet kunde inte avslutas");
    }
  }

  async function complete(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const createContractAfterSave = submitter instanceof HTMLButtonElement && submitter.value === "create_contract";
    if (!callId || !disposition) return;
    setError(null);
    const response = await fetch("/api/v1/calls/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        callId,
        disposition,
        notes: notes || null,
        callbackScope: disposition === "callback" ? callbackScope : null,
        callbackDueAt: disposition === "callback" ? callbackDueAt : null,
      }),
    });
    const result = await response.json() as { error?: string; message?: string };
    if (!response.ok) {
      setError(result.message ?? (result.error ?? "after_call_failed").replaceAll("_", " "));
      return;
    }
    if (createContractAfterSave) {
      window.location.assign(`/app/contracts/new?customer_id=${encodeURIComponent(selected)}&source_call_id=${encodeURIComponent(callId)}`);
      return;
    }
    setAfterCall(false);
    setCallId(null);
    setEndMessage(null);
    setDisposition("");
    setNotes("");
    setCallbackDueAt("");
  }

  return <div>
    <div className="dialer-status">
      <strong>Click-to-call</strong>
      <span className={`badge ${dialer.registered ? "badge-success" : "badge-warning"}`}>
        <Radio size={12} /> {dialer.status}
      </span>
    </div>
    <div className="phone-display">{visibleCustomers.find((customer) => customer.id === selected)?.phone_e164 ?? (lockedToCustomer ? "Telefonnummer saknas" : "Välj kund")}</div>
    {/* Säljaren ska se vem hon ringer: historik, anteckningar och spärrar ligger
        på kundkortet, och därifrån skapas också avtalet. */}
    {/* Inte under ett samtal eller efterarbete: sidbytet lägger på samtalet och
        tappar utfallsformuläret. Kundkortet finns kvar när samtalet är avslutat. */}
    {!lockedToCustomer && selected && !callId ? <p style={{ marginBottom: 12 }}>
      <a href={`/app/customers/${selected}`} className="button button-ghost button-sm">Öppna kundkortet</a>
    </p> : null}
    {lockedToCustomer
      ? <p className="muted" style={{ marginBottom: 12 }}>
          Ringer {visibleCustomers.find((customer) => customer.id === selected)?.display_name ?? "kunden"} från det här kundkortet.
        </p>
      : selectedCustomer && !pickingCustomer
        // Ett fält i stället för två: sök, klicka på träffen, klart. Rullistan
        // under sökfältet upprepade samma träffar en gång till.
        ? <div className="dialer-selected-customer">
            <div><strong>{selectedCustomer.display_name}</strong><small>{selectedCustomer.phone_e164 ?? "Inget nummer"}</small></div>
            <button type="button" className="button button-ghost button-sm" onClick={() => { setSelected(""); setPickingCustomer(true); }} disabled={Boolean(callId)}>Byt</button>
          </div>
        : <div className="field dialer-customer-select">
            <label htmlFor="dialer-customer-search">Sök kund eller prospekt</label>
            <input id="dialer-customer-search" type="search" value={customerQuery} onChange={(event) => setCustomerQuery(event.target.value)} placeholder="Namn, telefon eller e-post" autoComplete="off" autoFocus={pickingCustomer} />
            <small>{customerSearchLoading ? "Söker…" : visibleCustomers.length ? "Klicka på kunden du vill ringa" : "Inga träffar"}</small>
            {visibleCustomers.length ? <ul className="dialer-results">
              {visibleCustomers.slice(0, 8).map((customer) => <li key={customer.id}>
                <button type="button" disabled={customer.do_not_call || !customer.phone_e164} onClick={() => { setPickedCustomer(customer); setSelected(customer.id); setPickingCustomer(false); }}>
                  <strong>{customer.display_name}</strong>
                  <small>{customer.do_not_call ? "Spärrad" : customer.phone_e164 ?? "Inget nummer"}</small>
                </button>
              </li>)}
            </ul> : null}
          </div>}
    {/* Nästan alltid "Automatiskt": numret följer lista, kampanj och team. Valet
        ligger därför bakom en rad som visar vad som gäller. */}
    {callerIdOptions.length > 0 ? <details className="dialer-caller-id">
      <summary>Utgående nummer: {callerIdOptions.find((number) => number.id === callerIdPhoneNumberId)?.number_e164 ?? "automatiskt"}</summary>
      <label className="field dialer-customer-select">
      <span>Utgående nummer</span>
      <select
        value={callerIdPhoneNumberId}
        onChange={(event) => setCallerIdPhoneNumberId(event.target.value)}
      >
        <option value="">Automatiskt (team eller företag)</option>
        {callerIdOptions.map((number) => <option key={number.id} value={number.id}>
          {number.number_e164}
        </option>)}
      </select>
    </label></details> : <p className="form-error">Företaget har inget utgående nummer ännu. Be en administratör lägga till ett.</p>}
    <button type="button" className="call-button" onClick={call}
      disabled={!dialer.registered || !selected || callerIdOptions.length === 0 || afterCall || dialer.calling}
      aria-label="Ring via telefoni">
      <Phone size={25} />
    </button>
    {/* Two different numbers, and until now only the second was ever shown.
        Telefonitjänsten ringer alltid upp säljarens egen enhet först och kopplar
        därefter kunden, så "numret kunden ser" säger ingenting om vilken telefon
        som faktiskt ringer. Står fel telefon här går samtalet via fel person. */}

    {dialer.calling ? <p className="notice">Samtalet är uppkopplat i webbläsaren. Kundexa uppdaterar status automatiskt.</p> : null}
    <WebphoneAudioPanel
      inCall={dialer.calling}
      muted={dialer.muted}
      capabilities={dialer.audioCapabilities}
      onToggleMute={dialer.toggleMute}
      onSendDtmf={dialer.sendDtmf}
    />
    {/* Knappen syns så länge det finns ett samtal utan efterarbete. Den hängde
        på dialerns interna läge, och ett samtal vars händelser uteblev gick då
        inte att avsluta alls. */}
    {callId && !afterCall ? <div className="dialer-end">
      {/* Knappen lägger på på riktigt nu: samtalet ligger i den här fliken, och
          `hangupWebphone` river ned det innan platsen släpps. Texten under är
          omskriven därför att den beskrev en telefon som inte längre finns i
          bilden — den bad säljaren lägga på i en app hon aldrig loggat in i. */}
      <button type="button" className="button button-danger" onClick={endCurrentCall} disabled={dialer.ending}>
        <PhoneOff size={15} /> {dialer.ending
          ? "Lägger på…"
          : callAnswered ? "Lägg på" : "Avbryt uppringningen"}
      </button>
      <small className="muted">
        {callAnswered
          ? "Samtalet läggs på här och platsen släpps, så du kan ringa nästa nummer direkt."
          : "Uppringningen avbryts och samtalsförsöket släpps."}
      </small>
    </div> : null}
    {endMessage ? <p className="notice">{endMessage}</p> : null}
    {callState.recovering ? <p className="notice">Samtalets slutstatus är ännu inte säkerställd. Kundexa fortsätter automatisk avstämning—starta inte ett nytt samtal.</p> : null}
    {callId && callState.connectionState === "degraded" ? <p className="notice">Realtime är tillfälligt frånkopplat. Samtalsstatus hämtas via säker fallback.</p> : null}
    {error ? <p className="form-error">{error}</p> : null}
    {afterCall && callId ? <form className="manual-after-call" onSubmit={complete} ref={afterCallFormRef}>
      <h3>Efterarbete</h3>
      <p>Välj utfall med ett klick eller siffertangent 1–9. Enter sparar.</p>
      <OutcomePicker options={manualOutcomeOptions} value={disposition} onChange={setDisposition} onConfirm={() => afterCallFormRef.current?.requestSubmit()} />
      {disposition === "nix_listed" ? <p className="notice warning">
        Numret registreras som NIX-spärrat och blockeras permanent för utgående samtal — även om
        kunden läggs upp på nytt senare.
      </p> : null}
      {disposition === "callback" ? <>
        <CallbackTimeField value={callbackDueAt} onChange={setCallbackDueAt} required />
        <label className="field"><span>Vem ringer tillbaka?</span><select value={callbackScope} onChange={(event) => setCallbackScope(event.target.value as "personal" | "global")}>
          <option value="personal">Jag själv</option><option value="global">Hela teamet</option>
        </select></label>
      </> : null}
      {/* Avtalet skickas efter samtalet och kräver ett utfall som får leda till
          avtal. Säljaren fick ingen förklaring när knappen saknades. */}
      {sellableProducts === 0 && (!disposition || contractDispositions.includes(disposition))
        ? <p className="notice warning">Inget avtal kan skickas ännu: företaget har ingen produkt med godkänt avtal och pris. {mayManageProducts ? <a href="/app/products">Lägg in en produkt</a> : "Be en administratör lägga in en produkt."}</p>
        : disposition && !contractDispositions.includes(disposition)
          ? null
          : !disposition ? <p className="muted">Vill kunden ha avtal? Välj {contractDispositions.includes("interested") ? "Intresserad" : "ett avtalsgrundande utfall"}, så kan du skapa och skicka det direkt.</p> : null}
      <label className="field"><span>Anteckning</span><textarea rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Vad sades? Syns på kundkortet." /></label>
      <div className="toolbar-left">
        <button className="button button-primary" type="submit" value="continue" disabled={!disposition}>Spara efterarbete</button>
        {contractDispositions.includes(disposition) && sellableProducts !== 0
          ? <button className="button button-secondary" type="submit" value="create_contract">Spara och skapa avtal</button>
          : null}
      </div>
    </form> : null}
    {/* Kunden i luren: kortet öppnas och uppgifterna sparas utan sidladdning, så
        samtalet i webbläsaren och efterarbetet ligger kvar. */}
    {callId && selected ? (liveSlot
      ? createPortal(<LiveCustomerCard customerId={selected} heading={afterCall ? "Samtalet är avslutat" : "Pågående samtal · fyll i uppgifterna"} fullCardLink={!lockedToCustomer} />, liveSlot)
      : <div className="phone-panel-live"><LiveCustomerCard customerId={selected} heading={afterCall ? "Kunduppgifter" : "Fyll i under samtalet"} fullCardLink={!lockedToCustomer} /></div>) : null}
  </div>;
}
