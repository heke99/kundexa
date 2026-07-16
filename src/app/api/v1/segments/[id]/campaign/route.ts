import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticateRequest } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
const schema = z.object({ campaignId: z.uuid() });
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const identity = await authenticateRequest(request, "segments:write"); const { id } = await params; const input = schema.parse(await request.json()); const admin = createAdminClient();
    const { data, error } = await admin.rpc("materialize_segment_to_campaign", { p_segment_id: id, p_campaign_id: input.campaignId, p_actor: identity.userId });
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ data });
  } catch (error) { if (error instanceof Response) return error; if (error instanceof z.ZodError) return NextResponse.json({ error: "validation_error", details: error.issues }, { status: 422 }); return NextResponse.json({ error: "internal_error" }, { status: 500 }); }
}
