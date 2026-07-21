import { normalizePhone } from "../domain/phone";
import { resolveFirstJsonPath, resolveJsonPath } from "./json-path";
import { normalizeOrganizationNumber } from "./organization-number";
import { importFieldMappingSchema, type ImportFieldMapping, type MappingRule, type MappingTransform } from "./import-profile";

export type ImportWarning = { code: string; field?: string; message: string };
export type NormalizedContact = Record<string, string | number | boolean | null>;
export type NormalizedMappedRow = {
  company: Record<string, string | number | boolean | null>;
  contacts: NormalizedContact[];
  warnings: ImportWarning[];
  errors: ImportWarning[];
};

function titleCase(value: string) {
  return value.toLocaleLowerCase("sv-SE").replace(/(^|[\s-])\p{L}/gu, (match) => match.toLocaleUpperCase("sv-SE"));
}

function parseBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const normalized = String(value).trim().toLocaleLowerCase("sv-SE");
  if (["1", "true", "yes", "ja", "j", "x"].includes(normalized)) return true;
  if (["0", "false", "no", "nej", "n", ""].includes(normalized)) return false;
  return null;
}

function parseNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const normalized = String(value).trim().replace(/\s/g, "").replace(/\.(?=\d{3}(?:\D|$))/g, "").replace(",", ".").replace(/[^\d+\-.]/g, "");
  const result = Number(normalized);
  return Number.isFinite(result) ? result : null;
}

function applyTransform(value: unknown, transform: MappingTransform): unknown {
  if (value == null) return null;
  switch (transform) {
    case "trim": return String(value).trim();
    case "lowercase": return String(value).toLocaleLowerCase("sv-SE");
    case "uppercase": return String(value).toLocaleUpperCase("sv-SE");
    case "titlecase": return titleCase(String(value).trim());
    case "string": return String(value);
    case "number": return parseNumber(value);
    case "integer": { const number = parseNumber(value); return number == null ? null : Math.trunc(number); }
    case "boolean": return parseBoolean(value);
    case "date": { const date = new Date(String(value)); return Number.isNaN(date.valueOf()) ? null : date.toISOString(); }
    case "percent": { const number = parseNumber(value); return number == null ? null : (Math.abs(number) > 1 ? number : number * 100); }
    case "phone_e164": return normalizePhone(String(value));
    case "organization_number": {
      const result = normalizeOrganizationNumber(String(value));
      if (!result.valid) throw new Error(`organization_number_${result.errorCode}`);
      return result.canonical;
    }
  }
}

function valueForRule(row: unknown, rule: MappingRule): unknown {
  const sources = typeof rule.source === "string" ? [rule.source] : rule.source ?? [];
  const values = sources
    .map((source) => resolveFirstJsonPath(row, source))
    .filter((value) => value != null && String(value).trim() !== "");
  if (!values.length) return rule.default ?? null;
  return values.length === 1 ? values[0] : values.map(String).join(rule.separator ?? " ");
}

function mapFields(
  row: unknown,
  rules: Record<string, MappingRule>,
  scope: "company" | "contact",
  warnings: ImportWarning[],
  errors: ImportWarning[],
) {
  const result: Record<string, string | number | boolean | null> = {};
  for (const [target, rule] of Object.entries(rules)) {
    let value = valueForRule(row, rule);
    try {
      for (const transform of rule.transforms ?? []) value = applyTransform(value, transform);
    } catch (error) {
      const code = error instanceof Error ? error.message : "transform_failed";
      warnings.push({ code, field: `${scope}.${target}`, message: `Värdet för ${target} kunde inte normaliseras.` });
      value = null;
    }
    if (value == null || String(value).trim() === "") {
      if (rule.required) errors.push({ code: "required_field_missing", field: `${scope}.${target}`, message: `${target} saknas.` });
      result[target] = null;
      continue;
    }
    result[target] = value as string | number | boolean;
  }
  return result;
}

