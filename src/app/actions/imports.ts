"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getAppContext } from "@/lib/auth";
import { assertPermission } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { importFieldMappingSchema } from "@/lib/imports/import-profile";
import { normalizeImportedRow } from "@/lib/imports/normalize-row";
import type { Json } from "@/lib/supabase/database.types";
import type { ImportedRow } from "@/lib/imports/file-parser";

function jsonValue(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}

export async function processImport(form: FormData) {
  const context = await getAppContext();
  assertPermission(context.role, "imports.manage");
  const importRunId = String(form.get("import_run_id") ?? "");
  if (!importRunId) return;
  const supabase = await createClient();
  const runResult = await supabase.from("import_runs")
    .select("id,truncated")
    .eq("id", importRunId)
    .single();
  if (runResult.error || !runResult.data) {
    redirect(`/app/imports/${importRunId}?error=${encodeURIComponent(runResult.error?.message ?? "Importen hittades inte")}`);
  }
  if (runResult.data.truncated) {
    redirect(`/app/imports/${importRunId}?error=${encodeURIComponent("Importen är trunkerad och får inte verkställas. Ladda upp filen i mindre batcher.")}`);
  }
  // RPC:n sätter körningens idempotensnyckel. Samma fil som redan är verkställd
  // (och inte återställd) stoppas av det unika indexet innan något skrivs.
  const { data, error } = await supabase.rpc("process_import_run", { p_import_run_id: importRunId });
  if (error) {
    const already = error.code === "23505" || error.message.includes("execution_idempotency");
    redirect(`/app/imports/${importRunId}?error=${encodeURIComponent(already ? "Samma fil till samma lista är redan importerad. Återställ den förra importen först om du vill köra om den." : importErrorMessage(error.message))}`);
  }
  const result = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, Json | undefined> : {};
  if (result.failed) {
    revalidatePath(`/app/imports/${importRunId}`);
    redirect(`/app/imports/${importRunId}?error=${encodeURIComponent("Importen stoppades och inget sparades. Orsaken står under Validering.")}`);
  }
  revalidatePath("/app/imports");
  revalidatePath(`/app/imports/${importRunId}`);
  redirect(`/app/imports/${importRunId}?message=${encodeURIComponent(`Import klar: ${result.new ?? 0} nya, ${result.updated ?? 0} uppdaterade, ${result.newContacts ?? 0} nya kontakter och ${result.blocked ?? 0} blockerade.`)}`);
}

function importErrorMessage(code: string) {
  if (code.includes("import_run_not_ready")) return "Importen är inte redo att verkställas.";
  if (code.includes("import_file_not_security_cleared")) return "Filen är inte godkänd av virusskanningen.";
  if (code.includes("target_list_permission_denied")) return "Du får inte importera till den valda listan.";
  if (code.includes("permission_denied")) return "Du har inte behörighet att verkställa importer.";
  return "Importen kunde inte verkställas.";
}

export async function rollbackImport(form: FormData) {
  const context = await getAppContext();
  if (!["owner", "admin"].includes(context.role)) throw new Error("Adminbehörighet krävs");
  const importRunId = String(form.get("import_run_id") ?? "");
  if (!importRunId) return;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("rollback_import_run", { p_import_run_id: importRunId });
  if (error) redirect(`/app/imports/${importRunId}?error=${encodeURIComponent(error.message)}`);
  const result = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, Json | undefined> : {};
  revalidatePath("/app/imports");
  revalidatePath(`/app/imports/${importRunId}`);
  redirect(`/app/imports/${importRunId}?message=${encodeURIComponent(`${result.rolledBack ?? 0} ändringar återställdes och ${result.skipped ?? 0} hoppades över eftersom data ändrats eller används.`)}`);
}

export async function updateImportMapping(form: FormData) {
  const context = await getAppContext();
  assertPermission(context.role, "imports.manage");
  const importRunId = String(form.get("import_run_id") ?? "");
  const rawMapping = String(form.get("mapping_json") ?? "");
  if (!importRunId || !rawMapping) throw new Error("Import och mappning krävs");
  const mapping = importFieldMappingSchema.parse(JSON.parse(rawMapping));
  const supabase = await createClient();
  const runResult = await supabase.from("import_runs").select("id,status,total_rows").eq("id", importRunId).single();
  if (runResult.error || !runResult.data) redirect(`/app/imports/${importRunId}?error=${encodeURIComponent(runResult.error?.message ?? "Importen hittades inte")}`);
  if (!["mapping_required", "preview_ready", "validated", "failed"].includes(runResult.data.status)) redirect(`/app/imports/${importRunId}?error=${encodeURIComponent("Importen kan inte mappas i nuvarande status")}`);

  let valid = 0;
  let warnings = 0;
  let errors = 0;
  const pageSize = 500;
  for (let offset = 0; offset < runResult.data.total_rows; offset += pageSize) {
    const page = await supabase.from("import_rows").select("id,raw_data").eq("import_run_id", importRunId).order("row_number").range(offset, offset + pageSize - 1);
    if (page.error) redirect(`/app/imports/${importRunId}?error=${encodeURIComponent(page.error.message)}`);
    const updates = (page.data ?? []).map((row) => {
      const result = normalizeImportedRow(row.raw_data as ImportedRow, mapping);
      if (result.errors.length) errors += 1;
      else if (result.warnings.length) warnings += 1;
      else valid += 1;
      return {
        id: row.id,
        normalized_data: jsonValue(result.normalized),
        decision: result.errors.length ? "error" : result.warnings.length ? "warning" : "ready",
        row_status: result.errors.length ? "invalid" : result.warnings.length ? "warning" : "valid",
        error_code: result.errors[0] ?? null,
        errors: jsonValue(result.issues.filter((issue) => result.errors.includes(issue.code))),
        warning_codes: jsonValue(result.warnings),
        source_external_id: typeof result.normalized.source_external_id === "string" ? result.normalized.source_external_id : null,
      };
    });
    if (updates.length) {
      const updateResult = await supabase.rpc("apply_import_row_normalization", {
        p_import_run_id: importRunId,
        p_rows: jsonValue(updates),
      });
      if (updateResult.error) redirect(`/app/imports/${importRunId}?error=${encodeURIComponent(updateResult.error.message)}`);
      if (Number(updateResult.data ?? 0) !== updates.length) {
        redirect(`/app/imports/${importRunId}?error=${encodeURIComponent("Alla importrader kunde inte uppdateras säkert")}`);
      }
    }
  }
  // Körningen är skrivskyddad för användare; servern skriver, i användarens tenant.
  const updated = await createAdminClient().from("import_runs").update({
    field_mapping: jsonValue(mapping),
    status: errors === runResult.data.total_rows ? "mapping_required" : "preview_ready",
    error_count: errors,
    warning_count: warnings,
    accepted_row_count: valid + warnings,
    rejected_row_count: errors,
    validation_report: jsonValue({ valid_rows: valid, warning_rows: warnings, error_rows: errors, accepted_row_count: valid + warnings, rejected_row_count: errors, mapping_updated_at: new Date().toISOString() }),
  }).eq("tenant_id", context.tenantId).eq("id", importRunId);
  if (updated.error) redirect(`/app/imports/${importRunId}?error=${encodeURIComponent(updated.error.message)}`);
  revalidatePath(`/app/imports/${importRunId}`);
  revalidatePath(`/app/imports/${importRunId}/mapping`);
  redirect(`/app/imports/${importRunId}?message=${encodeURIComponent(`Mappningen applicerades: ${valid} giltiga, ${warnings} varningar och ${errors} fel.`)}`);
}
