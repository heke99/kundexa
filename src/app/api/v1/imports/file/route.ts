import { NextResponse } from "next/server";
import type { Json } from "@/lib/supabase/database.types";
import { createClient } from "@/lib/supabase/server";
import { getAppContext } from "@/lib/auth";
import { assertPermission } from "@/lib/permissions";
import { parseImportFile } from "@/lib/imports/file-parser";
import { normalizeImportedRow } from "@/lib/imports/normalize-row";
import { scanImportFile } from "@/lib/imports/malware-scan";
import { importFieldMappingSchema } from "@/lib/imports/import-profile";
import { inferFieldMapping } from "@/lib/imports/field-mapping";

export const runtime = "nodejs";
const MAX_BYTES = 50 * 1024 * 1024;
const MAX_ROWS = 10_000;

function jsonValue(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}

function redirectWith(request: Request, path: string, key: "message" | "error", value: string) {
  const url = new URL(path, request.url);
  url.searchParams.set(key, value);
  return NextResponse.redirect(url, 303);
}

export async function POST(request: Request) {
  let cleanupClient: Awaited<ReturnType<typeof createClient>> | null = null;
  let uploadedPath: string | null = null;
  let createdRunId: string | null = null;
  try {
    const ctx = await getAppContext();
    assertPermission(ctx.role, "imports.manage");
    const form = await request.formData();
    const file = form.get("file");
    const name = String(form.get("name") ?? "Filimport").trim();
    const profileId = String(form.get("profile_id") ?? "").trim() || null;
    const recordsPath = String(form.get("records_path") ?? "").trim() || null;
    const worksheetName = String(form.get("worksheet_name") ?? "").trim() || null;
    const headerRow = Number(form.get("header_row") ?? 1);
    const requestedTargetListId = String(form.get("target_list_id") ?? "").trim() || null;
    const simulate = form.get("simulate") === "on";

    if (!(file instanceof File) || file.size <= 0 || file.size > MAX_BYTES) throw new Error("invalid_or_oversized_import_file");
    if (!Number.isInteger(headerRow) || headerRow < 1 || headerRow > 100) throw new Error("invalid_header_row");

    const supabase = await createClient();
    cleanupClient = supabase;
    let profile: {
      id: string;
      source_provider: string;
      source_website: string | null;
      worksheet_name: string | null;
      header_row: number;
      records_path: string | null;
      target_list_id: string | null;
      automatic_commit: boolean;
      current_version: number;
    } | null = null;
    let profileVersion: { id: string; version: number; config: Json; field_mapping: Json } | null = null;

    if (profileId) {
      const { data, error } = await supabase.from("import_profiles").select("id,source_provider,source_website,worksheet_name,header_row,records_path,target_list_id,automatic_commit,current_version").eq("id", profileId).eq("active", true).single();
      if (error || !data) throw new Error(error?.message ?? "import_profile_not_found");
      profile = data;
      const versionResult = await supabase.from("import_profile_versions").select("id,version,config,field_mapping").eq("import_profile_id", profile.id).eq("version", profile.current_version).single();
      if (versionResult.error || !versionResult.data) throw new Error(versionResult.error?.message ?? "import_profile_version_not_found");
      profileVersion = versionResult.data;
    }

    const targetListId = requestedTargetListId ?? profile?.target_list_id ?? null;
    if (targetListId) {
      const list = await supabase.from("customer_lists").select("id").eq("id", targetListId).maybeSingle();
      if (list.error || !list.data) throw new Error("target_list_not_found_or_forbidden");
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const scan = await scanImportFile(buffer, file.name, file.type);
    if (scan.status === "infected") throw new Error("import_file_infected");
    if (scan.status === "failed") throw new Error("import_file_scan_failed");

    const idempotencyKey = `file:${scan.sha256}:${profileVersion?.id ?? "adhoc"}:${targetListId ?? "crm"}`;
    const existing = await supabase.from("import_runs").select("id,status").eq("idempotency_key", idempotencyKey).not("status", "in", "(failed,rolled_back,cancelled)").maybeSingle();
    if (existing.error) throw new Error(existing.error.message);
    if (existing.data) return redirectWith(request, `/app/imports/${existing.data.id}`, "message", "Samma fil, profil och mål har redan behandlats. Befintlig import visas.");

    const parsed = await parseImportFile(buffer, file.name, file.type, {
      recordsPath: recordsPath ?? profile?.records_path,
      worksheetName: worksheetName ?? profile?.worksheet_name,
      headerRow: profile?.header_row ?? headerRow,
      maxRows: MAX_ROWS,
    });
    if (!parsed.rows.length) throw new Error("import_file_contains_no_rows");

    const mapping = profileVersion
      ? importFieldMappingSchema.parse(profileVersion.field_mapping)
      : inferFieldMapping(parsed.rows[0]);
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const path = `${ctx.tenantId}/${crypto.randomUUID()}-${safeName}`;
    const upload = await supabase.storage.from("imports").upload(path, buffer, { contentType: file.type || "application/octet-stream", upsert: false });
    if (upload.error) throw new Error(upload.error.message);
    uploadedPath = path;

    const { data: run, error } = await supabase.from("import_runs").insert({
      tenant_id: ctx.tenantId,
      name,
      source_type: parsed.sourceType,
      source_file_path: path,
      status: "validating",
      uploaded_by: ctx.userId,
      total_rows: parsed.rows.length,
      simulation: simulate,
      file_mime_type: file.type || "application/octet-stream",
      file_size_bytes: file.size,
      scan_status: scan.status,
      scan_provider: scan.provider,
      scan_sha256: scan.sha256,
      scan_completed_at: new Date().toISOString(),
      file_sha256: scan.sha256,
      idempotency_key: idempotencyKey,
      import_profile_id: profile?.id ?? null,
      import_profile_version_id: profileVersion?.id ?? null,
      profile_version: profileVersion?.version ?? null,
      profile_snapshot: jsonValue({ profile, version: profileVersion?.version ?? null, config: profileVersion?.config ?? {}, mapping }),
      field_mapping: jsonValue(mapping),
      source_provider: profile?.source_provider ?? "file",
      source_website: profile?.source_website ?? null,
      worksheet_name: parsed.selectedWorksheet,
      header_row: parsed.headerRow,
      records_path: parsed.recordsPath,
      target_list_id: targetListId,
      validation_report: jsonValue({ parser_errors: parsed.parserErrors, malware_scan: scan.details, columns: parsed.columns, worksheets: parsed.worksheets }),
    }).select("id").single();
    if (error || !run) throw new Error(error?.message ?? "import_run_create_failed");
    createdRunId = run.id;

    let valid = 0;
    let warnings = 0;
    let errors = 0;
    const rows = parsed.rows.map((row, index) => {
      const result = normalizeImportedRow(row, mapping);
      if (result.errors.length) errors += 1;
      else if (result.warnings.length) warnings += 1;
      else valid += 1;
      return {
        tenant_id: ctx.tenantId,
        import_run_id: run.id,
        row_number: index + (parsed.sourceType === "xlsx" || parsed.sourceType === "csv" ? parsed.headerRow + 1 : 1),
        raw_data: jsonValue(row),
        normalized_data: jsonValue(result.normalized),
        decision: result.errors.length ? "error" : result.warnings.length ? "warning" : "ready",
        row_status: result.errors.length ? "invalid" : result.warnings.length ? "warning" : "valid",
        error_code: result.errors[0] ?? null,
        errors: jsonValue(result.issues.filter((issue) => result.errors.includes(issue.code))),
        warning_codes: jsonValue(result.warnings),
        source_external_id: typeof result.normalized.source_external_id === "string" ? result.normalized.source_external_id : null,
      };
    });
    for (let index = 0; index < rows.length; index += 500) {
      const inserted = await supabase.from("import_rows").insert(rows.slice(index, index + 500));
      if (inserted.error) throw new Error(inserted.error.message);
    }

    const finalStatus = errors === rows.length ? "mapping_required" : "preview_ready";
    const updated = await supabase.from("import_runs").update({
      status: finalStatus,
      error_count: errors,
      warning_count: warnings + parsed.parserErrors.length,
      validation_report: jsonValue({
        valid_rows: valid,
        warning_rows: warnings,
        error_rows: errors,
        parser_errors: parsed.parserErrors,
        columns: parsed.columns,
        worksheets: parsed.worksheets,
        selected_worksheet: parsed.selectedWorksheet,
        records_path: parsed.recordsPath,
        malware_scan: { status: scan.status, provider: scan.provider, sha256: scan.sha256 },
      }),
    }).eq("id", run.id);
    if (updated.error) throw new Error(updated.error.message);

    if (profile?.automatic_commit && !simulate && errors === 0 && ["owner", "admin"].includes(ctx.role)) {
      const committed = await supabase.rpc("process_import_run", { p_import_run_id: run.id });
      if (committed.error) throw new Error(committed.error.message);
    }
    return redirectWith(request, `/app/imports/${run.id}`, "message", `Importen validerades: ${valid} giltiga, ${warnings} varningar och ${errors} fel.`);
  } catch (error) {
    const referenceId = crypto.randomUUID();
    console.error("Import failed", { referenceId, message: error instanceof Error ? error.message : "unknown_error", createdRunId });
    if (cleanupClient && createdRunId) {
      await cleanupClient.from("import_runs").update({
        status: "failed",
        completed_at: new Date().toISOString(),
        validation_report: jsonValue({ failure_reference: referenceId }),
      }).eq("id", createdRunId);
    } else if (cleanupClient && uploadedPath) {
      await cleanupClient.storage.from("imports").remove([uploadedPath]);
    }
    return redirectWith(request, "/app/imports", "error", `Importen kunde inte behandlas. Referens: ${referenceId}`);
  }
}
