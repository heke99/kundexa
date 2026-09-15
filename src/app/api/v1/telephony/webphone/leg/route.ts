import { NextResponse } from "next/server";
import { z } from "zod";
import { getAppContext } from "@/lib/auth";
import { assertPermission } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

const schema = z.object({
  callId: z.uuid(),
  sessionId: z.uuid(),
  event: z.enum(["ringing", "answered", "ended", "failed"]),
  // Klientens egen tidpunkt. Servern klipper den om den ligger i framtiden —
  // en webbläsares klocka är inte något att skriva historik efter.
  occurredAt: z.iso.datetime({ offset: true }).nullable().optional(),
});

const failures: Record<string, { message: string; status: number }> = {
  authentication_required: { message: "Din inloggning saknar företagskoppling.", status: 403 },
  webphone_session_not_found: { message: "Webbtelefonsessionen finns inte längre. Anslut webbtelefonen igen.", status: 409 },
  webphone_leg_event_unknown: { message: "Okänd händelse från webbtelefonen.", status: 400 },
  call_not_found: { message: "Samtalet finns inte.", status: 404 },
  call_not_owned_by_caller: { message: "Du kan bara rapportera dina egna samtal.", status: 403 },
};

export async function POST(request: Request) {
  try {
    const context = await getAppContext();
    assertPermission(context.role, "calls.create");
    const body = schema.parse(await request.json());
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("record_webphone_leg_event", {
      p_call_id: body.callId,
      p_session_id: body.sessionId,
      p_event: body.event,
      p_occurred_at: body.occurredAt ?? new Date().toISOString(),
    });
    if (error) {
      const known = Object.entries(failures).find(([code]) => error.message.includes(code));
      if (known) return NextResponse.json({ error: known[0], message: known[1].message }, { status: known[1].status });
      console.error("webphone_leg_failed", { code: error.code ?? null });
      return NextResponse.json(
        { error: "webphone_leg_failed", message: "Samtalets förlopp kunde inte registreras." },
        { status: 500 },
      );
    }
    // PostgREST rapporterar ett uteblivet svar likadant som ett tomt. Att svara
    // "gick bra" på ingenting hade tystat exakt den sortens fel som webbtelefonen
    // byggdes för att sluta dölja.
    if (!data) {
      return NextResponse.json(
        { error: "webphone_leg_failed", message: "Samtalets förlopp kunde inte registreras." },
        { status: 500 },
      );
    }
    return NextResponse.json(data);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "validation_error", details: error.issues }, { status: 422 });
    }
    console.error("webphone_leg_failed", { error: error instanceof Error ? error.name : "unknown" });
    return NextResponse.json(
      { error: "webphone_leg_failed", message: "Samtalets förlopp kunde inte registreras." },
      { status: 500 },
    );
  }
}
