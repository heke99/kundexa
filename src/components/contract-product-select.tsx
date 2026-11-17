"use client";

import { useState } from "react";
import { customerFieldPrefill, type PdfCustomField } from "@/lib/contracts/pdf-field-template";

export type ContractCustomField = PdfCustomField;
export type ContractProductOption = { id: string; label: string; disabled: boolean; templateVersionId?: string; customFields: ContractCustomField[] };

/** Only the selected product's approved fields are successful form controls. */
export function ContractProductSelect({ products, defaultValue, customerId = "", customerValues = {} }: { products: ContractProductOption[]; defaultValue: string; customerId?: string; customerValues?: Record<string, unknown> }) {
  const [selected, setSelected] = useState(defaultValue);
  const product = products.find(item => item.id === selected && !item.disabled);
  return <>
    <label className="field"><span>Produkt</span><select name="product_id" value={selected} required onChange={event => setSelected(event.target.value)}>
      <option value="">Välj produkt</option>
      {products.map(item => <option key={item.id} value={item.id} disabled={item.disabled}>{item.label}</option>)}
    </select></label>
    {product?.customFields.length ? <fieldset key={`${customerId}:${product.id}:${product.templateVersionId ?? ""}`} className="form-stack"><legend>Uppgifter till avtalet</legend>
      <p className="muted">Kopplade kunduppgifter förifylls från kundkortet. Avtalet sparar en egen kopia; ändringar här ändrar inte kundkortet.</p>
      {product.customFields.map(field => { const prefill = customerFieldPrefill(field, customerValues); return <label className="field" key={field.id}><span>{field.label}{field.required ? " *" : " (valfritt)"}</span><input name={`pdf_custom_${field.id}`} type={field.type} defaultValue={prefill.value} required={field.required} maxLength={field.type === "text" ? 1000 : undefined} step={field.type === "number" ? "any" : undefined} />{prefill.invalid ? <small className="form-error">Kundkortets värde behöver kontrolleras. Fyll i uppgiften för avtalet.</small> : null}</label>; })}
    </fieldset> : null}
  </>;
}
