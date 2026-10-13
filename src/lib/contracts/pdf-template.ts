import { z } from "zod";
import { allTemplatePlaceholders } from "./template-context";
import type { CanonicalContractSnapshot } from "./canonical-contract-snapshot";
import { createEngineSubmission, engineDocuments, downloadEnginePdf, readEngineTemplate } from "@/lib/signing/docuseal-client";

export const pdfConfigurationSchema = z.object({
  mode: z.literal("pdf"), provider: z.literal("docuseal"), template_id: z.number().int().positive(),
  schema_hash: z.string().regex(/^[a-f0-9]{64}$/), external_id: z.string(),
  role: z.string().min(1),
  bindings: z.array(z.object({ field_id: z.uuid(), name: z.string().min(1), type: z.string(),
    source: z.string().nullable(), required: z.boolean() })),
});
export type PdfConfiguration = z.infer<typeof pdfConfigurationSchema>;

export function pdfConfiguration(signingConfiguration: unknown): PdfConfiguration | null {
  if (!signingConfiguration || typeof signingConfiguration !== "object") return null;
  const pdf = (signingConfiguration as Record<string, unknown>).pdf;
  if (!pdf) return null;
  return pdfConfigurationSchema.parse(pdf);
}

export function validatePdfBindings(config: PdfConfiguration) {
  const catalog = new Set(allTemplatePlaceholders());
  const names = new Set<string>(); const ids = new Set<string>();
  for (const binding of config.bindings) {
    if (names.has(binding.name) || ids.has(binding.field_id)) throw new Error("duplicate_pdf_field");
    names.add(binding.name); ids.add(binding.field_id);
    if (binding.source && !catalog.has(binding.source)) throw new Error("unknown_pdf_data_source");
    if (!binding.source && !["signature", "initials", "date"].includes(binding.type))
      throw new Error(`pdf_field_mapping_required:${binding.name}`);
    if (["signature", "initials"].includes(binding.type) && binding.source) throw new Error("signature_must_be_customer_action");
    if (binding.source && !["text", "date", "number"].includes(binding.type)) throw new Error("unsupported_prefill_field_type");
  }
  if (!config.bindings.some(field => field.type === "signature" && field.required)) throw new Error("required_signature_field_missing");
}

export function pdfFieldValues(config: PdfConfiguration, snapshot: CanonicalContractSnapshot) {
  validatePdfBindings(config);
  const terms = snapshot.version.commercial_terms;
  const context: Record<string, unknown> = {
    customer: snapshot.counterparty, seller: snapshot.seller,
    product: { id: terms.product_id, name: terms.product_name, sku: terms.product_sku, description: terms.product_description },
    price: terms,
    contract: { ...snapshot.contract, ...terms, special_terms: (terms.additional_terms as Record<string, unknown> | undefined)?.special_conditions },
    today: snapshot.generated_at.slice(0, 10),
  };
  const values: Record<string, string> = {};
  for (const binding of config.bindings) {
    if (!binding.source) continue;
    const [root, key] = binding.source.split(".");
    const value = key ? (context[root] as Record<string, unknown> | undefined)?.[key] : context[root];
    if ((value === null || value === undefined || value === "") && binding.required)
      throw new Error(`pdf_customer_field_missing:${binding.name}`);
    if (typeof value === "object") throw new Error("pdf_field_must_be_scalar");
    values[binding.name] = value === null || value === undefined ? "" : String(value);
  }
  return values;
}

export async function renderPdfTemplate(config: PdfConfiguration, snapshot: CanonicalContractSnapshot, tenantId: string) {
  const template = await readEngineTemplate(config.template_id);
  if (template.external_id !== config.external_id || template.schema_hash !== config.schema_hash)
    throw new Error("approved_pdf_template_changed");
  const values = pdfFieldValues(config, snapshot);
  const signer = await createEngineSubmission({ key: `preview:${tenantId}:${snapshot.version.id}`,
    templateId: config.template_id, schemaHash: config.schema_hash, role: config.role,
    name: "Förhandsgranskning", email: `preview+${snapshot.version.id}@invalid.example`,
    recipientId: `preview:${snapshot.version.id}`, values });
  const documents = await engineDocuments(signer.submission_id);
  if (documents.documents.length !== 1) throw new Error("merged_preview_document_required");
  return { bytes: await downloadEnginePdf(documents.documents[0].url), values };
}
