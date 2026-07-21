"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Phone, PhoneOff, Pause, Play, StickyNote } from "@/components/icons";
import { useWebRtcVoice } from "@/hooks/use-webrtc-voice";
import { useCallRealtime } from "@/hooks/use-call-realtime";

type Disposition = { key: string; label: string; outcome_group: string; terminal: boolean; retry_after_minutes: number | null; requires_note: boolean; requires_callback: boolean; requires_order: boolean };
type Product = { id: string; name: string };
type PhoneOption = {
  contactPersonId: string | null;
  source: "company" | "contact";
  label: string;
  phone: string;
  eligibility: "eligible" | "pending_nix" | "blocked";
};
type ContactPerson = {
  id: string; fullName: string; firstName?: string | null; lastName?: string | null; title?: string | null; role?: string | null;
  phone?: string | null; alternatePhone?: string | null; email?: string | null; isPrimary: boolean;
  ownershipPercentage?: number | null; isSignatory: boolean;
};
type Claim = {
  empty: boolean;
  sessionId: string;
  memberId?: string;
  callbackActivityId?: string | null;
  mode?: "manual" | "automatic";
  autoNextDelaySeconds?: number;
  allowSkip?: boolean;
  script?: string | null;
  contacts?: ContactPerson[];
  phoneOptions?: PhoneOption[];
  defaultTarget?: PhoneOption | null;
  customer?: {
    id: string; displayName: string; customerType: string; companyName?: string | null; organizationNumber?: string | null;
    phone?: string | null; email?: string | null; address?: string | null; industry?: string | null; sniCode?: string | null;
    callAttempts: number; lastContactAt?: string | null; notes?: { id: string; body: string; isPinned: boolean; createdAt: string }[];
  };
};
type Phase = "idle" | "loading" | "ready" | "dialing" | "calling" | "after_call" | "paused" | "ended" | "empty" | "error";

function cleanError(value: string) { return value.replaceAll("_", " ").replace("outside list calling hours", "Listan är utanför tillåten ringtid"); }

