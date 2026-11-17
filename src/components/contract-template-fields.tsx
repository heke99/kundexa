"use client";
import { useState } from "react";
import { PdfTemplateBuilder } from "@/components/pdf-template-builder";
import { pdfCustomFields, type PdfCustomField, type PdfFieldTemplate } from "@/lib/contracts/pdf-field-template";

export function ContractTemplateFields({ initial = [], pdf }: { initial?: PdfCustomField[]; pdf?: PdfFieldTemplate | null }) {
  const [fields, setFields] = useState(() => pdfCustomFields({ custom_fields: initial, ...(pdf ? { pdf_template: pdf } : {}) }));
  const [initialPdf] = useState(() => pdf ? { ...pdf, customFields: (pdf.customFields ?? []).filter(field => !fields.some(item => item.id === field.id)) } : null);
  const update = (index: number, patch: Partial<PdfCustomField>) => setFields(current => current.map((field, i) => i === index ? { ...field, ...patch } : field));
  return <>
    <fieldset className="form-stack"><legend>Uppgifter som behövs från kunden</legend>
      <p className="muted">Lägg till exempelvis anläggnings-ID, nätägare eller startdatum. Fälten gäller den här mallversionen. Använd text för identifierare med inledande nollor.</p>
      <input type="hidden" name="custom_fields" value={JSON.stringify(fields)} />
      {fields.map((field, index) => <fieldset className="form-stack" key={index}>
        <legend>{field.label}</legend>
        <label>Fältnamn <input value={field.label} required maxLength={120} onChange={e => update(index, { label: e.target.value })} /></label>
        <label>Variabelnamn <input value={field.id} required pattern="[a-zA-Z][a-zA-Z0-9_-]{0,63}" maxLength={64} onChange={e => update(index, { id: e.target.value })} /></label>
        <label>Typ <select value={field.type} onChange={e => update(index, { type: e.target.value as PdfCustomField["type"] })}><option value="text">Text / ID</option><option value="number">Tal</option><option value="date">Datum</option></select></label>
        <label className="check-row"><input type="checkbox" checked={field.required} onChange={e => update(index, { required: e.target.checked })} /> Obligatoriskt</label>
        <label>Koppling till kundkortet (valfritt) <input value={field.customerKey ?? ""} placeholder="anlaggning_id" pattern="[a-zA-Z][a-zA-Z0-9_-]{0,63}" onChange={e => update(index, { customerKey: e.target.value || undefined })} /></label>
        <small>I avtalstexten: <code>{`{{custom.${field.id}${field.required ? "" : "?"}}}`}</code>. PDF-fält kan kopplas till samma uppgift nedan.</small>
        <button type="button" className="button button-ghost" onClick={() => setFields(current => current.filter((_, i) => i !== index))}>Ta bort fält</button>
      </fieldset>)}
      <button type="button" className="button button-secondary" disabled={fields.length >= 50} onClick={() => setFields(current => [...current, { id: `uppgift_${crypto.randomUUID().replaceAll("-", "")}`, label: "Ny kunduppgift", type: "text", required: true }])}>Lägg till kunduppgift</button>
    </fieldset>
    <PdfTemplateBuilder initial={initialPdf} customFields={fields} managedCustomFields />
  </>;
}
