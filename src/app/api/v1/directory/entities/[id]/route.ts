import { NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const identity = await authenticateRequest(request, "directory:read");
    const { id } = await params;
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("directory_entity_for_tenant", { p_tenant_id: identity.tenantId, p_entity_id: id });
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    const entity = data?.[0];
    if (!entity) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const [{ data: fields }, { data: freshness }, { data: sources }] = await Promise.all([
      admin.from("field_values").select("field_key,value,confidence,source_fact_id,verified_at,updated_at").eq("master_entity_id", id).order("field_key"),
      admin.from("field_freshness").select("field_key,verified_at,fresh_until,next_refresh_at,state").eq("master_entity_id", id).order("field_key"),
      admin.from("entity_source_links").select("match_method,confidence,manually_verified,source_entities(data_provider_id,external_identifier,last_seen_at,removed_at)").eq("master_entity_id", id),
    ]);
    return NextResponse.json({ data: { ...entity, fields: fields ?? [], fieldFreshness: freshness ?? [], sources: sources ?? [] } });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: error instanceof Error ? error.message : "internal_error" }, { status: 500 });
  }
}
