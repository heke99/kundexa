import { z } from "zod";
import { allTemplatePlaceholders } from "./template-context";

// Coordinates are normalized against the displayed, unrotated PDF page, with
// origin at top left. The renderer rejects rotated pages instead of guessing.
const placement = z.object({ page: z.number().int().min(0).max(99), x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().positive().max(1), height: z.number().positive().max(1) }).strict();
export const pdfFieldSchema = z.object({
  id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),
  label: z.string().min(1).max(120),
  providerName: z.string().min(1).max(120),
  type: z.enum(["text", "date", "signature"]),
  source: z.string().max(120),
  required: z.boolean(),
  fontSize: z.number().min(6).max(30),
  placements: z.array(placement).min(1).max(100),
}).strict();
export const pdfCustomFieldSchema = z.object({
  id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),
  label: z.string().min(1).max(120),
  type: z.enum(["text", "date", "number"]),
  required: z.boolean(),
}).strict();
export type PdfCustomField = z.infer<typeof pdfCustomFieldSchema>;
export const pdfTemplateSchema = z.object({
  schemaVersion: z.literal(1),
  customFields: z.array(pdfCustomFieldSchema).max(50).optional(),
  storagePath: z.string().min(1).max(400),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  pageSizes: z.array(z.object({ width: z.number().positive(), height: z.number().positive() }).strict()).min(1).max(100),
  fields: z.array(pdfFieldSchema).min(1).max(200),
}).strict();
export type PdfField = z.infer<typeof pdfFieldSchema>;
export type PdfFieldTemplate = z.infer<typeof pdfTemplateSchema>;
export type FrozenPdfTemplate = { template: PdfFieldTemplate; values: Record<string, string> };

export function isTenantPdfTemplatePath(path: string, tenantId: string): boolean {
  const prefix = `${tenantId}/templates/`;
  // Storage SDK interpolates the object key into a URL. Encoded dot segments,
  // backslashes and query/hash delimiters must never reach a service client.
  return path.startsWith(prefix) && /^[A-Za-z0-9_-]+\/[a-f0-9]{64}\.pdf$/.test(path.slice(prefix.length));
}

export function validatePdfTemplate(input: unknown, tenantId: string): PdfFieldTemplate {
  const template = pdfTemplateSchema.parse(input);
  if (!isTenantPdfTemplatePath(template.storagePath, tenantId)) throw new Error("pdf_template_tenant_mismatch");
  const ids = new Set<string>();
  const names = new Set<string>();
  const sources = new Set(allTemplatePlaceholders());
  const customIds = new Set<string>();
  for (const definition of template.customFields ?? []) {
    if (customIds.has(definition.id)) throw new Error("pdf_template_duplicate_custom_field");
    customIds.add(definition.id); sources.add(`custom.${definition.id}`);
  }
  for (const field of template.fields) {
    if (ids.has(field.id) || names.has(field.providerName)) throw new Error("pdf_template_duplicate_field");
    ids.add(field.id); names.add(field.providerName);
    if (field.type === "signature") {
      if (field.source !== "") throw new Error("signature_field_cannot_be_prefilled");
    } else if (!sources.has(field.source)) throw new Error(`pdf_template_unknown_source:${field.source}`);
    if (field.type === "date" && field.source.startsWith("custom.") && template.customFields?.find(definition => `custom.${definition.id}` === field.source)?.type !== "date") throw new Error("pdf_template_custom_type_mismatch");
    if (field.type === "date" && !field.source.startsWith("custom.") && !["today", "contract.starts_on", "contract.ends_on"].includes(field.source)) throw new Error("pdf_template_date_source_required");
    for (const area of field.placements) {
      if (!template.pageSizes[area.page] || area.x + area.width > 1.000001 || area.y + area.height > 1.000001) throw new Error("pdf_template_field_outside_page");
    }
  }
  return template;
}

export function pdfCustomFields(configuration: unknown): PdfCustomField[] {
  const config = configuration as { pdf_template?: unknown } | null;
  return config?.pdf_template ? pdfTemplateSchema.parse(config.pdf_template).customFields ?? [] : [];
}

export function pdfCustomFormValues(configuration: unknown, form: FormData): Record<string, unknown> {
  return Object.fromEntries(pdfCustomFields(configuration).map(definition => [definition.id, form.get(`pdf_custom_${definition.id}`) ?? ""]));
}

function validateCustomValues(definitions: PdfCustomField[], raw: Record<string, unknown>): Record<string, string | number> {
  const known = new Set(definitions.map(definition => definition.id));
  if (Object.keys(raw).some(key => !known.has(key))) throw new Error("pdf_template_unknown_custom_value");
  const result: Record<string, string | number> = {};
  for (const definition of definitions) {
    const rawValue = raw[definition.id];
    const value = typeof rawValue === "string" ? rawValue.trim() : rawValue;
    if (value === null || value === undefined || value === "") {
      if (definition.required) throw new Error(`pdf_template_required_value:${definition.label}`);
      result[definition.id] = ""; continue;
    }
    if (definition.type === "number") {
      if (!["string", "number"].includes(typeof value) || !Number.isFinite(Number(value)) || Math.abs(Number(value)) > 1e12) throw new Error(`pdf_template_invalid_number:${definition.label}`);
      result[definition.id] = Number(value);
    } else {
      if (typeof value !== "string" || value.length > 1000) throw new Error(`pdf_template_invalid_text:${definition.label}`);
      if (definition.type === "date" && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) throw new Error(`pdf_template_invalid_date:${definition.label}`);
      result[definition.id] = value;
    }
  }
  return result;
}

export function freezePdfTemplate(configuration: unknown, context: Record<string, unknown>, tenantId: string, customValues: Record<string, unknown> = {}): FrozenPdfTemplate | null {
  const config = configuration as { pdf_template?: unknown } | null;
  if (!config?.pdf_template) {
    if (Object.keys(customValues).length) throw new Error("pdf_template_unknown_custom_value");
    return null;
  }
  const template = validatePdfTemplate(config.pdf_template, tenantId);
  const renderContext = { ...context, custom: validateCustomValues(template.customFields ?? [], customValues) } as Record<string, unknown>;
  const values: Record<string, string> = {};
  for (const field of template.fields) {
    if (field.type === "signature") continue;
    const [root, key] = field.source.split(".");
    const group = renderContext[root];
    const raw = field.type === "date" && field.source === "today" ? context.today_iso : key ? (group as Record<string, unknown> | null)?.[key] : group;
    if (raw === null || raw === undefined || raw === "") {
      if (field.required) throw new Error(`pdf_template_required_value:${field.label}`);
      values[field.id] = "";
    } else {
      if (!["string", "number", "boolean"].includes(typeof raw)) throw new Error("pdf_template_scalar_required");
      const value = typeof raw === "number" ? raw.toLocaleString("sv-SE", { maximumFractionDigits: 2, useGrouping: false }) : String(raw);
      if (field.type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`pdf_template_invalid_date:${field.label}`);
      values[field.id] = value;
    }
  }
  return { template, values };
}
