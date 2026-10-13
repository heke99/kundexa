"use client";
import { useState } from "react";

type PdfField = { uuid: string; name: string; type: string };
export function PdfTemplateEditor({ versionId, hasDraft, configured, sources }: {
  versionId: string; hasDraft: boolean; configured: boolean; sources: string[];
}) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [builder, setBuilder] = useState(""); const [fields, setFields] = useState<PdfField[]>([]);
  const [mapping, setMapping] = useState<Record<string,string>>({}); const [saved, setSaved] = useState(configured);
  async function post(body: FormData | Record<string,unknown>) {
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/templates/${versionId}/pdf`, { method: "POST",
        ...(body instanceof FormData ? { body } : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Kunde inte spara PDF-mallen.");
      if (result.builder_url) setBuilder(result.builder_url);
      if (result.snapshot) setFields(result.snapshot.data.fields);
      if (result.saved) { setSaved(true); setBuilder(""); }
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Kunde inte läsa PDF-mallen."); }
    finally { setBusy(false); }
  }
  return <section className="form-stack">
    <h3>PDF med kundkortsfält</h3>
    {saved ? <p className="notice">PDF och fältkopplingar är sparade. Godkänn mallversionen när du har granskat avtalet. Ändringar kräver en ny version.</p> : <>
      <p>Ladda upp avtalet, placera fälten på PDF:en och koppla dem till kundkortet.</p>
      <form onSubmit={event => { event.preventDefault(); void post(new FormData(event.currentTarget)); }} className="form-stack">
        <label className="field"><span>Avtal som PDF</span><input name="file" type="file" accept="application/pdf" required /></label>
        <button className="button button-secondary" disabled={busy}>Ladda upp och placera fält</button>
      </form>
      {hasDraft ? <button className="button button-ghost" disabled={busy} onClick={() => void post({ action: "load" })}>Öppna PDF-mallen</button> : null}
      {builder ? <>
        <iframe title="Placera avtalsfält" src={builder} referrerPolicy="no-referrer" style={{ width: "100%", height: 720, border: "1px solid #dde5df" }} />
        <button className="button button-secondary" disabled={busy} onClick={() => void post({ action: "load" })}>Hämta fälten och välj kunduppgifter</button>
      </> : null}
      {fields.length ? <>
        {fields.map(field => <label className="field" key={field.uuid}><span>{field.name}</span>
          {["signature","initials"].includes(field.type) ? <span>Kunden fyller i under signeringen</span>
            : <select value={mapping[field.uuid] ?? ""} onChange={event => setMapping(old => ({ ...old, [field.uuid]: event.target.value }))}>
                <option value="">{field.type === "date" ? "Kunden fyller i datum" : "Välj uppgift"}</option>
                {sources.map(source => <option key={source} value={source}>{source}</option>)}
              </select>}
        </label>)}
        <button className="button button-primary" disabled={busy} onClick={() => void post({ action: "save",
          bindings: fields.map(field => ({ field_id: field.uuid, source: mapping[field.uuid] || null })) })}>Spara PDF och fältkopplingar</button>
      </> : null}
    </>}
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {busy ? <p className="muted">Arbetar…</p> : null}
  </section>;
}
