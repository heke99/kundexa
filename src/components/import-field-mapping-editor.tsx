"use client";

import { useMemo, useState } from "react";
import { updateImportMapping } from "@/app/actions/imports";

type JsonObject = Record<string, unknown>;
type ColumnSample = { name: string; example: string; normalizedExample?: string };
type TargetOption = { value: string; label: string; transforms: string[] };

const companyTargets: TargetOption[] = [
  { value: "company.display_name", label: "Företag · Visningsnamn", transforms: ["trim"] },
  { value: "company.company_name", label: "Företag · Företagsnamn", transforms: ["trim"] },
  { value: "company.organization_number", label: "Företag · Organisationsnummer", transforms: ["organization_number"] },
  { value: "company.legal_form", label: "Företag · Bolagsform", transforms: ["trim"] },
  { value: "company.company_status", label: "Företag · Status", transforms: ["trim", "lowercase"] },
  { value: "company.phone_e164", label: "Företag · Telefon", transforms: ["phone_e164"] },
  { value: "company.alternate_phone_e164", label: "Företag · Alternativ telefon", transforms: ["phone_e164"] },
  { value: "company.email", label: "Företag · E-post", transforms: ["trim", "lowercase"] },
  { value: "company.website", label: "Företag · Webbplats", transforms: ["trim", "lowercase"] },
  { value: "company.address_line1", label: "Företag · Adress", transforms: ["trim"] },
  { value: "company.address_line2", label: "Företag · Adressrad 2", transforms: ["trim"] },
  { value: "company.postal_code", label: "Företag · Postnummer", transforms: ["trim"] },
  { value: "company.city", label: "Företag · Ort", transforms: ["trim", "titlecase"] },
  { value: "company.municipality", label: "Företag · Kommun", transforms: ["trim", "titlecase"] },
  { value: "company.county", label: "Företag · Län", transforms: ["trim", "titlecase"] },
  { value: "company.country_code", label: "Företag · Landskod", transforms: ["trim", "uppercase"] },
  { value: "company.industry", label: "Företag · Bransch", transforms: ["trim"] },
  { value: "company.sni_code", label: "Företag · SNI-kod", transforms: ["trim"] },
  { value: "company.employee_count", label: "Företag · Antal anställda", transforms: ["integer"] },
  { value: "company.revenue", label: "Företag · Omsättning", transforms: ["number"] },
  { value: "company.result", label: "Företag · Resultat", transforms: ["number"] },
  { value: "company.founded_year", label: "Företag · Grundat år", transforms: ["integer"] },
  { value: "company.source_external_id", label: "Företag · Externt ID", transforms: ["string", "trim"] },
  { value: "company.source_url", label: "Företag · Käll-URL", transforms: ["trim"] },
];

const contactTargets: TargetOption[] = [
  { value: "contact.full_name", label: "Kontakt · Fullständigt namn", transforms: ["trim"] },
  { value: "contact.first_name", label: "Kontakt · Förnamn", transforms: ["trim", "titlecase"] },
  { value: "contact.last_name", label: "Kontakt · Efternamn", transforms: ["trim", "titlecase"] },
  { value: "contact.title", label: "Kontakt · Titel", transforms: ["trim"] },
  { value: "contact.role", label: "Kontakt · Roll", transforms: ["trim"] },
  { value: "contact.ownership_percentage", label: "Kontakt · Ägarandel", transforms: ["percent"] },
  { value: "contact.phone_e164", label: "Kontakt · Mobil/telefon", transforms: ["phone_e164"] },
  { value: "contact.alternate_phone_e164", label: "Kontakt · Alternativ telefon", transforms: ["phone_e164"] },
  { value: "contact.email", label: "Kontakt · E-post", transforms: ["trim", "lowercase"] },
  { value: "contact.is_primary", label: "Kontakt · Primär kontakt", transforms: ["boolean"] },
  { value: "contact.is_signatory", label: "Kontakt · Firmatecknare", transforms: ["boolean"] },
  { value: "contact.source_external_id", label: "Kontakt · Externt ID", transforms: ["string", "trim"] },
];

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function ruleSources(rule: unknown): string[] {
  const source = objectValue(rule).source;
  if (typeof source === "string") return [source];
  return Array.isArray(source) ? source.filter((item): item is string => typeof item === "string") : [];
}

function ruleTransforms(rule: unknown): string[] {
  const transforms = objectValue(rule).transforms;
  return Array.isArray(transforms) ? transforms.filter((item): item is string => typeof item === "string") : [];
}

function initialAssignments(mapping: JsonObject, scope: "company" | "contact") {
  const result: Record<string, string> = {};
  const rules = scope === "company"
    ? objectValue(mapping.company)
    : objectValue(objectValue(mapping.contacts).fields);
  for (const [target, rule] of Object.entries(rules)) {
    for (const source of ruleSources(rule)) result[source] = `${scope}.${target}`;
  }
  return result;
}

function initialTransformValues(mapping: JsonObject, scope: "company" | "contact") {
  const result: Record<string, string> = {};
  const rules = scope === "company"
    ? objectValue(mapping.company)
    : objectValue(objectValue(mapping.contacts).fields);
  for (const [target, rule] of Object.entries(rules)) result[`${scope}.${target}`] = ruleTransforms(rule).join(", ");
  return result;
}

function defaultTransforms(target: string) {
  return [...companyTargets, ...contactTargets].find((option) => option.value === target)?.transforms.join(", ") ?? "trim";
}

