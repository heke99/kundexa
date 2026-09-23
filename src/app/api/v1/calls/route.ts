import { NextResponse } from "next/server";
import { redactProviderNames } from "@/lib/telephony/webphone";
import { z } from "zod";
import { getAppContext } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertPermission } from "@/lib/permissions";
import { apiJson, getCorrelationId } from "@/lib/api-correlation";

const callDirectionSchema = z.enum(["inbound", "outbound"]);

const bodySchema = z.object({
  customerId: z.uuid(),
  sessionId: z.uuid().nullable().optional(),
  listMemberId: z.uuid().nullable().optional(),
  callbackActivityId: z.uuid().nullable().optional(),
  contactPersonId: z.uuid().nullable().optional(),
  targetPhone: z.string().regex(/^\+[1-9][0-9]{7,14}$/),
  callerIdPhoneNumberId: z.uuid().nullable().optional(),
  webphoneSessionId: z.uuid().nullable().optional(),
  clientRequestId: z.uuid(),
  idempotencyKey: z.string().min(8).max(200),
  purpose: z.enum(["direct_marketing", "customer_service", "contract_followup"]).default("direct_marketing"),
}).superRefine((input, context) => {
  if (Boolean(input.sessionId) !== Boolean(input.listMemberId)) {
    context.addIssue({ code: "custom", message: "sessionId och listMemberId måste anges tillsammans" });
  }
});

type Reservation = {
  callId: string;
  attemptId: string;
  to?: string;
  callerId?: string;
  callerIdSource?: string;
  status: string;
  attemptStatus?: string;
  providerStatus?: string;
  message?: string;
  callActive?: boolean;
  idempotentReplay: boolean;
};

function publicTelephonyMessage(message: string) {
  // Namnen hämtas ur registret. En hårdkodad lista slutar täcka i samma stund
  // som vi byter, och då står leverantörens namn i säljarens felmeddelande.
  return redactProviderNames(message);
}

// Dialling the tenant's own caller-ID number loops the call back to the same
// trunk. The reservation refuses it before any call row exists; say which number
// is the problem rather than "reservation failed".
const selfDialMessage = "Numret är detsamma som företagets utgående nummer. Ett samtal till det egna numret kopplas tillbaka till samma linje — ange kundens nummer i stället.";

