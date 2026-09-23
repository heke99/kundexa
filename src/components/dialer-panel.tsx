"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Phone, PhoneOff, Radio } from "@/components/icons";
import { useDialerPanel } from "@/hooks/use-dialer";
import { useCallRealtime } from "@/hooks/use-call-realtime";
import { WebphoneAudioPanel } from "@/components/webphone-audio-panel";

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
  const dialer = useDialerPanel();
  const callState = useCallRealtime(callId, () => {
    dialer.markEnded();
    setAfterCall(true);
  });
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
    return [...byId.values()];
  }, [customerOptions, customers]);

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
      if (result.callClosed) setAfterCall(true);
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
    {!lockedToCustomer && selected ? <p style={{ marginBottom: 12 }}>
      <a href={`/app/customers/${selected}`} className="button button-ghost button-sm">Öppna kundkortet</a>
    </p> : null}
    {lockedToCustomer
      ? <p className="muted" style={{ marginBottom: 12 }}>
          Ringer {visibleCustomers.find((customer) => customer.id === selected)?.display_name ?? "kunden"} från det här kundkortet.
        </p>
      : <>
        <label className="field dialer-customer-select">
          <span>Sök kund eller prospekt</span>
          <input type="search" value={customerQuery} onChange={(event) => setCustomerQuery(event.target.value)} placeholder="Namn, telefon eller e-post" autoComplete="off" />
          <small>{customerSearchLoading ? "Söker…" : "Visar högst 30 behöriga träffar"}</small>
        </label>
        <label className="field dialer-customer-select">
          <span>Kund eller prospekt</span>
          <select value={selected} onChange={(event) => setSelected(event.target.value)}>
            <option value="">Välj kund</option>
            {visibleCustomers.map((customer) => <option key={customer.id} value={customer.id} disabled={customer.do_not_call}>
              {customer.display_name} · {customer.phone_e164}{customer.do_not_call ? " · SPÄRRAD" : ""}
            </option>)}
          </select>
        </label>
      </>}
    {callerIdOptions.length > 0 ? <label className="field dialer-customer-select">
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
    </label> : <p className="form-error">Företaget har inget utgående nummer ännu. Be en administratör lägga till ett.</p>}
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
    {afterCall && callId ? <form className="manual-after-call" onSubmit={complete}>
      <h3>Efterarbete</h3>
      <p>Registrera utfallet innan du ringer nästa nummer.</p>
      <label className="field"><span>Samtalsutfall</span><select required value={disposition} onChange={(event) => setDisposition(event.target.value)}>
        <option value="">Välj utfall</option>
        <option value="interested">Intresserad</option>
        <option value="callback">Återkomst</option>
        <option value="not_interested">Inte intresserad</option>
        <option value="no_answer">Inget svar</option>
        <option value="busy">Upptaget</option>
        <option value="voicemail">Telefonsvarare</option>
        <option value="wrong_number">Fel nummer</option>
        <option value="do_not_call">Ring inte igen</option>
        <option value="nix_listed">Nixat nummer</option>
      </select></label>
      {disposition === "nix_listed" ? <p className="notice warning">
        Numret registreras som NIX-spärrat och blockeras permanent för utgående samtal — även om
        kunden läggs upp på nytt senare.
      </p> : null}
      <label className="field"><span>Anteckning</span><textarea value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
      {disposition === "callback" ? <>
        <label className="field"><span>Återkomsttyp</span><select value={callbackScope} onChange={(event) => setCallbackScope(event.target.value as "personal" | "global")}>
          <option value="personal">Personlig</option><option value="global">Global teamkö</option>
        </select></label>
        <label className="field"><span>Tidpunkt</span><input type="datetime-local" required value={callbackDueAt} onChange={(event) => setCallbackDueAt(event.target.value)} /></label>
      </> : null}
      <div className="toolbar-left">
        <button className="button button-primary" type="submit" value="continue">Spara efterarbete</button>
        {contractDispositions.includes(disposition)
          ? <button className="button button-secondary" type="submit" value="create_contract">Spara och skapa avtal</button>
          : null}
      </div>
    </form> : null}
  </div>;
}
