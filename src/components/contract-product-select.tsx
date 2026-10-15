"use client";

import { useState } from "react";
import type { PdfCustomField } from "@/lib/contracts/pdf-field-template";

export type ContractCustomField = PdfCustomField;
export type ContractProductOption = { id: string; label: string; disabled: boolean; customFields: ContractCustomField[] };

/** Only the selected product's approved fields are successful form controls. */
export function ContractProductSelect({ products, defaultValue }: { products: ContractProductOption[]; defaultValue: string }) {
  const [selected, setSelected] = useState(defaultValue);
  const product = products.find(item => item.id === selected && !item.disabled);
  return <>
    <label className="field"><span>Produkt</span><select name="product_id" value={selected} required onChange={event => setSelected(event.target.value)}>
      <option value="">Välj produkt</option>
      {products.map(item => <option key={item.id} value={item.id} disabled={item.disabled}>{item.label}</option>)}
    </select></label>
    {product?.customFields.length ? <fieldset key={product.id} className="form-stack"><legend>Uppgifter till avtalet</legend>
      <p className="muted">Dessa uppgifter gäller endast det här avtalet och ändrar inte kundkortet.</p>
      {product.customFields.map(field => <label className="field" key={field.id}><span>{field.label}{field.required ? " *" : " (valfritt)"}</span><input name={`pdf_custom_${field.id}`} type={field.type} required={field.required} maxLength={field.type === "text" ? 1000 : undefined} step={field.type === "number" ? "any" : undefined} /></label>)}
    </fieldset> : null}
  </>;
}
