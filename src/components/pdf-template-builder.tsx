"use client";

import { useEffect, useRef, useState, type PointerEvent } from "react";
import type { PdfCustomField } from "@/lib/contracts/pdf-field-template";
import type { PDFDocumentProxy, PDFDocumentLoadingTask } from "pdfjs-dist";
import { allTemplatePlaceholders } from "@/lib/contracts/template-context";
import type { PdfField, PdfFieldTemplate } from "@/lib/contracts/pdf-field-template";

// PDF.js paints the actual page; pointer coordinates refer to this same viewport.
export function PdfTemplateBuilder({ initial }: { initial?: PdfFieldTemplate | null }) {
  const [template, setTemplate] = useState<PdfFieldTemplate | null>(initial ?? null);
  const [pageIndex, setPageIndex] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const previousDestroy = useRef<Promise<void>>(Promise.resolve());
  const previousRender = useRef<Promise<unknown>>(Promise.resolve());
  const drag = useRef<{ id: string; startX: number; startY: number; x: number; y: number } | null>(null);
  const selectedField = template?.fields.find(field => field.id === selected);
  const sourceUrl = template ? `/api/v1/contract-templates/pdf?path=${encodeURIComponent(template.storagePath)}` : null;

  // Load a source once. Recreating/destroying the shared PDF.js worker for
  // every page change races its teardown and can leave the next page waiting.
  useEffect(() => {
    let cancelled = false;
    let task: PDFDocumentLoadingTask | undefined;
    setPdfDocument(null);
    setError("");
    if (!sourceUrl) return;
    void (async () => {
      await previousDestroy.current;
      const pdfjs = await import("pdfjs-dist");
      if (cancelled) return;
      pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
      task = pdfjs.getDocument({ url: sourceUrl });
      const pdf = await task.promise;
      if (!cancelled) setPdfDocument(pdf);
    })().catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : "PDF-filen kunde inte visas."); });
    return () => {
      cancelled = true;
      if (task) previousDestroy.current = task.destroy().catch(() => {});
    };
  }, [sourceUrl]);

  useEffect(() => {
    if (!pdfDocument) return;
    let cancelled = false;
    let renderCancel: (() => void) | undefined;
    void (async () => {
      await previousRender.current;
      if (cancelled) return;
      const page = await pdfDocument.getPage(pageIndex + 1);
      if (cancelled || !canvasRef.current) return;
      const viewport = page.getViewport({ scale: 1.4 });
      const canvas = canvasRef.current;
      canvas.width = viewport.width; canvas.height = viewport.height;
      const render = page.render({ canvas, viewport });
      renderCancel = () => render.cancel();
      previousRender.current = render.promise.catch(() => {});
      await render.promise;
    })().catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : "PDF-sidan kunde inte visas."); });
    return () => { cancelled = true; renderCancel?.(); };
  }, [pdfDocument, pageIndex]);

  function updateField(patch: Partial<PdfField>) {
    setTemplate(current => current ? { ...current, fields: current.fields.map(field => field.id === selected ? { ...field, ...patch } : field) } : current);
  }
  async function upload(file: File) {
    setBusy(true); setError("");
    try {
      const form = new FormData(); form.set("file", file);
      const response = await fetch("/api/v1/contract-templates/pdf", { method: "POST", body: form });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "PDF-filen kunde inte sparas.");
      setTemplate({ schemaVersion: 1, ...data, fields: [] }); setPageIndex(0); setSelected(null);
    } catch (e) { setError(e instanceof Error ? e.message : "PDF-filen kunde inte sparas."); }
    finally { setBusy(false); }
  }
  function addCustomField() {
    const id = `custom_${crypto.randomUUID().replaceAll("-", "")}`;
    setTemplate(current => current ? { ...current, customFields: [...(current.customFields ?? []), { id, label: "Avtalsuppgift", type: "text", required: true }] } : current);
  }
  function updateCustomField(id: string, patch: Partial<PdfCustomField>) {
    setTemplate(current => current ? { ...current, customFields: (current.customFields ?? []).map(field => field.id === id ? { ...field, ...patch } : field) } : current);
  }
  function addField() {
    const id = `field_${crypto.randomUUID().replaceAll("-", "")}`;
    const field: PdfField = { id, label: "Kundnamn", providerName: id, type: "text", source: "customer.display_name", required: true, fontSize: 11, placements: [{ page: pageIndex, x: .1, y: .1, width: .45, height: .045 }] };
    setTemplate(current => current ? { ...current, fields: [...current.fields, field] } : current); setSelected(id);
  }
  function move(event: PointerEvent<HTMLDivElement>) {
    if (!drag.current || !template) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const active = drag.current;
    setTemplate(current => current ? { ...current, fields: current.fields.map(field => field.id !== active.id ? field : { ...field, placements: field.placements.map(area => area.page !== pageIndex ? area : { ...area, x: Math.max(0, Math.min(1 - area.width, active.x + (event.clientX - active.startX) / bounds.width)), y: Math.max(0, Math.min(1 - area.height, active.y + (event.clientY - active.startY) / bounds.height)) }) }) } : current);
  }
  return <fieldset className="form-stack" disabled={busy}>
    <legend>PDF med kundfält (valfritt)</legend>
    <p className="muted">Ladda upp en PDF utan formulärfält. Placera och koppla fälten. Text som inte ryms stoppas före utskick. Ändringar blir en ny mallversion.</p>
    <input type="hidden" name="pdf_template" value={template ? JSON.stringify(template) : ""} />
    <input aria-label="Ladda upp PDF-mall" type="file" accept="application/pdf,.pdf" onChange={e => { const file = e.currentTarget.files?.[0]; e.currentTarget.value = ""; if (file) void upload(file); }} />
    {error ? <p role="alert" className="form-error">{error}</p> : null}
    {template ? <>
      <details><summary>Uppgifter som säljaren fyller i för varje avtal</summary>
        <div className="form-stack">
          <p className="muted">Definiera kompletteringar som bara gäller avtalet. Koppla dem sedan till placerade PDF-fält nedanför.</p>
          {(template.customFields ?? []).map(field => <fieldset key={field.id} className="form-stack"><legend>{field.label}</legend>
            <label>Fältnamn <input value={field.label} maxLength={120} required onChange={event => updateCustomField(field.id, { label: event.target.value })} /></label>
            <label>Uppgiftstyp <select value={field.type} onChange={event => updateCustomField(field.id, { type: event.target.value as PdfCustomField["type"] })}><option value="text">Text</option><option value="date">Datum</option><option value="number">Tal</option></select></label>
            <label><input type="checkbox" checked={field.required} onChange={event => updateCustomField(field.id, { required: event.target.checked })} /> Säljaren måste fylla i</label>
            <button type="button" className="button button-ghost" onClick={() => setTemplate(current => current ? { ...current, customFields: (current.customFields ?? []).filter(item => item.id !== field.id), fields: current.fields.filter(item => item.source !== `custom.${field.id}`) } : current)}>Ta bort avtalsuppgift och kopplade PDF-fält</button>
          </fieldset>)}
          <button type="button" className="button button-secondary" onClick={addCustomField}>Lägg till avtalsuppgift</button>
        </div>
      </details>
      <div className="toolbar-left">
        <label>Sida <select value={pageIndex} onChange={e => setPageIndex(Number(e.target.value))}>{template.pageSizes.map((_, index) => <option key={index} value={index}>{index + 1}</option>)}</select></label>
        <button type="button" className="button button-secondary" onClick={addField}>Lägg till fält</button>
        <button type="button" className="button button-ghost" onClick={() => setTemplate(null)}>Använd textmall i stället</button>
      </div>
      <div style={{ position: "relative", width: "100%", touchAction: "none" }} onPointerMove={move} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
        <canvas ref={canvasRef} style={{ width: "100%", height: "auto", display: "block" }} />
        {template.fields.flatMap(field => field.placements.filter(area => area.page === pageIndex).map((area, index) => <button type="button" key={`${field.id}-${index}`} aria-label={`Flytta ${field.label}`} onPointerDown={event => { setSelected(field.id); drag.current = { id: field.id, startX: event.clientX, startY: event.clientY, x: area.x, y: area.y }; event.currentTarget.setPointerCapture(event.pointerId); }} onClick={() => setSelected(field.id)} style={{ position: "absolute", left: `${area.x * 100}%`, top: `${area.y * 100}%`, width: `${area.width * 100}%`, height: `${area.height * 100}%`, border: `2px solid ${selected === field.id ? "#075e4c" : "#638e83"}`, background: "#dff3e8cc", cursor: "move", fontSize: 11, overflow: "hidden" }}>{field.label}</button>))}
      </div>
      <label>Redigera fält <select value={selected ?? ""} onChange={e => setSelected(e.target.value)}><option value="">Välj fält</option>{template.fields.map(field => <option key={field.id} value={field.id}>{field.label}</option>)}</select></label>
      {selectedField ? <div className="form-stack">
        <label>Etikett <input value={selectedField.label} onChange={e => updateField({ label: e.target.value })} /></label>
        <label>Typ <select value={selectedField.type} onChange={e => { const type = e.target.value as PdfField["type"]; updateField({ type, source: type === "signature" ? "" : type === "date" ? "contract.starts_on" : "customer.display_name" }); }}><option value="text">Text</option><option value="date">Datum</option><option value="signature">Kundens underskrift</option></select></label>
        {selectedField.type !== "signature" ? <label>Kund- eller avtalsuppgift <select value={selectedField.source} onChange={e => updateField({ source: e.target.value })}>{allTemplatePlaceholders().filter(source => selectedField.type !== "date" || ["today", "contract.starts_on", "contract.ends_on"].includes(source)).map(source => <option key={source} value={source}>{source}</option>)}{(template.customFields ?? []).filter(field => selectedField.type !== "date" || field.type === "date").map(field => <option key={field.id} value={`custom.${field.id}`}>Avtalsuppgift: {field.label}</option>)}</select></label> : <p>Underskriften fylls av kunden genom en konfigurerad signeringstjänst.</p>}
        <label><input type="checkbox" checked={selectedField.required} onChange={e => updateField({ required: e.target.checked })} /> Obligatoriskt</label>
        <label>Textstorlek <input type="number" min={6} max={30} value={selectedField.fontSize} onChange={e => updateField({ fontSize: Number(e.target.value) })} /></label>
        {(["x", "y", "width", "height"] as const).map(key => <label key={key}>{({ x: "Vänster (%)", y: "Överkant (%)", width: "Bredd (%)", height: "Höjd (%)" })[key]} <input type="number" min={0} max={100} step={.1} value={Number((selectedField.placements[0][key] * 100).toFixed(2))} onChange={e => updateField({ placements: selectedField.placements.map((area, index) => index === 0 ? { ...area, [key]: Number(e.target.value) / 100 } : area) })} /></label>)}
        <button type="button" className="button button-ghost" onClick={() => { setTemplate(current => current ? { ...current, fields: current.fields.filter(field => field.id !== selected) } : null); setSelected(null); }}>Ta bort fält</button>
      </div> : null}
    </> : null}
  </fieldset>;
}
