import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticateRequest, dataClientForIdentity } from "@/lib/api-auth";
import { directorySearchSchema } from "@/lib/directory";

const createSchema = z.object({
  name: z.string().min(2).max(120),
  description: z.string().max(1000).optional(),
  segmentType: z.enum(["dynamic", "snapshot"]).default("dynamic"),
  rules: directorySearchSchema,
  teamId: z.uuid().nullable().optional(),
});

export async function GET(request: Request) {
  try {
    const identity = await authenticateRequest(request, "directory:read");
    const db = await dataClientForIdentity(identity);
    const { data, error } = await db.from("segments").select("id,name,description,entity_type,segment_type,rule_definition,active,last_refreshed_at,created_at")
      .eq("tenant_id", identity.tenantId).order("created_at", { ascending: false });
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ data });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const identity = await authenticateRequest(request, "segments:write");
    const input = createSchema.parse(await request.json());
    const db = await dataClientForIdentity(identity);
    const { data, error } = await db.from("segments").insert({
      tenant_id: identity.tenantId,
      name: input.name,
      description: input.description ?? null,
      entity_type: input.rules.entityType,
      segment_type: input.segmentType,
      rule_definition: input.rules,
      owner_user_id: identity.userId,
      team_id: input.teamId ?? null,
      active: true,
    }).select("*").single();
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    await db.from("audit_logs").insert({ tenant_id: identity.tenantId, actor_user_id: identity.userId, action: "segment.created", entity_type: "segment", entity_id: data.id, after_data: data });
    return NextResponse.json({ data }, { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof z.ZodError) return NextResponse.json({ error: "validation_error", details: error.issues }, { status: 422 });
    return NextResponse.json({ error: error instanceof Error ? error.message : "internal_error" }, { status: 500 });
  }
}
