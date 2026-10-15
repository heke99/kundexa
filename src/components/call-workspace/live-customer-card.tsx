"use client";

import { useEffect, useMemo, useState, useTransition, useImperativeHandle, useRef, type Ref } from "react";
import Link from "next/link";
import { CheckCircle2, FileSignature } from "@/components/icons";
import { loadCallCustomer, saveCallCustomer, type CallCustomer, type CallCustomerPatch } from "@/app/actions/call-workspace";

type Draft = Required<CallCustomerPatch>;
type CustomerType = CallCustomer["customerType"];

function toDraft(customer: CallCustomer): Draft {
  return {
    customerType: customer.customerType,
    displayName: customer.displayName,
    firstName: customer.firstName ?? "",
    lastName: customer.lastName ?? "",
    companyName: customer.companyName ?? "",
    organizationNumber: customer.organizationNumber ?? "",
    personalIdentityNumber: customer.personalIdentityNumber ?? "",
    email: customer.email ?? "",
    alternatePhone: customer.alternatePhone ?? "",
    addressLine1: customer.addressLine1 ?? "",
    postalCode: customer.postalCode ?? "",
    city: customer.city ?? "",
    website: customer.website ?? "",
  };
}

export type LiveCustomerCardHandle = { save: () => Promise<void> };

