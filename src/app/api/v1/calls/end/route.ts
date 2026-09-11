import { NextResponse } from "next/server";
import { z } from "zod";
import { getAppContext } from "@/lib/auth";
import { assertPermission } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

const schema = z.object({
  callId: z.uuid(),
  reason: z.string().trim().max(200).nullable().optional(),
});

// The reservation refuses a second dial while an attempt is non-terminal, and
// the only thing that released such an attempt was a service-role janitor with
// a 15-minute floor. Ending a call is therefore not a convenience: without it a
// seller whose attempt hangs cannot call anyone for up to an hour.
const failures: Record<string, { message: string; status: number }> = {
  call_not_found: { message: "Samtalet finns inte.", status: 404 },
  call_not_owned_by_caller: { message: "Du kan bara avsluta dina egna samtal.", status: 403 },
  tenant_context_required: { message: "Din inloggning saknar företagskoppling.", status: 403 },
};

export async function POST(request: Request) {
  try {
    const context = await getAppContext();
    assertPermission(context.role, "calls.create");
    const body = schema.parse(await request.json());
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("end_active_call", {
      p_call_id: body.callId,
      p_reason: body.reason ?? null,
    });
    if (error) {
      const known = Object.entries(failures).find(([code]) => error.message.includes(code));
      if (known) return NextResponse.json({ error: known[0], message: known[1].message }, { status: known[1].status });
      console.error("end_active_call_failed", { code: error.code ?? null });
      return NextResponse.json({ error: "end_call_failed", message: "Samtalet kunde inte avslutas." }, { status: 500 });
    }
    // A successful RPC that returned nothing is not "the call ended"; PostgREST
    // reports a missing payload the same way it reports an empty one.
    if (!data) {
      return NextResponse.json({ error: "end_call_failed", message: "Samtalet kunde inte avslutas." }, { status: 500 });
    }
    return NextResponse.json(data);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "validation_error", details: error.issues }, { status: 422 });
    }
    console.error("end_call_failed", { error: error instanceof Error ? error.name : "unknown" });
    return NextResponse.json({ error: "end_call_failed", message: "Samtalet kunde inte avslutas." }, { status: 500 });
  }
}
