import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAppContext } from "@/lib/auth";
import { assertPermission } from "@/lib/permissions";
import { parseImportFile } from "@/lib/imports/file-parser";
import { normalizeImportedRow } from "@/lib/imports/normalize-row";
import { scanImportFile } from "@/lib/imports/malware-scan";
export const runtime = "nodejs";
const MAX_BYTES = 50 * 1024 * 1024;
export async function POST(request: Request) {
  try {
    const ctx = await getAppContext(); assertPermission(ctx.role, "imports.manage"); const form = await request.formData(); const file = form.get("file"); const name = String(form.get("name") ?? "Filimport").trim(); const simulate = form.get("simulate") === "on";
    if (!(file instanceof File) || file.size <= 0 || file.size > MAX_BYTES) throw new Error("invalid_or_oversized_import_file");
    const buffer = Buffer.from(await file.arrayBuffer()); const scan = await scanImportFile(buffer, file.name, file.type);
    if (scan.status === "infected") throw new Error("import_file_infected"); if (scan.status === "failed") throw new Error("import_file_scan_failed");
    const parsed = parseImportFile(buffer, file.name, file.type); if (!parsed.rows.length) throw new Error("import_file_contains_no_rows"); const supabase = await createClient(); const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_"); const path = `${ctx.tenantId}/${crypto.randomUUID()}-${safeName}`;
    const upload = await supabase.storage.from("imports").upload(path, buffer, { contentType: file.type || "application/octet-stream", upsert: false }); if (upload.error) throw new Error(upload.error.message);
    const { data: run, error } = await supabase.from("import_runs").insert({ tenant_id: ctx.tenantId, name, source_type: parsed.sourceType, source_file_path: path, status: "validating", uploaded_by: ctx.userId, total_rows: parsed.rows.length, simulation: simulate, file_mime_type: file.type || "application/octet-stream", file_size_bytes: file.size, scan_status: scan.status, scan_provider: scan.provider, scan_sha256: scan.sha256, scan_completed_at: new Date().toISOString(), validation_report: { parser_errors: parsed.parserErrors, malware_scan: scan.details } }).select("id").single();
    if (error || !run) throw new Error(error?.message ?? "import_run_create_failed"); let valid = 0; let errors = 0;
    const rows = parsed.rows.map((row, index) => { const result = normalizeImportedRow(row); if (result.errors.length) errors++; else valid++; return { tenant_id: ctx.tenantId, import_run_id: run.id, row_number: index + 2, raw_data: row, normalized_data: result.normalized, decision: result.errors.length ? "error" : "ready", errors: result.errors }; });
    for (let index = 0; index < rows.length; index += 500) { const inserted = await supabase.from("import_rows").insert(rows.slice(index, index + 500)); if (inserted.error) throw new Error(inserted.error.message); }
    const updated = await supabase.from("import_runs").update({ status: "preview_ready", error_count: errors, validation_report: { valid_rows: valid, error_rows: errors, parser_errors: parsed.parserErrors, malware_scan: { status: scan.status, provider: scan.provider, sha256: scan.sha256 } } }).eq("id", run.id); if (updated.error) throw new Error(updated.error.message);
    return NextResponse.redirect(new URL(`/app/imports?message=${encodeURIComponent(`Importen validerades: ${valid} giltiga, ${errors} fel. Säkerhetskontroll: ${scan.status}.`)}`, request.url), 303);
  } catch (error) { return NextResponse.redirect(new URL(`/app/imports?error=${encodeURIComponent(error instanceof Error ? error.message : "Importfel")}`, request.url), 303); }
}
