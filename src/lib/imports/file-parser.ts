import ExcelJS from "exceljs";
import Papa from "papaparse";
import { resolveRecordsPath } from "./json-path";

export type ImportedRow = Record<string, unknown>;
export type ParserIssue = { row?: number; column?: string; code?: string; message: string };
export type ParsedImportFile = {
  sourceType: "csv" | "json" | "ndjson" | "xml" | "xlsx";
  rows: ImportedRow[];
  parserErrors: ParserIssue[];
  columns: string[];
  worksheets: string[];
  selectedWorksheet: string | null;
  recordsPath: string | null;
  headerRow: number;
};

export type ParseImportOptions = {
  recordsPath?: string | null;
  worksheetName?: string | null;
  headerRow?: number;
  maxRows?: number;
  maxColumns?: number;
  maxCellCharacters?: number;
};

const DEFAULT_MAX_ROWS = 10_000;
const DEFAULT_MAX_COLUMNS = 500;
const DEFAULT_MAX_CELL_CHARACTERS = 50_000;
const MAX_XLSX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;
const MAX_XLSX_ENTRIES = 5_000;
const MAX_XLSX_COMPRESSION_RATIO = 100;

export function normalizeHeader(value: string) {
  return value.trim().toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function normalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeJsonValue);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [normalizeHeader(key), normalizeJsonValue(entry)]));
  }
  return value;
}

function normalizeObject(input: Record<string, unknown>): ImportedRow {
  return normalizeJsonValue(input) as ImportedRow;
}

function validateCell(value: unknown, row: number, column: string, maxCharacters: number, issues: ParserIssue[]): unknown {
  if (typeof value === "string") {
    if (value.length > maxCharacters) {
      issues.push({ row, column, code: "cell_too_large", message: `Cellen ${column} överstiger maximal längd.` });
      return value.slice(0, maxCharacters);
    }
    if (/^[=+@]/.test(value) || /^-(?!\d+(?:[.,]\d+)?$)/.test(value)) {
      issues.push({ row, column, code: "formula_injection_text", message: `Cellen ${column} börjar med ett formeltecken och behandlas som text.` });
    }
  }
  return value;
}

function collectColumns(rows: ImportedRow[]) {
  const columns = new Set<string>();
  for (const row of rows.slice(0, 100)) for (const key of Object.keys(row)) columns.add(key);
  return [...columns];
}

function discoverArrayPaths(value: unknown, prefix = "", depth = 0): string[] {
  if (depth > 4 || !value || typeof value !== "object") return [];
  if (Array.isArray(value)) return prefix ? [prefix] : ["$"];
  const paths: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (Array.isArray(child)) paths.push(path);
    else paths.push(...discoverArrayPaths(child, path, depth + 1));
  }
  return paths;
}

function rowsFromJsonValue(value: unknown, recordsPath: string | null | undefined, maxRows: number): { rows: ImportedRow[]; recordsPath: string | null } {
  let selectedPath = recordsPath?.trim() || null;
  if (!selectedPath && !Array.isArray(value)) {
    const paths = discoverArrayPaths(value);
    if (paths.length !== 1) {
      const error = new Error(paths.length ? `json_records_path_required:${paths.slice(0, 20).join(",")}` : "json_array_or_records_path_required");
      throw error;
    }
    selectedPath = paths[0];
  }
  const candidate = Array.isArray(value) && !selectedPath ? value : resolveRecordsPath(value, selectedPath);
  return {
    recordsPath: selectedPath,
    rows: candidate.slice(0, maxRows).map((row, index) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error(`json_row_${index + 1}_must_be_object`);
      return normalizeObject(row as Record<string, unknown>);
    }),
  };
}

function decodeXml(value: string) {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&").trim();
}

function parseXmlRows(xml: string, maxRows: number): ImportedRow[] {
  const rows: ImportedRow[] = [];
  const rowPattern = /<(row|record|item)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
  for (const match of xml.matchAll(rowPattern)) {
    const row: ImportedRow = {};
    for (const child of match[2].matchAll(/<([A-Za-z_][\w:.-]*)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g)) {
      row[normalizeHeader(child[1].split(":").pop() ?? child[1])] = decodeXml(child[2].replace(/<[^>]+>/g, ""));
    }
    if (Object.keys(row).length) rows.push(row);
    if (rows.length >= maxRows) break;
  }
  if (!rows.length) throw new Error("xml_row_record_or_item_elements_required");
  return rows;
}

