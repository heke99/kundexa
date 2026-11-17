import { NextResponse } from "next/server";
import { z } from "zod";
import { getAppContext } from "@/lib/auth";
import { assertPermission } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";
const input = z.object({ sessionId: z.uuid(), externalCallId: z.string().min(1).max(200), action: z.enum(["inspect","accept","decline","established","end"]) }).strict();
export async function POST(request: Request) {
  try {
    const ctx = await getAppContext(); assertPermission(ctx.role,"calls.create");
    const body = input.parse(await request.json());
    const db = await createClient();
    const {data,error} = await db.rpc("inbound_call_command",{p_session_id:body.sessionId,p_external_call_id:body.externalCallId,p_action:body.action});
    if(error || !data) return NextResponse.json({error:"incoming_call_unavailable"},{status:409});
    return NextResponse.json(data,{headers:{"Cache-Control":"no-store"}});
  } catch(error) { return NextResponse.json({error:error instanceof z.ZodError ? "validation_error" : "incoming_call_forbidden"},{status:error instanceof z.ZodError ? 422 : 403}); }
}
