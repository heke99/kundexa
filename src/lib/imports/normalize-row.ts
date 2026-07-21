import type { ImportedRow } from "./file-parser";
import { applyFieldMapping, inferFieldMapping } from "./field-mapping";
import type { ImportFieldMapping } from "./import-profile";

export function normalizeImportedRow(row: ImportedRow, mapping?: ImportFieldMapping) {
  const selectedMapping = mapping ?? inferFieldMapping(row);
  const result = applyFieldMapping(row, selectedMapping);
  const normalized: Record<string, unknown> & { customer_type: string; contacts: typeof result.contacts; merge_policy: ImportFieldMapping["mergePolicy"] } = {
    ...result.company,
    customer_type: "company",
    contacts: result.contacts,
    merge_policy: selectedMapping.mergePolicy,
  };
  return {
    errors: result.errors.map((issue) => issue.code),
    warnings: result.warnings.map((issue) => issue.code),
    issues: [...result.errors, ...result.warnings],
    normalized,
    mapping: selectedMapping,
  };
}