// The reservation raises `exact_call_policy_denied:<reason>`. Report which rule
// actually stopped the call: "spärr- och samtyckesreglerna" is true but tells the
// seller nothing about what to do next.
function callPolicyFailure(reason: string) {
  const failures: Record<string, { code: string; message: string; status: number }> = {
    NIX_CHECK_REQUIRED: {
      code: "NIX_CHECK_REQUIRED",
      message: "Privatpersoner måste NIX-kontrolleras innan ett marknadsföringssamtal. Ingen giltig kontroll finns för numret. Konfigurera en NIX-leverantör under Regelefterlevnad och kör kontrollen, eller markera kunden som företag om det är ett B2B-samtal.",
      status: 409,
    },
    TARGET_NIX_CHECK_REQUIRED: {
      code: "NIX_CHECK_REQUIRED",
      message: "Privatpersoner måste NIX-kontrolleras innan ett marknadsföringssamtal. Ingen giltig kontroll finns för numret. Konfigurera en NIX-leverantör under Regelefterlevnad och kör kontrollen, eller markera kunden som företag om det är ett B2B-samtal.",
      status: 409,
    },
    NIX_LISTED: { code: "NIX_LISTED", message: "Numret är spärrat i NIX-registret och får inte ringas i marknadsföringssyfte.", status: 409 },
    TARGET_NIX_LISTED: { code: "NIX_LISTED", message: "Numret är spärrat i NIX-registret och får inte ringas i marknadsföringssyfte.", status: 409 },
    LEGAL_BASIS_REQUIRED: {
      code: "LEGAL_BASIS_REQUIRED",
      message: "Privatkunden saknar rättslig grund för marknadsföring. Ange rättslig grund på kundkortet eller registrera ett samtycke innan samtalet.",
      status: 409,
    },
    MARKETING_NOT_ALLOWED: { code: "MARKETING_NOT_ALLOWED", message: "Kunden har markerats som att marknadsföring inte är tillåten.", status: 409 },
    CUSTOMER_DO_NOT_CALL: { code: "CUSTOMER_DO_NOT_CALL", message: "Kunden är spärrad för samtal på kundkortet.", status: 409 },
    CUSTOMER_CHANNEL_BLOCK: { code: "CUSTOMER_DO_NOT_CALL", message: "Kunden är spärrad för samtal på kundkortet.", status: 409 },
    COMPLIANCE_BLOCK: { code: "COMPLIANCE_BLOCK", message: "En aktiv regelefterlevnadsspärr gäller för kunden eller numret.", status: 409 },
    OUTSIDE_CONTACT_HOURS: { code: "OUTSIDE_CONTACT_HOURS", message: "Marknadsföringssamtal är inte tillåtna vid den här tidpunkten enligt företagets kontakttider.", status: 409 },
    FEATURE_DISABLED: { code: "OUTBOUND_CALLS_DISABLED", message: "Utgående samtal är inte aktiverat för företaget.", status: 409 },
    TARGET_PHONE_CUSTOMER_MISMATCH: { code: "CALL_TARGET_INVALID", message: "Telefonnumret hör inte till kundkortet.", status: 422 },
    TARGET_PHONE_CONTACT_MISMATCH: { code: "CALL_TARGET_INVALID", message: "Telefonnumret hör inte till den valda kontaktpersonen.", status: 422 },
    CUSTOMER_ACCESS_DENIED: { code: "DIAL_PERMISSION_DENIED", message: "Du har inte åtkomst till den här kunden.", status: 403 },
    CALL_ROLE_NOT_PERMITTED: { code: "DIAL_PERMISSION_DENIED", message: "Din roll får inte ringa utgående samtal.", status: 403 },
    SELF_DIAL_NOT_ALLOWED: { code: "SELF_DIAL_NOT_ALLOWED", message: selfDialMessage, status: 422 },
    LIST_CLAIM_NOT_OPERATIONAL: { code: "LEAD_RESERVATION_CONFLICT", message: "Leadreservationen är inte längre aktiv för den här säljaren.", status: 409 },
    CALLBACK_NOT_AVAILABLE: { code: "LEAD_RESERVATION_CONFLICT", message: "Återuppringningen är inte längre tillgänglig för dig.", status: 409 },
  };
  const known = failures[reason];
  if (known) return known;
  if (reason.startsWith("CONTACT_PERMISSION_")) {
    return { code: "CONTACT_PERMISSION_DENIED", message: "Kunden har invänt mot eller nekat kontakt i det här syftet.", status: 409 };
  }
  if (reason.startsWith("NIX_") || reason.startsWith("TARGET_NIX_")) {
    return { code: "NIX_BLOCKED", message: "NIX-kontrollen tillåter inte marknadsföringssamtal till numret.", status: 409 };
  }
  return { code: "DIAL_PERMISSION_DENIED", message: "Numret får inte ringas enligt spärr- och samtyckesreglerna.", status: 409 };
}

