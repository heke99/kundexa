"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { CheckCircle2, FileSignature } from "@/components/icons";
import { loadCallCustomer, saveCallCustomer, type CallCustomer, type CallCustomerPatch } from "@/app/actions/call-workspace";

type Draft = Required<CallCustomerPatch>;

function toDraft(customer: CallCustomer): Draft {
  return {
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

/**
 * Det avtalet hämtar från kundkortet. Visas som en checklista medan säljaren
 * har kunden i luren, så att det som saknas kan frågas efter direkt i stället
 * för att upptäckas på avtalssidan efter att samtalet är slut.
 */
function contractReadiness(draft: Draft, type: CallCustomer["customerType"]) {
  return [
    { label: type === "person" ? "Personnummer" : "Organisationsnummer", done: Boolean(type === "person" ? draft.personalIdentityNumber : draft.organizationNumber) },
    { label: "E-post", done: Boolean(draft.email) },
    { label: "Adress", done: Boolean(draft.addressLine1 && draft.postalCode && draft.city) },
  ];
}

export function LiveCustomerCard({ customerId, heading = "Kunduppgifter", contractHref, fullCardLink = false }: {
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

  if (error && !customer) return <section className="live-card"><p className="form-error">{error}</p></section>;
  if (!customer || !draft) return <section className="live-card"><p className="muted">Hämtar kundkortet…</p></section>;

  const readOnly = !customer.canEdit;
  const set = (key: keyof Draft) => (event: React.ChangeEvent<HTMLInputElement>) => {
    const next = event.target.value;
    setDraft((current) => current ? { ...current, [key]: next } : current);
    setSavedAt(null);
  };
  const input = (key: keyof Draft, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) =>
    <label className="field live-field"><span>{label}</span><input value={draft[key]} onChange={set(key)} readOnly={readOnly} {...props} /></label>;

  function save(event: React.FormEvent) {
    event.preventDefault();
    if (!dirty || readOnly) return;
    setError(null);
    startTransition(async () => {
      const result = await saveCallCustomer(customerId, changed);
      if (!result.ok) { setError(result.error); return; }
      setCustomer(result.customer);
      setDraft(toDraft(result.customer));
      setSavedAt(Date.now());
    });
  }

  const readiness = contractReadiness(draft, customer.customerType);
  return <form className="live-card" onSubmit={save}>
    <div className="live-card-header">
      <div><span className="eyebrow">{heading}</span><h3>{customer.displayName}</h3></div>
      <span className="muted">{customer.customerType === "person" ? "Privatperson" : "Företag"} · {customer.phone ?? "inget nummer"}{fullCardLink ? <> · <Link href={`/app/customers/${customer.id}`} target="_blank" rel="noopener">Hela kundkortet</Link></> : null}</span>
    </div>
    <div className="live-card-grid">
      {input("displayName", "Namn på kortet", { required: true, minLength: 2 })}
      {customer.customerType === "person" ? <>
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
    <ul className="readiness" aria-label="Underlag för avtal">
      {readiness.map((item) => <li key={item.label} className={item.done ? "done" : ""}><CheckCircle2 size={13} /> {item.label}</li>)}
    </ul>
    {error ? <p className="form-error">{error}</p> : null}
    <div className="live-card-actions">
      {readOnly ? <span className="muted">Din roll kan inte ändra uppgifterna.</span>
        : <button className="button button-primary button-sm" disabled={!dirty || pending}>{pending ? "Sparar…" : "Spara uppgifter"}</button>}
      {savedAt && !dirty ? <span className="live-saved"><CheckCircle2 size={14} /> Sparat</span> : null}
      {dirty && !pending ? <span className="muted">Ändringar som inte är sparade</span> : null}
      {contractHref ? <Link className="button button-secondary button-sm" href={contractHref} target="_blank" rel="noopener"><FileSignature size={14} /> Skapa avtal</Link> : null}
    </div>
  </form>;
}
