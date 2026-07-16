import Papa from "papaparse";
import { inflateRawSync } from "node:zlib";

export type ImportedRow = Record<string, string | number | boolean | null>;
export type ParsedImportFile = { sourceType: "csv" | "json" | "ndjson" | "xml" | "xlsx"; rows: ImportedRow[]; parserErrors: Array<{ row?: number; message: string }> };
const MAX_ROWS = 10_000;

function normalizeHeader(value: string) {
  return value.trim().toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}
function normalizeObject(input: Record<string, unknown>): ImportedRow {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [normalizeHeader(key), value == null ? null : typeof value === "object" ? JSON.stringify(value) : value as string | number | boolean]));
}
function rowsFromJsonValue(value: unknown): ImportedRow[] {
  const candidate = Array.isArray(value) ? value : value && typeof value === "object" ? ["rows", "data", "records", "items", "results"].map((key) => (value as Record<string, unknown>)[key]).find(Array.isArray) : null;
  if (!Array.isArray(candidate)) throw new Error("json_array_or_rows_property_required");
  return candidate.slice(0, MAX_ROWS).map((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error(`json_row_${index + 1}_must_be_object`);
    return normalizeObject(row as Record<string, unknown>);
  });
}
function decodeXml(value: string) {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&").trim();
}
function parseXmlRows(xml: string): ImportedRow[] {
  const rows: ImportedRow[] = [];
  const rowPattern = /<(row|record|item)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
  for (const match of xml.matchAll(rowPattern)) {
    const row: ImportedRow = {};
    for (const child of match[2].matchAll(/<([A-Za-z_][\w:.-]*)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g)) row[normalizeHeader(child[1].split(":").pop() ?? child[1])] = decodeXml(child[2].replace(/<[^>]+>/g, ""));
    if (Object.keys(row).length) rows.push(row);
    if (rows.length >= MAX_ROWS) break;
  }
  if (!rows.length) throw new Error("xml_row_record_or_item_elements_required");
  return rows;
}

type ZipEntry = { compression: number; compressedSize: number; localOffset: number };
function unzipEntries(buffer: Buffer) {
  let eocd = -1;
  for (let index = buffer.length - 22; index >= Math.max(0, buffer.length - 65_557); index--) if (buffer.readUInt32LE(index) === 0x06054b50) { eocd = index; break; }
  if (eocd < 0) throw new Error("xlsx_zip_directory_missing");
  const count = buffer.readUInt16LE(eocd + 10); let offset = buffer.readUInt32LE(eocd + 16); const entries = new Map<string, ZipEntry>();
  for (let index = 0; index < count; index++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("xlsx_zip_entry_invalid");
    const compression = buffer.readUInt16LE(offset + 10); const compressedSize = buffer.readUInt32LE(offset + 20); const nameLength = buffer.readUInt16LE(offset + 28); const extraLength = buffer.readUInt16LE(offset + 30); const commentLength = buffer.readUInt16LE(offset + 32); const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8"); entries.set(name, { compression, compressedSize, localOffset }); offset += 46 + nameLength + extraLength + commentLength;
  }
  const read = (name: string) => { const entry = entries.get(name); if (!entry) return null; const local = entry.localOffset; if (buffer.readUInt32LE(local) !== 0x04034b50) throw new Error("xlsx_local_entry_invalid"); const nameLength = buffer.readUInt16LE(local + 26); const extraLength = buffer.readUInt16LE(local + 28); const data = buffer.subarray(local + 30 + nameLength + extraLength, local + 30 + nameLength + extraLength + entry.compressedSize); if (entry.compression === 0) return data; if (entry.compression === 8) return inflateRawSync(data); throw new Error(`xlsx_compression_${entry.compression}_unsupported`); };
  return { entries, read };
}
function columnIndex(reference: string) { let result = 0; for (const char of reference.replace(/\d/g, "")) result = result * 26 + char.toUpperCase().charCodeAt(0) - 64; return result - 1; }
function parseXlsx(buffer: Buffer): ImportedRow[] {
  const zip = unzipEntries(buffer); const sharedXml = zip.read("xl/sharedStrings.xml")?.toString("utf8") ?? "";
  const shared = [...sharedXml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)].map((item) => decodeXml([...item[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((part) => part[1]).join("")));
  const worksheetName = [...zip.entries.keys()].filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).sort()[0]; if (!worksheetName) throw new Error("xlsx_worksheet_missing");
  const sheet = zip.read(worksheetName)?.toString("utf8") ?? ""; const matrix: string[][] = [];
  for (const rowMatch of sheet.matchAll(/<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/g)) {
    const row: string[] = [];
    for (const cell of rowMatch[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
      const ref = /\br="([A-Z]+\d+)"/.exec(cell[1])?.[1]; if (!ref) continue; const type = /\bt="([^"]+)"/.exec(cell[1])?.[1]; const raw = /<v>([\s\S]*?)<\/v>/.exec(cell[2])?.[1] ?? /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/.exec(cell[2])?.[1] ?? ""; row[columnIndex(ref)] = type === "s" ? shared[Number(raw)] ?? "" : decodeXml(raw);
    }
    matrix.push(row); if (matrix.length > MAX_ROWS) break;
  }
  if (matrix.length < 2) throw new Error("xlsx_header_and_data_rows_required"); const headers = matrix[0].map((entry, index) => normalizeHeader(entry || `column_${index + 1}`));
  return matrix.slice(1, MAX_ROWS + 1).filter((row) => row.some((value) => String(value ?? "").trim())).map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? null])));
}

export function parseImportFile(buffer: Buffer, fileName: string, mimeType: string): ParsedImportFile {
  const extension = fileName.toLowerCase().split(".").pop();
  if (extension === "xlsx" || mimeType.includes("spreadsheetml")) return { sourceType: "xlsx", rows: parseXlsx(buffer), parserErrors: [] };
  const text = buffer.toString("utf8").replace(/^\uFEFF/, "");
  if (extension === "json" || mimeType === "application/json") return { sourceType: "json", rows: rowsFromJsonValue(JSON.parse(text)), parserErrors: [] };
  if (extension === "ndjson" || extension === "jsonl" || mimeType.includes("ndjson")) { const parserErrors: Array<{ row?: number; message: string }> = []; const rows: ImportedRow[] = []; text.split(/\r?\n/).forEach((line, index) => { if (!line.trim() || rows.length >= MAX_ROWS) return; try { const parsed = JSON.parse(line); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("row_must_be_object"); rows.push(normalizeObject(parsed)); } catch (error) { parserErrors.push({ row: index + 1, message: error instanceof Error ? error.message : "invalid_json" }); } }); return { sourceType: "ndjson", rows, parserErrors }; }
  if (extension === "xml" || mimeType.includes("xml")) return { sourceType: "xml", rows: parseXmlRows(text), parserErrors: [] };
  const parsed = Papa.parse<Record<string, unknown>>(text, { header: true, skipEmptyLines: true, transformHeader: normalizeHeader });
  return { sourceType: "csv", rows: parsed.data.slice(0, MAX_ROWS).map(normalizeObject), parserErrors: parsed.errors.map((error) => ({ row: error.row, message: error.message })) };
}