function reservationFailure(rawMessage: string, databaseCode?: string | null) {
  const normalized = rawMessage.toUpperCase();
  if (["42P01", "42703", "PGRST204"].includes(databaseCode ?? "")) {
    return { code: "DATABASE_SCHEMA_MISMATCH", message: "Databasschemat är inte synkroniserat med applikationen.", status: 503 };
  }
  if (databaseCode === "42501" || databaseCode === "PGRST301") {
    return { code: "DATABASE_PERMISSION_ERROR", message: "Databasen nekade samtalsåtgärden.", status: 403 };
  }
  // Most specific first: the policy reason must not be shadowed by a broader
  // substring match further down.
  const policyReason = /EXACT_CALL_POLICY_DENIED:([A-Z0-9_]+)/.exec(normalized)?.[1];
  if (policyReason) return callPolicyFailure(policyReason);
  if (normalized.includes("SELF_DIAL_NOT_ALLOWED")) {
    return { code: "SELF_DIAL_NOT_ALLOWED", message: selfDialMessage, status: 422 };
  }
  if (normalized.includes("CALLER_ID_MISSING")) {
    return { code: "CALLER_ID_MISSING", message: "Företaget har inget nummer att visa för mottagaren. En administratör behöver välja företagets utgående nummer innan samtal kan ringas.", status: 409 };
  }
  if (normalized.includes("DIAL_CONFIGURATION_INCOMPLETE")) {
    return {
      code: "DIAL_CONFIGURATION_INCOMPLETE",
      message: "Telefonin saknar en registrerad enhet eller ett utgående nummer för säljaren. Kontrollera att säljaren är inloggad i telefonitjänstens webbtelefon eller app och att katalogen är synkroniserad.",
      status: 409,
    };
  }
  if (normalized.includes("NUMBER_ALLOCATION") || normalized.includes("DIAL_PERMISSION_DENIED") || normalized.includes("NUMBER_GRANT")) {
    return { code: normalized.includes("DIAL_PERMISSION_DENIED") ? "DIAL_PERMISSION_DENIED" : "NUMBER_ALLOCATION_MISSING", message: "Du saknar åtkomst till ett aktivt utgående telefonnummer.", status: 409 };
  }
  if (normalized.includes("USER_MAPPING") || normalized.includes("MAPPING")) {
    return { code: "USER_MAPPING_MISSING", message: "Säljaren saknar en aktiv telefonimappning.", status: 409 };
  }
  if (normalized.includes("DEVICE")) {
    return {
      code: "PROVIDER_DEVICE_MISSING",
      message: "Telefonitjänsten har ingen registrerad enhet för säljaren. Logga in i telefonitjänstens webbtelefon eller app och låt plattformsadministratören synkronisera katalogen.",
      status: 409,
    };
  }
  if (normalized.includes("TELEPHONY_DISABLED")) return { code: "TELEPHONY_DISABLED", message: "Telefoni är pausad för företaget.", status: 409 };
  if (normalized.includes("MANUAL_DIALER_DISABLED")) return { code: "MANUAL_DIALER_DISABLED", message: "Manuell uppringning är avstängd för företaget.", status: 409 };
  if (normalized.includes("AUTOMATIC_DIALER_DISABLED")) {
    return { code: "AUTOMATIC_DIALER_DISABLED", message: "Automatisk uppringning är avstängd för företaget.", status: 409 };
  }
  if (normalized.includes("ACTIVE_CALL")) return { code: "ACTIVE_CALL_EXISTS", message: "Säljaren eller den valda enheten har redan ett aktivt samtal.", status: 409 };
  if (normalized.includes("DO_NOT_CALL") || normalized.includes("NIX") || normalized.includes("CONTACT_NOT_ALLOWED")) {
    return { code: "DIAL_PERMISSION_DENIED", message: "Numret får inte ringas enligt spärr- och samtyckesreglerna.", status: 409 };
  }
  if (normalized.includes("OUTSIDE_")) return { code: "TELEPHONY_OUTSIDE_ALLOWED_TIME", message: "Samtalet är inte tillåtet vid den här tiden.", status: 409 };
  if (normalized.includes("CLAIM") || normalized.includes("DIALER_SESSION")) return { code: "LEAD_RESERVATION_CONFLICT", message: "Leadreservationen är inte längre aktiv för den här säljaren.", status: 409 };
  if (normalized.includes("IDEMPOTENCY_IDENTITY_CONFLICT")) return { code: "IDEMPOTENCY_CONFLICT", message: "Samtalsförsökets idempotensuppgifter pekar på olika försök.", status: 409 };
  if (normalized.includes("CUSTOMER_NOT_FOUND") || normalized.includes("CONTACT_PERSON_NOT_FOUND") || normalized.includes("TARGET_PHONE_")) {
    return { code: "CALL_TARGET_INVALID", message: "Kunden, kontakten eller telefonnumret kunde inte verifieras.", status: 422 };
  }
  return { code: "CALL_RESERVATION_FAILED", message: "Samtalet kunde inte reserveras säkert.", status: 400 };
}

