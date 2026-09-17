"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Phone, PhoneOff, Radio } from "@/components/icons";
import { useDialerPanel } from "@/hooks/use-dialer";
import { useCallRealtime } from "@/hooks/use-call-realtime";

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
  const initialCallerId = callerIdOptions[0];
  const [callerIdPhoneNumberId, setCallerIdPhoneNumberId] = useState(initialCallerId?.id ?? "");
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
    if (!callerIdPhoneNumberId) {
      setError("Du saknar ett tilldelat utgående telefonnummer.");
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
        callerIdPhoneNumberId,
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
    const result = await response.json() as { error?: string };
    if (!response.ok) {
      setError((result.error ?? "after_call_failed").replaceAll("_", " "));
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
        disabled={callerIdOptions.length === 1}
      >
        {callerIdOptions.map((number) => <option key={number.id} value={number.id}>
          {number.number_e164}
          
        </option>)}
      </select>
    </label> : <p className="form-error">Du saknar ett tilldelat utgående telefonnummer.</p>}
    <button type="button" className="call-button" onClick={call}
      disabled={!dialer.registered || !selected || !callerIdPhoneNumberId || afterCall || dialer.calling}
      aria-label="Ring via telefoni">
      <Phone size={25} />
    </button>
    {/* Two different numbers, and until now only the second was ever shown.
        Telefonitjänsten ringer alltid upp säljarens egen enhet först och kopplar
        därefter kunden, så "numret kunden ser" säger ingenting om vilken telefon
        som faktiskt ringer. Står fel telefon här går samtalet via fel person. */}
    {dialer.dialPath?.mapped ? <dl className="key-value dialer-path">
      <dt>Kunden ser</dt>
      <dd>{dialer.dialPath.callerIdNumber ?? "—"}</dd>
      <dt>Ringer upp dig</dt>
      {/* Never name a webphone here. Kundexa has none — no SIP, no WebRTC — and
          the provider's `muteOtherDevicesOnWebphone` only silences the other
          devices while one is online. A correct dial policy therefore does not
          mean the call rings in the browser; it rings the phone on the seat, and
          saying otherwise is the same false claim this change removed from the
          warning one line below. */}
      <dd>
        {dialer.dialPath.deviceRingsPhone ?? "Telefonienheten på din plats"}
        {dialer.dialPath.providerUserName ? ` · ${dialer.dialPath.providerUserName}` : ""}
      </dd>
    </dl> : null}
    {dialer.dialPath?.issue ? <div className="notice warning">
      {dialer.dialPath.issue}
      {mayManageIntegrations
        ? <div style={{ marginTop: 10 }}>
            <a className="button button-secondary button-sm" href="/app/integrations">Öppna Integrationer</a>
          </div>
        : null}
    </div> : null}
    {dialer.dialPath?.mapped && !dialer.dialPath.issue && dialer.dialPath.seatNameMatchesProfile === false ? <p className="notice warning">
      Telefoniplatsen som ringer upp dig står på {dialer.dialPath.providerUserName}. Samtalet går då via
      den personens telefon i stället för din egen. Be administratören lägga upp en egen telefoniplats för dig.
    </p> : null}
    {dialer.calling ? <p className="notice">Samtalet hanteras på din telefonienhet. Kundexa uppdaterar status automatiskt.</p> : null}
    {callId && (dialer.calling || callState.recovering) ? <div className="dialer-end">
      {/* The label carries the truth, not the footnote under it. The provider has
          no hangup endpoint at all, so a button offering to end the call is a
          promise the system cannot keep — the owner pressed the old one on
          2026-09-15 and the phone went on ringing. Answered and unanswered are
          different claims, so they get different words. */}
      <button type="button" className="button button-danger" onClick={endCurrentCall} disabled={dialer.ending}>
        <PhoneOff size={15} /> {dialer.ending
          ? "Släpper…"
          : callAnswered ? "Frigör för nästa samtal" : "Avbryt uppringningen"}
      </button>
      <small className="muted">
        {callAnswered
          ? "Samtalet pågår på din telefon och måste läggas på där — telefonitjänsten kan inte kopplas ned härifrån. Kundexa släpper samtalsförsöket direkt så att du kan ringa nästa nummer."
          : "Kundexa avbryter uppringningen och släpper samtalsförsöket. Ringer telefonen fortfarande avvisar du samtalet där; telefonitjänsten kan inte kopplas ned härifrån."}
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
        {disposition === "interested"
          ? <button className="button button-secondary" type="submit" value="create_contract">Spara och skapa avtal</button>
          : null}
      </div>
    </form> : null}
  </div>;
}
