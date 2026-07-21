import { NextResponse } from "next/server";
import { z } from "zod";
import { getAppContext } from "@/lib/auth";
import { assertPermission } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";
import { createImportProfileSchema } from "@/lib/imports/import-profile";
import type { Json } from "@/lib/supabase/database.types";

export async function GET() {
  try {
    const context = await getAppContext();
    assertPermission(context.role, "imports.manage");
    const supabase = await createClient();
    const { data, error } = await supabase.from("import_profiles").select("id,name,source_provider,source_website,format,worksheet_name,header_row,records_path,target_type,target_list_id,automatic_commit,current_version,updated_at").eq("active", true).order("name");
    if (error) throw new Error(error.message);
    return NextResponse.json({ profiles: data ?? [] });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "internal_error" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const context = await getAppContext();
    assertPermission(context.role, "imports.manage");
    const body = createImportProfileSchema.extend({ id: z.uuid().nullable().optional() }).parse(await request.json());
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("save_import_profile", {
      p_profile_id: "id" in body && typeof body.id === "string" ? body.id : null,
      p_name: body.name,
      p_source_provider: body.sourceProvider,
      p_source_website: body.sourceWebsite ?? null,
      p_format: body.format,
      p_worksheet_name: body.worksheetName ?? null,
      p_header_row: body.headerRow,
      p_records_path: body.recordsPath ?? null,
      p_target_type: body.targetType,
      p_target_list_id: body.targetListId ?? null,
      p_automatic_commit: body.automaticCommit,
      p_config: { format: body.format, worksheetName: body.worksheetName, headerRow: body.headerRow, recordsPath: body.recordsPath, targetType: body.targetType } as Json,
      p_field_mapping: body.mapping as unknown as Json,
    });
    if (error) throw new Error(error.message);
    return NextResponse.json({ id: data }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "internal_error" }, { status: 422 });
  }
}
