import { NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const identity = await authenticateRequest(request, "segments:write"); const { id } = await params; const admin = createAdminClient();
    const { data: segment } = await admin.from("segments").select("id").eq("tenant_id", identity.tenantId).eq("id", id).maybeSingle();
    if (!segment) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const { data, error } = await admin.rpc("refresh_segment_materialization", { p_segment_id: id, p_actor: identity.userId });
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ data });
  } catch (error) { if (error instanceof Response) return error; return NextResponse.json({ error: "internal_error" }, { status: 500 }); }
}
