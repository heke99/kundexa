import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

const filePath = process.argv[2];
if (!filePath) {
  console.error("Usage: npm run geography:import -- ./geography.json [source] [version]");
  process.exit(1);
}
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) throw new Error("SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
const text = await readFile(resolve(filePath), "utf8");
let rows;
if (extname(filePath).toLowerCase() === ".ndjson" || extname(filePath).toLowerCase() === ".jsonl") {
  rows = text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
} else {
  const parsed = JSON.parse(text);
  rows = Array.isArray(parsed) ? parsed : parsed.rows;
}
if (!Array.isArray(rows) || rows.length === 0) throw new Error("The geography file must contain a non-empty JSON array or { rows: [...] }");
const source = process.argv[3] ?? "operator_import";
const sourceVersion = process.argv[4] ?? null;
const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });
let imported = 0;
for (let index = 0; index < rows.length; index += 500) {
  const batch = rows.slice(index, index + 500);
  const { data, error } = await supabase.rpc("upsert_geographic_reference_batch", { p_rows: batch, p_source: source, p_source_version: sourceVersion });
  if (error) throw error;
  imported += Number(data ?? 0);
  console.log(`Imported ${imported}/${rows.length}`);
}
const { data: normalized, error: normalizeError } = await supabase.rpc("normalize_due_geographies", { p_limit: 5000 });
if (normalizeError) throw normalizeError;
console.log(`Geographic reference import complete. Rows: ${imported}. Entities normalized now: ${Number(normalized ?? 0)}.`);
