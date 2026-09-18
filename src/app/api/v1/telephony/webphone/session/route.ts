import { NextResponse } from "next/server";
import { z } from "zod";
import { getAppContext } from "@/lib/auth";
import { assertPermission } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";
import { provisionWebphone, telephonyProviderKey } from "@/lib/telephony/webphone";
import { turnConfigured } from "@/lib/telephony/webphone/ice";

// Namnet står i registret, inte här. Den här rutten ska inte behöva ändras för
// att vi byter telefonitjänst.
const TELEPHONY_PROVIDER = telephonyProviderKey();

const openSchema = z.object({
  userAgent: z.string().trim().max(400).nullable().optional(),
});

const closeSchema = z.object({
  sessionId: z.uuid(),
  reason: z.string().trim().max(200).nullable().optional(),
});

const failures: Record<string, { message: string; status: number }> = {
  authentication_required: { message: "Din inloggning saknar företagskoppling.", status: 403 },
  call_create_permission_required: { message: "Du har inte behörighet att ringa samtal.", status: 403 },
  webphone_provider_required: { message: "Webbtelefonen saknar telefonitjänst.", status: 400 },
  webphone_session_not_found: { message: "Webbtelefonsessionen finns inte.", status: 404 },
};

function rpcFailure(message: string, fallback: string) {
  const known = Object.entries(failures).find(([code]) => message.includes(code));
  if (known) return NextResponse.json({ error: known[0], message: known[1].message }, { status: known[1].status });
  return NextResponse.json({ error: fallback, message: "Webbtelefonen kunde inte startas." }, { status: 500 });
}

export async function POST(request: Request) {
  try {
    const context = await getAppContext();
    assertPermission(context.role, "calls.create");
    const body = openSchema.parse(await request.json().catch(() => ({})));
    const supabase = await createClient();

    const { data: session, error } = await supabase.rpc("open_webphone_session", {
      p_provider: TELEPHONY_PROVIDER,
      p_user_agent: body.userAgent ?? null,
    });
    if (error) return rpcFailure(error.message, "webphone_session_failed");
    // PostgREST rapporterar ett uteblivet svar likadant som ett tomt. En session
    // utan id är ingen session, och att låta klienten börja slå hjärtslag mot
    // den hade dolt felet i stället för att visa det.
    if (!session || typeof session !== "object" || !("sessionId" in session)) {
      return NextResponse.json(
        { error: "webphone_session_failed", message: "Webbtelefonen kunde inte startas." },
        { status: 500 },
      );
    }

    const sessionId = String((session as { sessionId: unknown }).sessionId);

    // A-numret måste med redan här. Telefonitjänsten binder det till klienten
    // när den byggs, inte till det enskilda samtalet, så det går inte att skjuta upp
    // till uppringningen. Saknas det svarar adaptern med ett nej som går att
    // läsa, i stället för att dela ut uppgifter för samtal som aldrig kopplas.
    const { data: callerId } = await supabase
      .from("telephony_policies")
      .select("phone_numbers!telephony_policies_default_caller_id_phone_number_tenant_fk(number_e164)")
      .eq("tenant_id", context.tenantId)
      .maybeSingle();
    const callerIdentifier =
      (callerId as { phone_numbers?: { number_e164?: string | null } | null } | null)
        ?.phone_numbers?.number_e164?.trim() || null;

    const provisioned = await provisionWebphone(TELEPHONY_PROVIDER, {
      tenantId: context.tenantId,
      sellerUserId: context.userId,
      sessionId,
      callerIdentifier,
    });

    // Uppgifterna kunde inte skapas. Sessionen stängs direkt i stället för att
    // lämnas öppen: en session utan samtalsben slår inga hjärtslag, och hade
    // legat kvar tills sopningen tog den halvannan minut senare.
    if (!provisioned.available) {
      await supabase.rpc("close_webphone_session", {
        p_session_id: sessionId,
        p_reason: "Webbtelefonen kunde inte förses med uppgifter",
      });
      return NextResponse.json(
        { error: provisioned.code, message: provisioned.message, available: false },
        { status: 503 },
      );
    }

    return NextResponse.json({
      ...session,
      available: true,
      credentials: provisioned.credentials,
      // Ett samtal utan TURN kopplas upp och blir sedan tyst bakom en
      // företagsbrandvägg, så det ska sägas före samtalet och inte under det.
      // Men TURN gäller bara SIP-vägen. Telefonitjänstens egen SDK sköter ICE, och att
      // rapportera vår TURN-status för ett samtal som inte använder den hade
      // varit en uppgift utan täckning.
      relayConfigured:
        provisioned.credentials.kind === "sip" ? turnConfigured() : null,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "validation_error", details: error.issues }, { status: 422 });
    }
    console.error("webphone_session_failed", { error: error instanceof Error ? error.name : "unknown" });
    return NextResponse.json(
      { error: "webphone_session_failed", message: "Webbtelefonen kunde inte startas." },
      { status: 500 },
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const context = await getAppContext();
    assertPermission(context.role, "calls.create");
    const body = closeSchema.parse(await request.json());
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("close_webphone_session", {
      p_session_id: body.sessionId,
      p_reason: body.reason ?? null,
    });
    if (error) return rpcFailure(error.message, "webphone_close_failed");
    return NextResponse.json(data ?? { sessionId: body.sessionId, closed: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "validation_error", details: error.issues }, { status: 422 });
    }
    console.error("webphone_close_failed", { error: error instanceof Error ? error.name : "unknown" });
    return NextResponse.json(
      { error: "webphone_close_failed", message: "Webbtelefonen kunde inte stängas." },
      { status: 500 },
    );
  }
}
