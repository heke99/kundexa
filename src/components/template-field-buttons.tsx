"use client";

import { useEffect, useRef, useState } from "react";

type Field = { label: string; placeholder: string };

// De uppgifter en säljare faktiskt har på kundkortet, plus produkten och priset.
// Resten av fälten finns kvar i fältreferensen för den som vill ha dem.
const groups: { title: string; fields: Field[] }[] = [
  {
    title: "Kund",
    fields: [
      { label: "Namn", placeholder: "customer.display_name" },
      { label: "Förnamn", placeholder: "customer.first_name" },
      { label: "Efternamn", placeholder: "customer.last_name" },
      { label: "Företag", placeholder: "customer.company_name" },
      { label: "Personnummer", placeholder: "customer.personal_identity_number" },
      { label: "Org.nr", placeholder: "customer.organization_number" },
      { label: "E-post", placeholder: "customer.email" },
      { label: "Telefon", placeholder: "customer.phone_e164" },
      { label: "Adress", placeholder: "customer.address_line1" },
      { label: "Postnummer", placeholder: "customer.postal_code" },
      { label: "Ort", placeholder: "customer.city" },
    ],
  },
  {
    title: "Produkt och pris",
    fields: [
      { label: "Produkt", placeholder: "product.name" },
      { label: "Månadspris", placeholder: "price.recurring_fee" },
      { label: "Startavgift", placeholder: "price.setup_fee" },
      { label: "Valuta", placeholder: "price.currency" },
      { label: "Bindningstid", placeholder: "price.binding_months" },
      { label: "Uppsägningstid", placeholder: "price.notice_months" },
    ],
  },
  {
    title: "Ert bolag",
    fields: [
      { label: "Bolagsnamn", placeholder: "seller.legal_name" },
      { label: "Org.nr", placeholder: "seller.organization_number" },
      { label: "Dagens datum", placeholder: "today" },
    ],
  },
];

const targets = ["title_template", "body_template", "terms_template"];

/**
 * Knappar som sätter in en kunduppgift där markören står.
 *
 * Att skriva `{{customer.email}}` för hand var det enda sättet att tala om var
 * e-posten ska stå, och ett stavfel syntes först när en säljare försökte skicka.
 * Här klickar man i texten och sedan på "E-post".
 */
export function TemplateFieldButtons() {
  const ref = useRef<HTMLDivElement>(null);
  const last = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);
  const [optional, setOptional] = useState(false);
  const [inserted, setInserted] = useState<string | null>(null);

  useEffect(() => {
    const form = ref.current?.closest("form");
    if (!form) return;
    const remember = (event: FocusEvent) => {
      const element = event.target;
      if ((element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) && targets.includes(element.name)) {
        last.current = element;
      }
    };
    form.addEventListener("focusin", remember);
    return () => form.removeEventListener("focusin", remember);
  }, []);

  function insert(field: Field) {
    const form = ref.current?.closest("form");
    const element = last.current ?? form?.querySelector<HTMLTextAreaElement>('textarea[name="body_template"]') ?? null;
    if (!element) return;
    const text = `{{${field.placeholder}${optional ? "?" : ""}}}`;
    const start = element.selectionStart ?? element.value.length;
    const end = element.selectionEnd ?? start;
    element.setRangeText(text, start, end, "end");
    element.focus();
    element.dispatchEvent(new Event("input", { bubbles: true }));
    setInserted(`${field.label} insatt`);
  }

  return <div ref={ref} className="notice" style={{ marginTop: 4 }}>
    <p style={{ marginBottom: 8 }}>
      <strong>Sätt in kunduppgift</strong>{" "}
      <span className="muted">Klicka i texten där uppgiften ska stå, sedan på knappen. Uppgiften hämtas från kundkortet när avtalet skapas.</span>
    </p>
    {groups.map((group) => <div key={group.title} style={{ marginBottom: 8 }}>
      <span className="muted" style={{ marginRight: 8 }}>{group.title}:</span>
      {group.fields.map((field) => <button
        key={field.placeholder}
        type="button"
        className="button button-ghost"
        style={{ padding: "2px 8px", margin: "2px 4px 2px 0", fontSize: 13 }}
        onClick={() => insert(field)}
      >{field.label}</button>)}
    </div>)}
    <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
      <input type="checkbox" checked={optional} onChange={(event) => setOptional(event.target.checked)} />
      Får vara tom — annars stoppas avtalet om uppgiften saknas på kundkortet
    </label>
    {inserted ? <p className="muted" role="status" style={{ marginTop: 6 }}>{inserted}</p> : null}
  </div>;
}