function assertXlsxZipSafety(buffer: Buffer) {
  let eocd = -1;
  for (let index = buffer.length - 22; index >= Math.max(0, buffer.length - 65_557); index--) {
    if (buffer.readUInt32LE(index) === 0x06054b50) { eocd = index; break; }
  }
  if (eocd < 0) throw new Error("xlsx_zip_directory_missing");
  const count = buffer.readUInt16LE(eocd + 10);
  if (count > MAX_XLSX_ENTRIES) throw new Error("xlsx_too_many_zip_entries");
  let offset = buffer.readUInt32LE(eocd + 16);
  let compressedTotal = 0;
  let uncompressedTotal = 0;
  for (let index = 0; index < count; index++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("xlsx_zip_entry_invalid");
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    compressedTotal += compressedSize;
    uncompressedTotal += uncompressedSize;
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (uncompressedTotal > MAX_XLSX_UNCOMPRESSED_BYTES) throw new Error("xlsx_uncompressed_size_exceeded");
  if (compressedTotal > 0 && uncompressedTotal / compressedTotal > MAX_XLSX_COMPRESSION_RATIO) throw new Error("xlsx_suspicious_compression_ratio");
}

function excelCellValue(value: ExcelJS.CellValue): unknown {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    if ("formula" in value || "sharedFormula" in value) return "result" in value ? value.result ?? null : null;
    if ("richText" in value) return value.richText.map((part) => part.text).join("");
    if ("text" in value && "hyperlink" in value) return value.text;
    if ("error" in value) return null;
  }
  return value;
}

async function parseXlsx(buffer: Buffer, options: Required<Pick<ParseImportOptions, "headerRow" | "maxRows" | "maxColumns" | "maxCellCharacters">> & { worksheetName?: string | null }) {
  assertXlsxZipSafety(buffer);
  const workbook = new ExcelJS.Workbook();
  workbook.calcProperties.fullCalcOnLoad = false;
  const workbookBytes = Uint8Array.from(buffer).buffer;
  await workbook.xlsx.load(workbookBytes);
  const worksheets = workbook.worksheets.map((sheet) => sheet.name);
  const worksheet = options.worksheetName ? workbook.getWorksheet(options.worksheetName) : workbook.worksheets[0];
  if (!worksheet) throw new Error(options.worksheetName ? "xlsx_selected_worksheet_missing" : "xlsx_worksheet_missing");
  if (worksheet.columnCount > options.maxColumns) throw new Error("xlsx_too_many_columns");
  const header = worksheet.getRow(options.headerRow);
  const rawHeaders: string[] = [];
  for (let index = 1; index <= Math.min(worksheet.columnCount, options.maxColumns); index++) {
    const raw = excelCellValue(header.getCell(index).value);
    rawHeaders.push(normalizeHeader(String(raw ?? `column_${index}`)) || `column_${index}`);
  }
  if (!rawHeaders.some(Boolean)) throw new Error("xlsx_header_row_empty");
  const rows: ImportedRow[] = [];
  const parserErrors: ParserIssue[] = [];
  const finalRow = Math.min(worksheet.rowCount, options.headerRow + options.maxRows);
  for (let rowNumber = options.headerRow + 1; rowNumber <= finalRow; rowNumber++) {
    const sourceRow = worksheet.getRow(rowNumber);
    const row: ImportedRow = {};
    let populated = false;
    for (let column = 1; column <= rawHeaders.length; column++) {
      const key = rawHeaders[column - 1];
      const value = validateCell(excelCellValue(sourceRow.getCell(column).value), rowNumber, key, options.maxCellCharacters, parserErrors);
      if (value != null && String(value).trim() !== "") populated = true;
      row[key] = value;
    }
    if (populated) rows.push(row);
  }
  if (!rows.length) throw new Error("xlsx_contains_no_data_rows");
  return { rows, parserErrors, worksheets, selectedWorksheet: worksheet.name };
}

