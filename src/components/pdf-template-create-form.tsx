import { createPdfContractTemplate } from "@/app/actions/templates";
import { Field, SelectField } from "@/components/ui/form-field";

export function PdfTemplateCreateForm({ products, legalEntities, templateId, productId, name, audience, legalEntityId }: {
  products: Array<{id:string;name:string}>; legalEntities:Array<{id:string;legal_name:string}>;
  templateId?:string;productId?:string;name?:string;audience?:string;legalEntityId?:string;
}) {
  return <form action={createPdfContractTemplate} className="form-stack">
    <h3>{templateId ? "Ny PDF-version" : "Skapa avtal från PDF"}</h3>
    <input type="hidden" name="template_id" value={templateId ?? ""} />
    <Field label="Mallens namn" name="name" defaultValue={name ?? ""} required />
    <SelectField label="Produkt" name="product_id" defaultValue={productId ?? ""} required>
      <option value="">Välj produkt</option>{products.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
    </SelectField>
    <SelectField label="Avsändarbolag" name="legal_entity_id" defaultValue={legalEntityId ?? ""} required>
      <option value="">Välj bolag</option>{legalEntities.map(p=><option key={p.id} value={p.id}>{p.legal_name}</option>)}
    </SelectField>
    <SelectField label="Målgrupp" name="audience" defaultValue={audience ?? "B2B"}>
      <option value="B2B">Företag</option><option value="B2C">Privatperson</option><option value="BOTH">Båda</option>
    </SelectField>
    <label className="field"><span>Avtal med fullständiga villkor</span><input type="file" name="file" accept="application/pdf" required /></label>
    <button className="button button-primary">Ladda upp PDF och placera fält</button>
  </form>;
}