export function applyFieldMapping(row: unknown, inputMapping: ImportFieldMapping): NormalizedMappedRow {
  const mapping = importFieldMappingSchema.parse(inputMapping);
  const warnings: ImportWarning[] = [];
  const errors: ImportWarning[] = [];
  const company = mapFields(row, mapping.company, "company", warnings, errors);
  if (!company.display_name && company.company_name) company.display_name = company.company_name;
  if (!company.company_name && company.display_name) company.company_name = company.display_name;
  if (!company.display_name) errors.push({ code: "display_name_required", field: "company.display_name", message: "Företagsnamn saknas." });

  const contacts: NormalizedContact[] = [];
  if (mapping.contacts) {
    const contactRows = mapping.contacts.recordsPath
      ? resolveJsonPath(row, mapping.contacts.recordsPath).flatMap((value) => Array.isArray(value) ? value : [value])
      : [row];
    for (const contactRow of contactRows) {
      const contact = mapFields(contactRow, mapping.contacts.fields, "contact", warnings, errors);
      if (!contact.full_name) {
        const joined = [contact.first_name, contact.last_name].filter(Boolean).join(" ").trim();
        if (joined) contact.full_name = joined;
      }
      if (contact.full_name || contact.phone_e164 || contact.email) contacts.push(contact);
    }
  }
  return { company, contacts, warnings, errors };
}

const companyAliases: Record<string, string[]> = {
  display_name: ["display_name", "company_name", "foretagsnamn", "företagsnamn", "namn", "name", "legal_name"],
  organization_number: ["organization_number", "organisationsnummer", "org_number", "orgnr", "org_nummer"],
  phone_e164: ["company_phone", "foretagstelefon", "företagstelefon", "telefon", "phone", "telephone"],
  alternate_phone_e164: ["alternate_phone", "telefon_2", "phone_2"],
  email: ["email", "e_post", "epost"], website: ["website", "webbplats", "hemsida"],
  address_line1: ["address", "adress", "gatuadress"], postal_code: ["postal_code", "postnummer"],
  city: ["city", "ort", "postort"], municipality: ["municipality", "kommun"], county: ["county", "lan", "län"],
  industry: ["industry", "bransch"], sni_code: ["sni_code", "sni"], employee_count: ["employee_count", "anstallda", "anställda"],
  revenue: ["revenue", "omsattning", "omsättning"], result: ["result", "resultat"],
  source_external_id: ["source_external_id", "external_id", "id"], source_url: ["source_url", "url", "link"],
};

const contactAliases: Record<string, string[]> = {
  full_name: ["owner_name", "agare", "ägare", "contact_name", "kontaktperson", "vd", "full_name"],
  phone_e164: ["owner_mobile", "agare_mobil", "ägare_mobil", "contact_mobile", "mobil", "mobile"],
  email: ["owner_email", "contact_email"], role: ["owner_role", "contact_role", "roll", "title", "titel"],
  ownership_percentage: ["ownership_percentage", "agarandel", "ägarandel"],
};

export function inferFieldMapping(sample: Record<string, unknown>): ImportFieldMapping {
  const keys = new Set(Object.keys(sample));
  const company: Record<string, MappingRule> = {};
  for (const [target, aliases] of Object.entries(companyAliases)) {
    const source = aliases.find((alias) => keys.has(alias));
    if (source) {
      const transforms: MappingTransform[] = target.includes("phone") ? ["phone_e164"]
        : target === "organization_number" ? ["organization_number"]
        : ["employee_count", "founded_year"].includes(target) ? ["integer"]
        : ["revenue", "result"].includes(target) ? ["number"]
        : ["trim"];
      company[target] = { source, transforms, required: target === "display_name" };
    }
  }
  const contactFields: Record<string, MappingRule> = {};
  for (const [target, aliases] of Object.entries(contactAliases)) {
    const source = aliases.find((alias) => keys.has(alias));
    if (source) {
      const transforms: MappingTransform[] = target.includes("phone") ? ["phone_e164"]
        : target === "ownership_percentage" ? ["percent"]
        : ["is_primary", "is_signatory"].includes(target) ? ["boolean"]
        : ["trim"];
      contactFields[target] = { source, transforms };
    }
  }
  return importFieldMappingSchema.parse({ company, ...(Object.keys(contactFields).length ? { contacts: { fields: contactFields } } : {}), mergePolicy: "safe_upsert" });
}