function internalDialFailure(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  switch (code) {
    case "reservation_contract_invalid":
      return {
        code: "DIAL_RESERVATION_CONTRACT_INVALID",
        message: "Samtalsreservationen saknade en giltig enhet, ett utgående nummer eller ett måltelefonnummer.",
        status: 500,
      };
    case "DATABASE_CALL_ATTEMPT_UPDATE_FAILED":
      return {
        code: "DATABASE_CALL_ATTEMPT_UPDATE_FAILED",
        message: "Samtalsförsöket kunde inte förberedas i databasen.",
        status: 503,
      };
      return {
        code: "DIAL_FINALIZATION_FAILED",
        message: "Samtalet skickades men den lokala statusen kunde inte bekräftas.",
        status: 202,
      };
    default:
      return null;
  }
}

export async function GET(request: Request) {
  try {
    const context = await getAppContext();
    assertPermission(context.role, "calls.read");
    const url = new URL(request.url);
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") ?? 50)));
    const callId = url.searchParams.get("id");
    const supabase = await createClient();
    const selection = "id,direction,status,end_cause,provider_status,provider_outcome,provider_cause,from_number,to_number,initiated_at,answered_at,ended_at,duration_seconds,disposition,recording_status,transcription_status,insights_status,created_at,customers(display_name)";
    if (callId) {
      const parsedId = z.uuid().safeParse(callId);
      if (!parsedId.success) return NextResponse.json({ error: "invalid_call_id" }, { status: 422 });
      const { data, error } = await supabase.from("calls").select(selection).eq("id", parsedId.data).maybeSingle();
      if (error) return NextResponse.json({ error: "call_query_failed" }, { status: 500 });
      if (!data) return NextResponse.json({ error: "call_not_found" }, { status: 404 });
      return NextResponse.json({ data });
    }
    let query = supabase.from("calls")
      .select(selection)
      .order("created_at", { ascending: false })
      .limit(limit);
    const status = url.searchParams.get("status");
    const direction = callDirectionSchema.safeParse(url.searchParams.get("direction"));
    if (status) query = query.eq("status", status);
    if (direction.success) query = query.eq("direction", direction.data);
    const { data, error } = await query;
    if (error) return NextResponse.json({ error: "calls_query_failed" }, { status: 500 });
    return NextResponse.json({ data: data ?? [] });
  } catch (error) {
    console.error("calls_query_failed", { error: error instanceof Error ? error.name : "unknown" });
    return NextResponse.json({ error: "calls_query_failed" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const correlationId = getCorrelationId(request);
  let reserved: Reservation | null = null;
  try {
    const context = await getAppContext();
    assertPermission(context.role, "calls.create");
    const parsed = bodySchema.parse(await request.json());
    // Sessionen kopplas till försöket så att en stängd eller tappad flik släpper
    // platsen direkt. Den måste vara säljarens egen och levande; annars kopplas
    // ingen alls, och samtalet ringer ändå -- städningen tar då försöket.
    let webphoneSessionId: string | null = null;
    if (parsed.webphoneSessionId) {
      const { data: ownSession } = await createAdminClient().from("webphone_sessions")
        .select("id").eq("id", parsed.webphoneSessionId).eq("tenant_id", context.tenantId)
        .eq("seller_user_id", context.userId).in("status", ["registering", "registered"]).maybeSingle();
      webphoneSessionId = ownSession?.id ?? null;
    }
    const supabase = await createClient();

    // Reservationen är allt servern gör. Samtalet kopplas av säljarens
    // webbtelefon, inte härifrån: det är hela skillnaden mot den gamla vägen,
    // där servern bad telefonitjänsten ringa upp en enhet som sedan ringde
    // vidare. Raden och platsen finns innan webbläsaren får något att ringa,
    // så ett samtal utan spår är inte möjligt.
    const result = await supabase.rpc("reserve_outbound_call", {
      p_customer_id: parsed.customerId,
      p_contact_person_id: parsed.contactPersonId ?? null,
      p_target_phone: parsed.targetPhone,
      p_session_id: parsed.sessionId ?? null,
      p_list_member_id: parsed.listMemberId ?? null,
      p_callback_activity_id: parsed.callbackActivityId ?? null,
      p_client_request_id: parsed.clientRequestId,
      p_idempotency_key: parsed.idempotencyKey,
      p_purpose: parsed.purpose,
      p_caller_id_phone_number_id: parsed.callerIdPhoneNumberId ?? null,
      p_webphone_session_id: webphoneSessionId,
    });
    if (result.error || !result.data) {
      const failure = reservationFailure(result.error?.message ?? "call_reservation_failed", result.error?.code ?? null);
      console.error("call_reservation_failed", {
        correlationId,
        databaseCode: result.error?.code ?? null,
        failureCode: failure.code,
      });
      return apiJson(correlationId, { error: failure.code, message: failure.message, correlationId }, { status: failure.status });
    }
    reserved = result.data as unknown as Reservation;
    if (reserved.idempotentReplay) {
      const uncertain = ["provider_outcome_unknown", "reconciliation_required", "unknown"]
        .includes(reserved.attemptStatus ?? reserved.providerStatus ?? reserved.status);
      const active = reserved.callActive ?? false;
      return apiJson(correlationId, {
        callId: reserved.callId,
        status: reserved.status,
        attemptStatus: reserved.attemptStatus ?? reserved.status,
        providerStatus: reserved.providerStatus ?? "unknown",
        message: reserved.message ?? (active ? "Det befintliga samtalsförsöket återanvänds." : "Det tidigare samtalsförsöket är avslutat."),
        callActive: active,
        idempotentReplay: true,
        correlationId,
      }, { status: active || uncertain ? 202 : 409 });
    }
    if (!reserved.to || !reserved.callerId) {
      throw new Error("reservation_contract_invalid");
    }

    // Webbläsaren får numret att ringa och numret att visa. Samtalets identitet
    // hos leverantören rapporteras tillbaka när den finns, genom
    // POST /api/v1/calls/dialing.
    return apiJson(correlationId, {
      callId: reserved.callId,
      attemptId: reserved.attemptId,
      to: reserved.to,
      callerId: reserved.callerId,
      callerIdSource: reserved.callerIdSource ?? null,
      status: "requested",
      message: "Samtalet är reserverat. Webbtelefonen kopplar upp det.",
      correlationId,
    }, { status: 202 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return apiJson(correlationId, { error: "validation_error", details: error.issues, correlationId }, { status: 422 });
    }
    // Servern ringer inte längre. Det enda som kan gå fel här är reservationen,
    // och den är en databastransaktion: den lyckas eller rullar tillbaka. Det
    // "okända utfall" den gamla vägen behövde -- ett anrop som gick ut men vars
    // svar aldrig kom -- uppstår nu i webbläsaren i stället, och rapporteras
    // genom POST /api/v1/calls/dialing.
    const internal = internalDialFailure(error);
    const code = internal?.code ?? "call_reservation_failed";
    const message = internal
      ? publicTelephonyMessage(internal.message)
      : "Samtalet kunde inte reserveras.";
    if (reserved) {
      // Reservationen gick igenom men något efter den föll. Platsen måste
      // släppas, annars kan säljaren inte ringa nästa nummer. Säljarens egen
      // klient: `finalize_dial` härleder tenant och ägare ur inloggningen, och
      // med tjänstenyckeln fanns ingen av dem -- funktionen svarade
      // `authentication_required` och platsen blev kvar låst.
      const own = await createClient();
      const { error: finalizeFailure } = await own.rpc("finalize_dial", {
        p_call_id: reserved.callId,
        p_attempt_id: reserved.attemptId,
        p_outcome: "failed",
        p_external_call_id: null,
        p_error_code: code,
        p_error_message: message,
      });
      if (finalizeFailure) {
        console.error("dial_failure_finalization_failed", {
          correlationId,
          callId: reserved.callId,
          errorCode: finalizeFailure.code ?? null,
        });
      }
    }
    console.error("dial_start_failed", { correlationId, callId: reserved?.callId ?? null, errorCode: code });
    return apiJson(correlationId, {
      error: code,
      message,
      callId: reserved?.callId ?? null,
      status: "failed",
      correlationId,
    }, { status: internal?.status ?? 409 });
  }
}
