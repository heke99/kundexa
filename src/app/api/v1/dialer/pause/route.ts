import { NextResponse } from "next/server";
import { z } from "zod";
import { getAppContext } from "@/lib/auth";
import { assertPermission } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  try {
    const context = await getAppContext();
    assertPermission(context.role, "calls.create");
    const body = z.object({ sessionId: z.uuid(), reason: z.enum(["paused", "skip", "end"]).default("paused") }).parse(await request.json());
    const supabase = await createClient();
    const { error } = await supabase.rpc("release_list_member_claim", { p_session_id: body.sessionId, p_reason: body.reason });
    if (error) return NextResponse.json({ error: error.message }, { status: 409 });
    return NextResponse.json({ released: true });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "validation_error", details: error.issues }, { status: 422 });
    return NextResponse.json({ error: error instanceof Error ? error.message : "internal_error" }, { status: 500 });
  }
}