export function LiveCustomerCard({ customerId, heading = "Kunduppgifter", contractHref, fullCardLink = false, ref }: {
  ref?: Ref<LiveCustomerCardHandle>;
  customerId: string;
  heading?: string;
  /** Länk till hela kundkortet i ny flik; sidbyte i samma flik lägger på samtalet. */
  fullCardLink?: boolean;
  /** Visas när avtal kan skapas, t.ex. efter ett avtalsgrundande utfall. */
  contractHref?: string | null;
}) {
  const [customer, setCustomer] = useState<CallCustomer | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [pending, startTransition] = useTransition();
  const [saving, setSaving] = useState(false);
  const saveInFlight = useRef<Promise<void> | null>(null);

  useImperativeHandle(ref, () => ({ save: persist }));

  useEffect(() => {
    let cancelled = false;
    setCustomer(null); setDraft(null); setError(null); setSavedAt(null);
    void loadCallCustomer(customerId).then((result) => {
      if (cancelled) return;
      if (!result.ok) { setError(result.error); return; }
      setCustomer(result.customer);
      setDraft(toDraft(result.customer));
    }).catch(() => { if (!cancelled) setError("Kundkortet kunde inte läsas."); });
    return () => { cancelled = true; };
  }, [customerId]);

  const changed = useMemo(() => {
    if (!customer || !draft) return {} as CallCustomerPatch;
    const original = toDraft(customer);
    return Object.fromEntries(Object.entries(draft).filter(([key, value]) => original[key as keyof Draft] !== value)) as CallCustomerPatch;
  }, [customer, draft]);
  const dirty = Object.keys(changed).length > 0;

  async function persist(): Promise<void> {
    if (saveInFlight.current) return saveInFlight.current;
    if (!customer || !draft) throw new Error("Kundkortet är inte färdigläst. Försök igen.");
    if (!dirty || !customer.canEdit) return;
    const operation = (async () => {
      setError(null);
      setSaving(true);
      try {
        const result = await saveCallCustomer(customerId, changed);
        if (!result.ok) throw new Error(result.error);
        setCustomer(result.customer);
        setDraft(toDraft(result.customer));
        setSavedAt(Date.now());
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Kunduppgifterna kunde inte sparas.");
        throw caught;
      } finally { setSaving(false); }
    })();
    saveInFlight.current = operation;
    try { await operation; } finally { saveInFlight.current = null; }
  }

  if (error && !customer) return <section className="live-card"><p className="form-error">{error}</p></section>;
  if (!customer || !draft) return <section className="live-card"><p className="muted">Hämtar kundkortet…</p></section>;

  const readOnly = !customer.canEdit;
  const set = (key: keyof Draft) => (event: React.ChangeEvent<HTMLInputElement>) => {
    const next = event.target.value;
    setDraft((current) => current ? { ...current, [key]: next } : current);
    setSavedAt(null);
  };
  const input = (key: keyof Draft, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) =>
    <label className="field live-field"><span>{label}</span><input value={draft[key]} onChange={set(key)} readOnly={readOnly || pending || saving} {...props} /></label>;

  function save(event: React.FormEvent) {
    event.preventDefault();
    startTransition(async () => { try { await persist(); } catch { /* Felet visas på kortet. */ } });
  }

  const type = draft.customerType as CustomerType;
  // Byter säljaren till företag töms personnumret: ett företag har inget, och
  // servern vägrar spara ett. Organisationsnumret får stå kvar hos en privatperson
  // (enskild firma) men visas inte.
  const setType = (next: CustomerType) => {
    setDraft((current) => current ? { ...current, customerType: next, personalIdentityNumber: next === "company" ? "" : current.personalIdentityNumber } : current);
    setSavedAt(null);
  };

  return <form className="live-card" onSubmit={save}>
    <div className="live-card-header">
      <div><span className="eyebrow">{heading}</span><h3>{customer.displayName}</h3></div>
      <span className="muted">{customer.phone ?? "inget nummer"}{fullCardLink ? <> · <Link href={`/app/customers/${customer.id}`} target="_blank" rel="noopener">Hela kundkortet</Link></> : null}</span>
    </div>
    <div className="segmented" role="radiogroup" aria-label="Kundtyp">
      {(["company", "person"] as const).map((option) => <button key={option} type="button" role="radio" aria-checked={type === option}
        className={type === option ? "selected" : ""} disabled={readOnly || pending || saving} onClick={() => setType(option)}>
        {option === "company" ? "Företag" : "Privatperson"}
      </button>)}
    </div>
    <div className="live-card-grid">
      {input("displayName", "Namn på kortet", { required: true, minLength: 2 })}
      {type === "person" ? <>
        {input("firstName", "Förnamn", { autoComplete: "off" })}
        {input("lastName", "Efternamn", { autoComplete: "off" })}
        {input("personalIdentityNumber", "Personnummer", { placeholder: "ÅÅÅÅMMDD-XXXX", autoComplete: "off" })}
      </> : <>
        {input("companyName", "Företagsnamn", { autoComplete: "off" })}
        {input("organizationNumber", "Organisationsnummer", { placeholder: "556016-0680", autoComplete: "off" })}
      </>}
      {input("email", "E-post", { type: "email", autoComplete: "off" })}
      {input("alternatePhone", "Annat telefonnummer", { type: "tel", autoComplete: "off" })}
      {input("addressLine1", "Adress", { autoComplete: "off" })}
      {input("postalCode", "Postnummer", { autoComplete: "off", inputMode: "numeric" })}
      {input("city", "Ort", { autoComplete: "off" })}
    </div>
    <p className="muted">Vilka uppgifter avtalet behöver kontrolleras när du väljer produkt och leveranssätt. Ifyllda uppgifter sparas innan du går vidare.</p>
    {error ? <p className="form-error">{error}</p> : null}
    <div className="live-card-actions">
      {readOnly ? <span className="muted">Din roll kan inte ändra uppgifterna.</span>
        : <button className="button button-primary button-sm" disabled={!dirty || pending || saving}>{pending ? "Sparar…" : "Spara uppgifter"}</button>}
      {savedAt && !dirty ? <span className="live-saved"><CheckCircle2 size={14} /> Sparat</span> : null}
      {dirty && !pending ? <span className="muted">Ändringar som inte är sparade</span> : null}
      {contractHref ? <button type="button" className="button button-secondary button-sm" disabled={pending || saving} onClick={() => startTransition(async () => { try { await persist(); window.location.assign(contractHref); } catch { /* Felet visas på kortet. */ } })}><FileSignature size={14} /> Skapa avtal</button> : null}
    </div>
  </form>;
}
