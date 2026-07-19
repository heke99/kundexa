"use client";

import { useRef, useState } from "react";
import { Phone, PhoneOff, Radio } from "@/components/icons";
import { useWebRtcVoice } from "@/hooks/use-webrtc-voice";
import { useCallRealtime } from "@/hooks/use-call-realtime";

type Customer = { id: string; display_name: string; phone_e164: string | null; do_not_call: boolean };

export function WebRtcDialer({ customers, initialCustomer, callbackActivityId }: { customers: Customer[]; initialCustomer?: string; callbackActivityId?: string }) {
  const [selected, setSelected] = useState(initialCustomer ?? "");
  const [callId, setCallId] = useState<string | null>(null);
  const [afterCall, setAfterCall] = useState(false);
  const [disposition, setDisposition] = useState("");
  const [notes, setNotes] = useState("");
  const [callbackScope, setCallbackScope] = useState<"personal" | "global">("personal");
  const [callbackDueAt, setCallbackDueAt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const requestKeyRef = useRef<string | null>(null);
  const voice = useWebRtcVoice(() => { if (callId) setAfterCall(true); });
  useCallRealtime(callId, () => setAfterCall(true));

  async function call() {
    if (voice.calling) { voice.hangup(); return; }
    if (!selected) return;
    requestKeyRef.current ??= `webrtc.call:${crypto.randomUUID()}`;
    try {
      const id = await voice.startCall({ customerId: selected, callbackActivityId: callbackActivityId ?? null, idempotencyKey: requestKeyRef.current });
      setCallId(id);
      requestKeyRef.current = null;
    } catch { /* status is displayed by the shared voice hook */ }
  }

  async function complete(event: React.FormEvent) {
    event.preventDefault();
    if (!callId || !disposition) return;
    setError(null);
    const response = await fetch("/api/v1/calls/complete", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        callId, disposition, notes: notes || null,
        callbackScope: disposition === "callback" ? callbackScope : null,
        callbackDueAt: disposition === "callback" ? callbackDueAt : null,
      }),
    });
    const result = await response.json() as { error?: string };
    if (!response.ok) { setError((result.error ?? "after_call_failed").replaceAll("_", " ")); return; }
    setAfterCall(false); setCallId(null); setDisposition(""); setNotes(""); setCallbackDueAt("");
  }

  return <div>
    <audio ref={voice.audioRef} autoPlay />
    <div className="dialer-status"><strong>Kundexa WebRTC</strong><span className={`badge ${voice.registered ? "badge-success" : "badge-warning"}`}><Radio size={12} /> {voice.status}</span></div>
    <div className="phone-display">{customers.find((customer) => customer.id === selected)?.phone_e164 ?? "Välj kund"}</div>
    <div className="dialpad">{["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"].map((key) => <button key={key} type="button" aria-label={`Knapp ${key}`}>{key}</button>)}</div>
    <label className="field dialer-customer-select"><span>Kund eller prospekt</span><select value={selected} onChange={(event) => setSelected(event.target.value)}><option value="">Välj kund</option>{customers.map((customer) => <option key={customer.id} value={customer.id} disabled={customer.do_not_call}>{customer.display_name} · {customer.phone_e164}{customer.do_not_call ? " · SPÄRRAD" : ""}</option>)}</select></label>
    <button type="button" className="call-button" onClick={call} disabled={!voice.registered || !selected || afterCall} aria-label={voice.calling ? "Lägg på" : "Ring"}>{voice.calling ? <PhoneOff size={25} /> : <Phone size={25} />}</button>
    {afterCall && callId ? <form className="manual-after-call" onSubmit={complete}>
      <h3>Efterarbete</h3><p>Registrera utfallet innan du ringer nästa nummer.</p>
      {error ? <p className="form-error">{error}</p> : null}
      <label className="field"><span>Samtalsutfall</span><select required value={disposition} onChange={(event) => setDisposition(event.target.value)}><option value="">Välj utfall</option><option value="interested">Intresserad</option><option value="callback">Återkomst</option><option value="not_interested">Inte intresserad</option><option value="no_answer">Inget svar</option><option value="busy">Upptaget</option><option value="voicemail">Telefonsvarare</option><option value="wrong_number">Fel nummer</option><option value="do_not_call">Ring inte igen</option></select></label>
      <label className="field"><span>Anteckning</span><textarea value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
      {disposition === "callback" ? <><label className="field"><span>Återkomsttyp</span><select value={callbackScope} onChange={(event) => setCallbackScope(event.target.value as "personal" | "global")}><option value="personal">Personlig</option><option value="global">Global teamkö</option></select></label><label className="field"><span>Tidpunkt</span><input type="datetime-local" required value={callbackDueAt} onChange={(event) => setCallbackDueAt(event.target.value)} /></label></> : null}
      <button className="button button-primary">Spara efterarbete</button>
    </form> : null}
  </div>;
}
