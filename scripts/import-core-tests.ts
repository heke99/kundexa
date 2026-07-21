import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { normalizeOrganizationNumber, passesLuhn } from "../src/lib/imports/organization-number";
import { parseJsonPath, resolveJsonPath, resolveRecordsPath } from "../src/lib/imports/json-path";
import { parseImportFile } from "../src/lib/imports/file-parser";
import { inferFieldMapping, applyFieldMapping } from "../src/lib/imports/field-mapping";

async function main() {
assert.equal(passesLuhn("5560160680"), true);
for (const value of ["556016-0680", "5560160680", "165560160680", "SE556016068001"]) {
  const normalized = normalizeOrganizationNumber(value);
  assert.equal(normalized.valid, true, `Expected valid organization number: ${value}`);
  assert.equal(normalized.canonical, "5560160680");
}
assert.equal(normalizeOrganizationNumber("556016-0681").errorCode, "invalid_luhn");
assert.equal(normalizeOrganizationNumber("850709-9805").errorCode, "person_number_not_allowed");

assert.deepEqual(parseJsonPath("data.companies[*].owners[0]"), ["data", "companies", "*", "owners", 0]);
const nested = { data: { companies: [{ name: "A" }, { name: "B" }] } };
assert.deepEqual(resolveRecordsPath(nested, "data.companies[*]"), [{ name: "A" }, { name: "B" }]);
assert.deepEqual(resolveJsonPath(nested, "data.companies[1].name"), ["B"]);
assert.throws(() => parseJsonPath("data.__proto__.constructor()"), /json_path/);

const csv = Buffer.from("\uFEFFFöretagsnamn;Organisationsnummer;Ägare;Mobil\nTest AB;556016-0680;Anna Andersson;0701234567\n", "utf8");
const parsedCsv = await parseImportFile(csv, "allabolag.csv", "text/csv");
assert.equal(parsedCsv.rows.length, 1);
assert.deepEqual(parsedCsv.columns, ["foretagsnamn", "organisationsnummer", "agare", "mobil"]);
const inferred = inferFieldMapping(parsedCsv.rows[0]);
const mapped = applyFieldMapping(parsedCsv.rows[0], inferred);
assert.equal(mapped.company.display_name, "Test AB");
assert.equal(mapped.company.organization_number, "5560160680");
assert.equal(mapped.contacts[0]?.full_name, "Anna Andersson");
assert.equal(mapped.contacts[0]?.phone_e164, "+46701234567");
assert.equal(mapped.company.phone_e164, undefined, "Owner mobile must not leak into company phone");

const parsedJson = await parseImportFile(
  Buffer.from(JSON.stringify({ allabolag_companies: [{ company_name: "Nested AB", owners: [{ name: "Owner" }] }] })),
  "allabolag.json",
  "application/json",
  { recordsPath: "allabolag_companies[*]" },
);
assert.equal(parsedJson.rows.length, 1);
assert.equal(parsedJson.recordsPath, "allabolag_companies[*]");
assert.ok(Array.isArray(parsedJson.rows[0].owners));

const workbook = new ExcelJS.Workbook();
const first = workbook.addWorksheet("Företag");
first.addRow(["Företagsnamn", "Organisationsnummer", "Omsättning"]);
first.addRow(["Excel AB", "556016-0680", { formula: "1+1", result: 2 }]);
const second = workbook.addWorksheet("Personer");
second.addRow(["Namn", "Mobil"]);
second.addRow(["Anna Andersson", "0046701234567"]);
const xlsxBytes = await workbook.xlsx.writeBuffer();
const parsedXlsx = await parseImportFile(Buffer.from(xlsxBytes), "parsehub.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", { worksheetName: "Företag" });
assert.deepEqual(parsedXlsx.worksheets, ["Företag", "Personer"]);
assert.equal(parsedXlsx.selectedWorksheet, "Företag");
assert.equal(parsedXlsx.rows[0].omsattning, 2, "Formula cached result should be read, not executed");

const rows = ["Företagsnamn;Organisationsnummer"];
for (let index = 0; index < 5_000; index += 1) rows.push(`Företag ${index};556016-0680`);
const started = performance.now();
const bulk = await parseImportFile(Buffer.from(rows.join("\n")), "bulk.csv", "text/csv", { maxRows: 5_000 });
assert.equal(bulk.rows.length, 5_000);
assert.ok(performance.now() - started < 15_000, "5,000-row parser test exceeded 15 seconds");

console.log("Import core tests passed: organization numbers, safe JSON paths, CSV/BOM/semicolon, nested JSON, XLSX worksheets/formula results, mapping separation and 5,000-row parsing.");
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
