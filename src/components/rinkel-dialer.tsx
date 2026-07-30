"use client";

import { useRef, useState } from "react";
import { Phone, Radio } from "@/components/icons";
import { useRinkelDialer } from "@/hooks/use-rinkel-dialer";
import { useCallRealtime } from "@/hooks/use-call-realtime";

type Customer = { id: string; display_name: string; phone_e164: string | null; do_not_call: boolean };

export function RinkelDialer({
  customers,
  initialCustomer,
  callbackActivityId,
}: {
  customers: Customer[];
  initialCustomer?: string;
  callbackActivityId?: string;
}) {
  const [selected, setSelected] = useState(initialCustomer ?? "");
  const [callId, setCallId] = useState<string | null>(null);
  const [afterCall, setAfterCall] = useState(false);
  const [disposition, setDisposition] = useState("");
  const [notes, setNotes] = useState("");
  const [callbackScope, setCallbackScope] = useState<"personal" | "global">("personal");
  const [callbackDueAt, setCallbackDueAt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const requestKeyRef = useRef<string | null>(null);
  const rinkel = useRinkelDialer();
  useCallRealtime(callId, () => {
    rinkel.markEnded();
    setAfterCall(true);
  });

  async function call() {
    if (!selected || rinkel.calling) return;
    const customer = customers.find((item) => item.id === selected);
    if (!customer?.phone_e164) return;
    requestKeyRef.current ??= `rinkel.call:${crypto.randomUUID()}`;
    setError(null);
    try {
      const id = await rinkel.startCall({
        customerId: selected,
        targetPhone: customer.phone_e164,
        callbackActivityId: callbackActivityId ?? null,
        clientRequestId: crypto.randomUUID(),
        idempotencyKey: requestKeyRef.current,
      });
      setCallId(id);
      requestKeyRef.current = null;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Samtalet kunde inte startas");
    }
  }

  async function complete(event: React.FormEvent<HTMLFormElement>) {
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
    setDisposition("");
    setNotes("");
    setCallbackDueAt("");
  }

  return <div>
    <div className="dialer-status">
      <strong>Rinkel click-to-call</strong>
      <span className={`badge ${rinkel.registered ? "badge-success" : "badge-warning"}`}>
        <Radio size={12} /> {rinkel.status}
      </span>
    </div>
    <div className="phone-display">{customers.find((customer) => customer.id === selected)?.phone_e164 ?? "Välj kund"}</div>
    <label className="field dialer-customer-select">
      <span>Kund eller prospekt</span>
      <select value={selected} onChange={(event) => setSelected(event.target.value)}>
        <option value="">Välj kund</option>
        {customers.map((customer) => <option key={customer.id} value={customer.id} disabled={customer.do_not_call}>
          {customer.display_name} · {customer.phone_e164}{customer.do_not_call ? " · SPÄRRAD" : ""}
        </option>)}
      </select>
    </label>
    <button type="button" className="call-button" onClick={call}
      disabled={!rinkel.registered || !selected || afterCall || rinkel.calling}
      aria-label="Ring via Rinkel">
      <Phone size={25} />
    </button>
    {rinkel.calling ? <p className="notice">Samtalet hanteras på din Rinkel-enhet. Kundexa uppdateras av Rinkels webhookar.</p> : null}
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
      </select></label>
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