function buildRules(columns: ColumnSample[], assignments: Record<string, string>, transforms: Record<string, string>, scope: "company" | "contact") {
  const rules: Record<string, { source: string | string[]; transforms?: string[] }> = {};
  for (const column of columns) {
    const target = assignments[column.name];
    if (!target?.startsWith(`${scope}.`)) continue;
    const field = target.slice(scope.length + 1);
    const current = rules[field];
    const source = current
      ? Array.isArray(current.source) ? [...current.source, column.name] : [current.source, column.name]
      : column.name;
    const chain = (transforms[target] ?? defaultTransforms(target)).split(",").map((item) => item.trim()).filter(Boolean);
    rules[field] = { source, ...(chain.length ? { transforms: chain } : {}) };
  }
  return rules;
}

function MappingRows({ columns, options, assignments, setAssignments, transforms, setTransforms }: {
  columns: ColumnSample[];
  options: TargetOption[];
  assignments: Record<string, string>;
  setAssignments: (value: Record<string, string>) => void;
  transforms: Record<string, string>;
  setTransforms: (value: Record<string, string>) => void;
}) {
  return <div className="table-wrap"><table className="data-table"><thead><tr><th>Inkommande fält</th><th>Exempelvärde</th><th>Kundexa-fält</th><th>Transformkedja</th><th>Status</th></tr></thead><tbody>
    {columns.map((column) => {
      const target = assignments[column.name] ?? "";
      return <tr key={column.name}>
        <td><code>{column.name}</code></td>
        <td>{column.example || "—"}</td>
        <td><select value={target} onChange={(event) => {
          const next = { ...assignments, [column.name]: event.target.value };
          setAssignments(next);
          if (event.target.value && !transforms[event.target.value]) setTransforms({ ...transforms, [event.target.value]: defaultTransforms(event.target.value) });
        }}><option value="">Ignorera</option>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></td>
        <td>{target ? <input aria-label={`Transformkedja för ${column.name}`} value={transforms[target] ?? defaultTransforms(target)} onChange={(event) => setTransforms({ ...transforms, [target]: event.target.value })} placeholder="trim, lowercase" /> : "—"}</td>
        <td><span className={`badge ${target ? "badge-success" : "badge-info"}`}>{target ? "Mappad" : "Ignorerad"}</span></td>
      </tr>;
    })}
  </tbody></table></div>;
}

export function ImportFieldMappingEditor({ importRunId, initialMapping, companyColumns, contactColumns, initialContactRecordsPath }: {
  importRunId: string;
  initialMapping: JsonObject;
  companyColumns: ColumnSample[];
  contactColumns: ColumnSample[];
  initialContactRecordsPath: string;
}) {
  const [companyAssignments, setCompanyAssignments] = useState(() => initialAssignments(initialMapping, "company"));
  const [contactAssignments, setContactAssignments] = useState(() => initialAssignments(initialMapping, "contact"));
  const [transforms, setTransforms] = useState(() => ({ ...initialTransformValues(initialMapping, "company"), ...initialTransformValues(initialMapping, "contact") }));
  const [contactRecordsPath, setContactRecordsPath] = useState(initialContactRecordsPath);
  const [mergePolicy, setMergePolicy] = useState(String(initialMapping.mergePolicy ?? "safe_upsert"));
  const mapping = useMemo(() => ({
    company: buildRules(companyColumns, companyAssignments, transforms, "company"),
    ...(contactColumns.length || contactRecordsPath ? { contacts: { recordsPath: contactRecordsPath || undefined, fields: buildRules(contactColumns, contactAssignments, transforms, "contact") } } : {}),
    mergePolicy,
  }), [companyColumns, companyAssignments, contactColumns, contactAssignments, contactRecordsPath, mergePolicy, transforms]);

  return <form action={updateImportMapping} className="form-stack">
    <input type="hidden" name="import_run_id" value={importRunId} />
    <input type="hidden" name="mapping_json" value={JSON.stringify(mapping)} />
    <div className="form-grid two">
      <label className="field"><span>Merge-policy</span><select value={mergePolicy} onChange={(event) => setMergePolicy(event.target.value)}><option value="safe_upsert">Säker upsert</option><option value="create_only">Skapa endast nya</option><option value="review_conflicts">Granska konflikter</option></select></label>
      <label className="field"><span>Kontaktpersonernas records path</span><input value={contactRecordsPath} onChange={(event) => setContactRecordsPath(event.target.value)} placeholder="owners eller contacts" /></label>
    </div>
    <h3>Företagsfält</h3>
    <MappingRows columns={companyColumns} options={companyTargets} assignments={companyAssignments} setAssignments={setCompanyAssignments} transforms={transforms} setTransforms={setTransforms} />
    {contactColumns.length ? <><h3>Kontaktpersonsfält</h3><MappingRows columns={contactColumns} options={contactTargets} assignments={contactAssignments} setAssignments={setContactAssignments} transforms={transforms} setTransforms={setTransforms} /></> : <div className="notice">Ingen kontaktarray hittades i exempelraden. Ange korrekt records path och ladda om, eller använd profilens sparade kontaktmappning.</div>}
    <details><summary>Genererad versionsbar mappning</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(mapping, null, 2)}</pre></details>
    <div className="notice warning">Tillåtna mål och transformsteg valideras server-side. Okända mål, osäkra sökvägar och ogiltiga transformkedjor avvisas.</div>
    <button className="button button-primary">Validera och applicera mappning</button>
  </form>;
}
