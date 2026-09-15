import { NextResponse } from "next/server";
import { z } from "zod";
import { getAppContext } from "@/lib/auth";
import { assertPermission } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

const schema = z.object({
  sessionId: z.uuid(),
  // Registreringens id hos telefonitjänsten. Skickas först när SIP faktiskt
  // svarat ja; det är det enda som får flytta sessionen till `registered`.
  registrationId: z.string().trim().max(200).nullable().optional(),
});

export async function POST(request: Request) {
  try {
    const context = await getAppContext();
    assertPermission(context.role, "calls.create");
    const body = schema.parse(await request.json());
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("heartbeat_webphone_session", {
      p_session_id: body.sessionId,
      p_registration_id: body.registrationId ?? null,
    });
    if (error) {
      console.error("webphone_heartbeat_failed", { code: error.code ?? null });
      return NextResponse.json(
        { error: "webphone_heartbeat_failed", message: "Webbtelefonens anslutning kunde inte bekräftas." },
        { status: 500 },
      );
    }
    // `alive: false` är ett giltigt svar, inte ett fel: sessionen är stängd
    // eller bortsopad och klienten ska registrera om sig. Ett tomt svar är
    // däremot ett fel, och får inte tolkas som att allt står rätt till.
    if (!data) {
      return NextResponse.json(
        { error: "webphone_heartbeat_failed", message: "Webbtelefonens anslutning kunde inte bekräftas." },
        { status: 500 },
      );
    }
    return NextResponse.json(data);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "validation_error", details: error.issues }, { status: 422 });
    }
    console.error("webphone_heartbeat_failed", { error: error instanceof Error ? error.name : "unknown" });
    return NextResponse.json(
      { error: "webphone_heartbeat_failed", message: "Webbtelefonens anslutning kunde inte bekräftas." },
      { status: 500 },
    );
  }
}
