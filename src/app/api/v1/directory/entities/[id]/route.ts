import { NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const identity = await authenticateRequest(request, "directory:read");
    const { id } = await params;
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("directory_entity_projection_for_tenant", { p_tenant_id: identity.tenantId, p_entity_id: id });
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    const entity = data;
    if (!entity) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const [{ data: fields, error: fieldError }, { data: freshness }, { data: sources }, { data: quality }] = await Promise.all([
      admin.rpc("directory_visible_fields_for_tenant", { p_tenant_id: identity.tenantId, p_entity_id: id }),
      admin.from("field_freshness").select("field_key,verified_at,fresh_until,next_refresh_at,state").eq("master_entity_id", id).order("field_key"),
      admin.rpc("directory_source_attribution_for_tenant", { p_tenant_id: identity.tenantId, p_entity_id: id }),
      admin.from("data_quality_scores").select("completeness,freshness,consistency,provenance,overall,details,calculated_at").eq("master_entity_id", id).maybeSingle(),
    ]);
    if (fieldError) return NextResponse.json({ error: fieldError.message }, { status: 400 });
    return NextResponse.json({ data: { ...entity, fields: fields ?? [], fieldFreshness: freshness ?? [], sources: sources ?? [], quality: quality ?? null } });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: error instanceof Error ? error.message : "internal_error" }, { status: 500 });
  }
}
