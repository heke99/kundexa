import { NextResponse } from "next/server";
import { z } from "zod";
import { getAppContext } from "@/lib/auth";
import { assertPermission } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  try {
    const context = await getAppContext();
    assertPermission(context.role, "calls.create");
    const { listId } = z.object({ listId: z.uuid() }).parse(await request.json());
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("start_dialer_session", { p_list_id: listId });
    if (error) return NextResponse.json({ error: error.message }, { status: 409 });
    return NextResponse.json({ sessionId: data });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "validation_error", details: error.issues }, { status: 422 });
    return NextResponse.json({ error: error instanceof Error ? error.message : "internal_error" }, { status: 500 });
  }
}
