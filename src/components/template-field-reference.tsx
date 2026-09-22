import { templateContextFields, templateContextRoots, templateScalarRoots } from "@/lib/contracts/template-context";

/**
 * Fältreferensen, hopfälld.
 *
 * Den låg tidigare utfälld under formuläret: två textblock och varje fältnamn i
 * systemet, permanent. Den som skriver en mall behöver den en gång per fält och
 * aldrig mer, men alla andra fick läsa förbi den varje gång. Uppslagsverk hör
 * hemma i en låda man öppnar.
 */
export function TemplateFieldReference() {
  return <details className="notice" style={{ marginTop: 12 }}>
    <summary style={{ cursor: "pointer" }}><strong>Fält du kan använda</strong> <span className="muted">— klicka för listan</span></summary>
    <p style={{ marginTop: 10 }}>
      Skriv <code>{"{{customer.display_name}}"}</code> där kundens uppgift ska in; systemet fyller i den från kundkortet vid utskicket.
      Ett tomt fält stoppar avtalet innan det skickas, med namnet på det som fattas. Vill du tillåta tomt, sätt ett frågetecken sist:
      {" "}<code>{"{{customer.email?}}"}</code> visar ingenting, <code>{"{{customer.organization_number?saknas}}"}</code> visar <em>saknas</em>.
    </p>
    {templateContextRoots.map((root) => <p key={root} style={{ marginTop: 8 }}>
      <strong>{root}</strong>{" · "}
      {templateContextFields[root].map((field, index) => <span key={field}>{index ? ", " : ""}<code>{`{{${root}.${field}}}`}</code></span>)}
    </p>)}
    <p style={{ marginTop: 8 }}>{templateScalarRoots.map((root) => <code key={root}>{`{{${root}}}`}</code>)}</p>
  </details>;
}
