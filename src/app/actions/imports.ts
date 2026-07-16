"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getAppContext } from "@/lib/auth";
import { assertPermission } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

export async function processImport(form: FormData) {
  const context = await getAppContext();
  assertPermission(context.role, "imports.manage");
  const importRunId = String(form.get("import_run_id") ?? "");
  if (!importRunId) return;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("process_import_run", { p_import_run_id: importRunId });
  if (error) redirect(`/app/imports?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/app/imports");
  redirect(`/app/imports?message=${encodeURIComponent(`Import klar: ${data?.new ?? 0} nya, ${data?.duplicates ?? 0} dubletter, ${data?.blocked ?? 0} spärrade.`)}`);
}

export async function rollbackImport(form: FormData) {
  const context = await getAppContext();
  if (!["owner", "admin"].includes(context.role)) throw new Error("Adminbehörighet krävs");
  const importRunId = String(form.get("import_run_id") ?? "");
  if (!importRunId) return;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("rollback_import_run", { p_import_run_id: importRunId });
  if (error) redirect(`/app/imports?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/app/imports");
  redirect(`/app/imports?message=${encodeURIComponent(`${data ?? 0} importerade kunder mjukraderades. Kunder med juridiskt relevanta avtal bevarades.`)}`);
}
