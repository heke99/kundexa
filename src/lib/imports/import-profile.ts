import { z } from "zod";

export const mappingTransformSchema = z.enum([
  "trim", "lowercase", "uppercase", "titlecase", "string", "number", "integer",
  "boolean", "date", "percent", "phone_e164", "organization_number",
]);

export const mappingRuleSchema = z.object({
  source: z.union([z.string(), z.array(z.string()).min(1)]).optional(),
  default: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  separator: z.string().max(20).optional(),
  transforms: z.array(mappingTransformSchema).max(10).optional(),
  required: z.boolean().optional(),
});

const companyTargets = [
  "display_name", "company_name", "organization_number", "legal_form", "company_status",
  "phone_e164", "alternate_phone_e164", "email", "website", "address_line1", "address_line2",
  "postal_code", "city", "municipality", "county", "country_code", "industry", "sni_code",
  "employee_count", "revenue", "result", "founded_year", "source_external_id", "source_url",
] as const;

const contactTargets = [
  "full_name", "first_name", "last_name", "title", "role", "ownership_percentage", "phone_e164",
  "alternate_phone_e164", "email", "is_primary", "is_signatory", "source_external_id",
] as const;

export const importFieldMappingSchema = z.object({
  company: z.partialRecord(z.enum(companyTargets), mappingRuleSchema).default({}),
  contacts: z.object({
    recordsPath: z.string().max(300).optional(),
    fields: z.partialRecord(z.enum(contactTargets), mappingRuleSchema).default({}),
  }).optional(),
  mergePolicy: z.enum(["safe_upsert", "create_only", "review_conflicts"]).default("safe_upsert"),
});

export type MappingTransform = z.infer<typeof mappingTransformSchema>;
export type MappingRule = z.infer<typeof mappingRuleSchema>;
export type ImportFieldMapping = z.infer<typeof importFieldMappingSchema>;

export const createImportProfileSchema = z.object({
  name: z.string().trim().min(2).max(120),
  sourceProvider: z.string().trim().min(2).max(50).default("file"),
  sourceWebsite: z.string().trim().max(80).nullable().optional(),
  format: z.enum(["csv", "json", "ndjson", "xlsx", "auto"]).default("auto"),
  worksheetName: z.string().trim().max(120).nullable().optional(),
  headerRow: z.coerce.number().int().min(1).max(100).default(1),
  recordsPath: z.string().trim().max(300).nullable().optional(),
  mapping: importFieldMappingSchema,
  targetType: z.enum(["crm", "list", "review"]).default("crm"),
  targetListId: z.uuid().nullable().optional(),
  automaticCommit: z.boolean().default(false),
});
