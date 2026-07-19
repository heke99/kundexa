import { NextResponse } from "next/server";
import { z } from "zod";
import { getAppContext } from "@/lib/auth";
import { zonedLocalDateTimeToIso } from "@/lib/domain/time";
import { assertPermission } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

const schema = z.object({
  callId: z.uuid(),
  disposition: z.enum(["no_answer", "busy", "voicemail", "callback", "interested", "not_interested", "wrong_number", "do_not_call"]),
  notes: z.string().max(10000).nullable().optional(),
  callbackScope: z.enum(["personal", "global"]).nullable().optional(),
  callbackDueAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/).nullable().optional(),
}).superRefine((value, context) => {
  if (value.disposition === "callback" && (!value.callbackScope || !value.callbackDueAt)) context.addIssue({ code: "custom", message: "Återkomsttyp och tid krävs" });
});

export async function POST(request: Request) {
  try {
    const context = await getAppContext();
    assertPermission(context.role, "calls.create");
    const body = schema.parse(await request.json());
    const callbackDueAt = body.callbackDueAt ? zonedLocalDateTimeToIso(body.callbackDueAt, context.tenantTimezone) : null;
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("complete_manual_call_work", {
      p_call_id: body.callId,
      p_disposition: body.disposition,
      p_notes: body.notes ?? null,
      p_callback_scope: body.callbackScope ?? null,
      p_callback_due_at: callbackDueAt,
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 409 });
    return NextResponse.json(data);
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "validation_error", details: error.issues }, { status: 422 });
    return NextResponse.json({ error: error instanceof Error ? error.message : "internal_error" }, { status: 500 });
  }
}
