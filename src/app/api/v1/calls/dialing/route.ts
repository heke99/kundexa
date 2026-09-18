import { z } from "zod";
import { getAppContext } from "@/lib/auth";
import { assertPermission } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";
import { apiJson, getCorrelationId } from "@/lib/api-correlation";

/**
 * Webbläsaren rapporterar vad leverantören gav samtalet för identitet.
 *
 * Servern reserverar samtalet men kopplar det inte -- det gör säljarens
 * webbtelefon. Först när SDK:t svarat finns ett samtals-ID hos leverantören, och
 * utan det går inkommande `ace` och `dice` inte att koppla till rätt försök.
 *
 * `unknown` finns och är inte samma sak som `failed`. Om webbläsaren startade
 * samtalet men tappade svaret kan telefonen mycket väl ringa hos mottagaren, och
 * att stänga försöket som misslyckat skulle släppa platsen mitt i ett pågående
 * samtal. Det är samma skillnad som den gamla vägen fick fel två gånger i
 * produktion.
 */
const bodySchema = z.object({
  callId: z.uuid(),
  attemptId: z.uuid(),
  outcome: z.enum(["accepted", "failed", "unknown"]),
  externalCallId: z.string().trim().min(1).max(200).nullable().optional(),
  errorCode: z.string().trim().max(100).nullable().optional(),
  errorMessage: z.string().trim().max(500).nullable().optional(),
}).superRefine((input, context) => {
  if (input.outcome === "accepted" && !input.externalCallId) {
    // Ett accepterat samtal utan identitet hos leverantören går inte att koppla
    // ihop med händelserna som följer. Att ta emot det ändå vore att spara en
    // rad som ser rätt ut och aldrig kan stämmas av.
    context.addIssue({ code: "custom", path: ["externalCallId"], message: "externalCallId krävs när samtalet accepterades" });
  }
});

export async function POST(request: Request) {
  const correlationId = getCorrelationId(request);
  try {
    const context = await getAppContext();
    assertPermission(context.role, "calls.create");
    const parsed = bodySchema.parse(await request.json());

    // Säljarens egen klient, inte admin: RPC:n kontrollerar att försöket hör
    // till den som rapporterar, och en säljare ska inte kunna stänga någon
    // annans samtal genom att gissa ett id.
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("finalize_dial", {
      p_call_id: parsed.callId,
      p_attempt_id: parsed.attemptId,
      p_outcome: parsed.outcome,
      p_external_call_id: parsed.externalCallId ?? null,
      p_error_code: parsed.errorCode ?? null,
      p_error_message: parsed.errorMessage ?? null,
    });
    if (error) {
      const notFound = error.message.includes("dial_attempt_not_found");
      console.error("call_dialing_report_failed", { correlationId, code: error.code ?? null });
      return apiJson(correlationId, {
        error: notFound ? "dial_attempt_not_found" : "call_dialing_report_failed",
        message: notFound
          ? "Samtalsförsöket finns inte, eller tillhör någon annan."
          : "Samtalets status kunde inte skrivas.",
        correlationId,
      }, { status: notFound ? 404 : 500 });
    }

    return apiJson(correlationId, { ...(data as Record<string, unknown>), correlationId }, { status: 200 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return apiJson(correlationId, { error: "validation_error", details: error.issues, correlationId }, { status: 422 });
    }
    console.error("call_dialing_report_failed", { correlationId, error: error instanceof Error ? error.name : "unknown" });
    return apiJson(correlationId, { error: "call_dialing_report_failed", message: "Samtalets status kunde inte skrivas.", correlationId }, { status: 500 });
  }
}