export function ListDialerWorkspace({ listId, listName, mode, dispositions, products }: {
  listId: string; listName: string; mode: "manual" | "automatic"; dispositions: Disposition[]; products: Product[];
}) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [claim, setClaim] = useState<Claim | null>(null);
  const [callId, setCallId] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [dispositionKey, setDispositionKey] = useState("");
  const [notes, setNotes] = useState("");
  const [callbackScope, setCallbackScope] = useState<"personal" | "global">("personal");
  const [callbackDueAt, setCallbackDueAt] = useState("");
  const [createOrder, setCreateOrder] = useState(false);
  const [productId, setProductId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [unitPrice, setUnitPrice] = useState("");
  const [selectedTargetKey, setSelectedTargetKey] = useState("");
  const selectedDisposition = useMemo(() => dispositions.find((item) => item.key === dispositionKey), [dispositionKey, dispositions]);
  const voice = useWebRtcVoice(() => setPhase("after_call"));
  useCallRealtime(callId, () => setPhase("after_call"));

  useEffect(() => { if (voice.calling) setPhase("calling"); }, [voice.calling]);
  useEffect(() => { if (selectedDisposition?.requires_order) setCreateOrder(true); }, [selectedDisposition]);

  async function requestJson(url: string, body: object) {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new Error(String(data.error ?? "request_failed"));
    return data;
  }

  function phoneOptionKey(option: PhoneOption) { return `${option.contactPersonId ?? "company"}:${option.phone}`; }

  async function claimNext(activeSessionId: string, autoDial: boolean) {
    setPhase("loading"); setError(null); setCallId(null); setDispositionKey(""); setNotes(""); setCallbackDueAt(""); setCreateOrder(false); setProductId(""); setSelectedTargetKey("");
    try {
      const next = await requestJson("/api/v1/dialer/next", { listId, sessionId: activeSessionId }) as unknown as Claim;
      setClaim(next);
      if (next.empty || !next.customer || !next.memberId) { setPhase("empty"); return; }
      const defaultTarget = next.defaultTarget ?? next.phoneOptions?.find((option) => option.eligibility === "eligible") ?? null;
      if (!defaultTarget || defaultTarget.eligibility !== "eligible") {
        setError("Prospektet saknar ett ringbart nummer med godkänd kontaktpolicy.");
        setPhase("ready");
        return;
      }
      setSelectedTargetKey(phoneOptionKey(defaultTarget));
      setPhase("ready");
      if (autoDial) await dial(next, defaultTarget);
    } catch (caught) { setError(cleanError(caught instanceof Error ? caught.message : "next_failed")); setPhase("error"); }
  }

  async function begin() {
    setPhase("loading"); setError(null);
    try {
      const data = await requestJson("/api/v1/dialer/sessions", { listId });
      const id = String(data.sessionId);
      setSessionId(id);
      await claimNext(id, mode === "automatic");
    } catch (caught) { setError(cleanError(caught instanceof Error ? caught.message : "session_failed")); setPhase("error"); }
  }

  async function dial(target = claim, explicitTarget?: PhoneOption | null) {
    if (!target?.customer || !target.memberId || !sessionId && !target.sessionId) return;
    const selectedTarget = explicitTarget
      ?? target.phoneOptions?.find((option) => phoneOptionKey(option) === selectedTargetKey)
      ?? target.defaultTarget
      ?? null;
    if (!selectedTarget || selectedTarget.eligibility !== "eligible") {
      setError("Välj ett ringbart nummer innan samtalet startas.");
      setPhase("ready");
      return;
    }
    setPhase("dialing"); setError(null);
    try {
      const id = await voice.startCall({
        customerId: target.customer.id,
        sessionId: sessionId ?? target.sessionId,
        listMemberId: target.memberId,
        callbackActivityId: target.callbackActivityId ?? null,
        contactPersonId: selectedTarget.contactPersonId,
        targetPhone: selectedTarget.phone,
        idempotencyKey: `list.call:${target.memberId}:${selectedTarget.phone}:${crypto.randomUUID()}`,
      });
      setCallId(id);
    } catch (caught) { setError(cleanError(caught instanceof Error ? caught.message : "call_failed")); setPhase("ready"); }
  }

  async function pause(reason: "paused" | "skip" | "end") {
    if (!sessionId) return;
    if (voice.calling) voice.hangup();
    try {
      await requestJson("/api/v1/dialer/pause", { sessionId, reason });
      setClaim(null); setCallId(null); setPhase(reason === "skip" ? "loading" : reason === "end" ? "ended" : "paused");
      if (reason === "skip") await claimNext(sessionId, mode === "automatic");
    } catch (caught) { setError(cleanError(caught instanceof Error ? caught.message : "pause_failed")); setPhase("error"); }
  }

  async function completeAfterCall(event: React.FormEvent) {
    event.preventDefault();
    if (!callId || !selectedDisposition || !sessionId) return;
    setPhase("loading"); setError(null);
    try {
      await requestJson("/api/v1/dialer/complete", {
        callId,
        dispositionKey,
        notes: notes || null,
        callbackScope: selectedDisposition.requires_callback ? callbackScope : null,
        callbackDueAt: selectedDisposition.requires_callback && callbackDueAt ? callbackDueAt : null,
        createOrder,
        productId: createOrder ? productId || null : null,
        quantity: createOrder ? Number(quantity || 1) : null,
        unitPrice: createOrder && unitPrice ? Number(unitPrice) : null,
        idempotencyKey: `dialer.complete:${callId}`,
      });
      const delay = claim?.autoNextDelaySeconds ?? 0;
      if (mode === "automatic") {
        if (delay) await new Promise((resolve) => window.setTimeout(resolve, delay * 1000));
        await claimNext(sessionId, true);
      } else await claimNext(sessionId, false);
    } catch (caught) { setError(cleanError(caught instanceof Error ? caught.message : "after_call_failed")); setPhase("after_call"); }
  }

  return <div className="dialer-workspace">
    <audio ref={voice.audioRef} autoPlay />
    <div className="dialer-workspace-header">
      <div><span className="eyebrow">{mode === "automatic" ? "Automatisk sekventiell dialer" : "Manuell lista"}</span><h2>{listName}</h2></div>
      <div className="toolbar-right">
        <Badge className={voice.registered ? "badge-success" : "badge-warning"}>{voice.status}</Badge>
        {sessionId && ["ready", "empty"].includes(phase) ? <button className="button button-secondary button-sm" type="button" onClick={() => pause("paused")}><Pause size={14} /> Pausa</button> : null}
        {sessionId && ["ready", "empty", "paused"].includes(phase) ? <button className="button button-ghost button-sm" type="button" onClick={() => pause("end")}>Avsluta session</button> : null}
      </div>
    </div>
    {error ? <p className="form-error">{error}</p> : null}
    {phase === "idle" || phase === "paused" || phase === "error" ? <div className="dialer-start"><Play size={34} /><h3>{phase === "paused" ? "Ringsessionen är pausad" : "Starta ringsession"}</h3><p>{mode === "automatic" ? "Första samtalet startar när du klickar. Därefter hämtas nästa prospekt automatiskt först efter avslutat efterarbete." : "Systemet låser nästa prospekt åt dig. Du bestämmer när varje samtal startar."}</p><button className="button button-primary" type="button" onClick={begin} disabled={!voice.registered}><Play size={16} /> {phase === "paused" ? "Fortsätt" : "Starta"}</button></div> : null}
    {phase === "loading" ? <div className="dialer-start"><span className="spinner" /><h3>Synkroniserar nästa arbetsuppgift…</h3></div> : null}
    {phase === "ended" ? <div className="dialer-start"><h3>Ringsessionen är avslutad</h3><p>Alla lås är släppta och sessionens sluttid är sparad.</p><Link className="button button-secondary" href="/app/dialer">Till dialern</Link></div> : null}
    {phase === "empty" ? <div className="dialer-start"><h3>Listan är färdig för tillfället</h3><p>Det finns inga tillgängliga prospekt eller förfallna återkomster just nu.</p><button className="button button-secondary" type="button" onClick={() => sessionId && claimNext(sessionId, false)}>Kontrollera igen</button></div> : null}
    {claim?.customer && ["ready", "dialing", "calling", "after_call"].includes(phase) ? <div className="dialer-customer-layout">
      <section className="dialer-customer-card">
        <div className="customer-identity"><span className="avatar">{claim.customer.displayName.slice(0, 2).toUpperCase()}</span><div><h2>{claim.customer.displayName}</h2><p>{claim.customer.customerType === "company" ? "Företag" : "Privatperson"} · {claim.customer.organizationNumber ?? "Identifiering saknas"}</p></div></div>
        <dl className="key-value"><dt>Telefon</dt><dd>{claim.customer.phone ?? "—"}</dd><dt>E-post</dt><dd>{claim.customer.email ?? "—"}</dd><dt>Adress</dt><dd>{claim.customer.address || "—"}</dd><dt>Bransch / SNI</dt><dd>{[claim.customer.industry, claim.customer.sniCode].filter(Boolean).join(" · ") || "—"}</dd><dt>Tidigare försök</dt><dd>{claim.customer.callAttempts}</dd><dt>Senast kontaktad</dt><dd>{claim.customer.lastContactAt ? new Date(claim.customer.lastContactAt).toLocaleString("sv-SE") : "Aldrig"}</dd></dl>
        {claim.phoneOptions?.length ? <label className="field"><span>Nummer att ringa</span><select value={selectedTargetKey} onChange={(event) => setSelectedTargetKey(event.target.value)} disabled={phase !== "ready"}>{claim.phoneOptions.map((option) => <option key={phoneOptionKey(option)} value={phoneOptionKey(option)} disabled={option.eligibility !== "eligible"}>{option.label} · {option.phone}{option.eligibility === "pending_nix" ? " · inväntar NIX" : option.eligibility === "blocked" ? " · blockerad" : ""}</option>)}</select></label> : <p className="form-error">Inget ringbart nummer finns.</p>}
        <div className="dialer-call-controls">
          {phase === "ready" ? <button className="call-button" type="button" onClick={() => dial()} disabled={!voice.registered}><Phone size={25} /></button> : null}
          {phase === "dialing" ? <Badge className="badge-info">Kopplar samtalet…</Badge> : null}
          {phase === "calling" ? <button className="call-button hangup" type="button" onClick={voice.hangup}><PhoneOff size={25} /></button> : null}
          {phase === "ready" && claim.allowSkip ? <button className="button button-ghost button-sm" type="button" onClick={() => pause("skip")}>Hoppa över</button> : null}
        </div>
        <Link className="muted" href={`/app/customers/${claim.customer.id}`}>Öppna fullständigt kundkort</Link>
      </section>
      <aside className="dialer-context-panel">
        {claim.script ? <div className="script-box"><h3>Samtalsmanus</h3><p>{claim.script}</p></div> : null}
        {claim.contacts?.length ? <div><h3>Kontaktpersoner</h3>{claim.contacts.map((contact) => <div className="note-preview" key={contact.id}><strong>{contact.fullName}{contact.isPrimary ? " · Primär" : ""}</strong><p>{[contact.role, contact.title].filter(Boolean).join(" · ") || "Kontaktperson"}</p><p>{[contact.phone, contact.alternatePhone, contact.email].filter(Boolean).join(" · ")}</p></div>)}</div> : null}
        <div><h3><StickyNote size={16} /> Tidigare anteckningar</h3>{claim.customer.notes?.length ? claim.customer.notes.map((note) => <div className="note-preview" key={note.id}><strong>{note.isPinned ? "Fäst anteckning" : new Date(note.createdAt).toLocaleDateString("sv-SE")}</strong><p>{note.body}</p></div>) : <p className="muted">Inga anteckningar ännu.</p>}</div>
      </aside>
    </div> : null}
    {phase === "after_call" && callId ? <form className="after-call-panel" onSubmit={completeAfterCall}>
      <div><h2>Efterarbete</h2><p className="muted">Välj ett utfall innan nästa prospekt kan hämtas.</p></div>
      <label className="field"><span>Samtalsutfall</span><select required value={dispositionKey} onChange={(event) => setDispositionKey(event.target.value)}><option value="">Välj utfall</option>{dispositions.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}</select></label>
      <label className="field"><span>Anteckning</span><textarea value={notes} onChange={(event) => setNotes(event.target.value)} required={selectedDisposition?.requires_note} /></label>
      {selectedDisposition?.requires_callback ? <div className="form-grid"><label className="field"><span>Återkomsttyp</span><select value={callbackScope} onChange={(event) => setCallbackScope(event.target.value as "personal" | "global")}><option value="personal">Personlig återkomst</option><option value="global">Global teamåterkomst</option></select></label><label className="field"><span>Tid för återkomst</span><input type="datetime-local" required value={callbackDueAt} onChange={(event) => setCallbackDueAt(event.target.value)} /></label></div> : null}
      <label className="check-row"><input type="checkbox" checked={createOrder} disabled={selectedDisposition?.requires_order} onChange={(event) => setCreateOrder(event.target.checked)} /> Skapa order från samtalet</label>
      {createOrder ? <div className="form-grid"><label className="field"><span>Produkt</span><select required value={productId} onChange={(event) => setProductId(event.target.value)}><option value="">Välj produkt</option>{products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}</select></label><label className="field"><span>Antal</span><input type="number" min="0.0001" step="any" value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label><label className="field"><span>Pris per enhet (valfritt)</span><input type="number" min="0" step="0.01" value={unitPrice} onChange={(event) => setUnitPrice(event.target.value)} /></label></div> : null}
      <button className="button button-primary" disabled={!dispositionKey}>Spara och {mode === "automatic" ? "ring nästa" : "hämta nästa"}</button>
    </form> : null}
  </div>;
}
