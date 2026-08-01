import type { ImportedRow } from "./file-parser";
import { applyFieldMapping, inferFieldMapping } from "./field-mapping";
import type { ImportFieldMapping } from "./import-profile";
import { resolveFirstJsonPath } from "./json-path";

function customerTypeForRow(row: ImportedRow, mapping: ImportFieldMapping, company: Record<string, unknown>) {
  const policy = mapping.entityType;
  if (policy.mode === "fixed_person") return "person";
  if (policy.mode === "fixed_company") return "company";
  if (policy.mode === "infer_organization_number") return company.organization_number ? "company" : "person";
  const raw = resolveFirstJsonPath(row, policy.source ?? "");
  const value = String(raw ?? "").trim().toLocaleLowerCase("sv-SE");
  if (policy.companyValues.map((item) => item.toLocaleLowerCase("sv-SE")).includes(value)) return "company";
  if (policy.personValues.map((item) => item.toLocaleLowerCase("sv-SE")).includes(value)) return "person";
  return null;
}

export function normalizeImportedRow(row: ImportedRow, mapping?: ImportFieldMapping) {
  const selectedMapping = mapping ?? inferFieldMapping(row);
  const result = applyFieldMapping(row, selectedMapping);
  const customerType = customerTypeForRow(row, selectedMapping, result.company);
  if (!customerType) result.errors.push({ code: "customer_type_unresolved", field: "entityType", message: "Kundtypen kunde inte bestämmas från importprofilen." });
  const normalized: Record<string, unknown> & { customer_type: string | null; contacts: typeof result.contacts; merge_policy: ImportFieldMapping["mergePolicy"] } = {
    ...result.company,
    customer_type: customerType,
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