function assertExtensionAndMime(extension: string | undefined, mimeType: string) {
  const mime = mimeType.toLowerCase();
  const allowed: Record<string, string[]> = {
    csv: ["text/csv", "application/csv", "text/plain", "application/vnd.ms-excel", ""],
    json: ["application/json", "text/json", "text/plain", ""],
    ndjson: ["application/x-ndjson", "application/ndjson", "text/plain", ""],
    jsonl: ["application/x-ndjson", "application/ndjson", "text/plain", ""],
    xml: ["application/xml", "text/xml", "text/plain", ""],
    xlsx: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/octet-stream", ""],
  };
  if (!extension || !allowed[extension]) throw new Error("unsupported_import_file_extension");
  if (!allowed[extension].includes(mime)) throw new Error("import_file_mime_mismatch");
}

export async function parseImportFile(buffer: Buffer, fileName: string, mimeType: string, options: ParseImportOptions = {}): Promise<ParsedImportFile> {
  const extension = fileName.toLowerCase().split(".").pop();
  assertExtensionAndMime(extension, mimeType);
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  const maxColumns = options.maxColumns ?? DEFAULT_MAX_COLUMNS;
  const maxCellCharacters = options.maxCellCharacters ?? DEFAULT_MAX_CELL_CHARACTERS;
  const headerRow = options.headerRow ?? 1;

  if (extension === "xlsx") {
    const parsed = await parseXlsx(buffer, { worksheetName: options.worksheetName, headerRow, maxRows, maxColumns, maxCellCharacters });
    return { sourceType: "xlsx", rows: parsed.rows, parserErrors: parsed.parserErrors, columns: collectColumns(parsed.rows), worksheets: parsed.worksheets, selectedWorksheet: parsed.selectedWorksheet, recordsPath: null, headerRow };
  }

  const text = buffer.toString("utf8").replace(/^\uFEFF/, "");
  if (extension === "json") {
    const parsed = rowsFromJsonValue(JSON.parse(text), options.recordsPath, maxRows);
    return { sourceType: "json", rows: parsed.rows, parserErrors: [], columns: collectColumns(parsed.rows), worksheets: [], selectedWorksheet: null, recordsPath: parsed.recordsPath, headerRow: 1 };
  }
  if (extension === "ndjson" || extension === "jsonl") {
    const parserErrors: ParserIssue[] = [];
    const rows: ImportedRow[] = [];
    text.split(/\r?\n/).forEach((line, index) => {
      if (!line.trim() || rows.length >= maxRows) return;
      try {
        const parsed = JSON.parse(line);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("row_must_be_object");
        rows.push(normalizeObject(parsed));
      } catch (error) {
        parserErrors.push({ row: index + 1, code: "invalid_ndjson", message: error instanceof Error ? error.message : "invalid_json" });
      }
    });
    return { sourceType: "ndjson", rows, parserErrors, columns: collectColumns(rows), worksheets: [], selectedWorksheet: null, recordsPath: null, headerRow: 1 };
  }
  if (extension === "xml") {
    const rows = parseXmlRows(text, maxRows);
    return { sourceType: "xml", rows, parserErrors: [], columns: collectColumns(rows), worksheets: [], selectedWorksheet: null, recordsPath: null, headerRow: 1 };
  }

  const parserErrors: ParserIssue[] = [];
  const parsed = Papa.parse<Record<string, unknown>>(text, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: normalizeHeader,
    transform: (value, column) => validateCell(value, 0, String(column), maxCellCharacters, parserErrors) as string,
  });
  const rows = parsed.data.slice(0, maxRows).map(normalizeObject);
  if (collectColumns(rows).length > maxColumns) throw new Error("csv_too_many_columns");
  parserErrors.push(...parsed.errors.map((error) => ({ row: error.row == null ? undefined : error.row + 2, code: error.code, message: error.message })));
  return { sourceType: "csv", rows, parserErrors, columns: collectColumns(rows), worksheets: [], selectedWorksheet: null, recordsPath: null, headerRow: 1 };
}
