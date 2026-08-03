import { NextResponse } from "next/server";
import { z } from "zod";
import { getAppContext } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertPermission } from "@/lib/permissions";
import { createPlatformRinkelClient } from "@/lib/integrations/rinkel/client";
import { safeRinkelError } from "@/lib/integrations/rinkel/errors";

const callDirectionSchema = z.enum(["inbound", "outbound"]);

const bodySchema = z.object({
  customerId: z.uuid(),
  sessionId: z.uuid().nullable().optional(),
  listMemberId: z.uuid().nullable().optional(),
  callbackActivityId: z.uuid().nullable().optional(),
  contactPersonId: z.uuid().nullable().optional(),
  targetPhone: z.string().regex(/^\+[1-9][0-9]{7,14}$/),
  numberAllocationId: z.uuid().nullable().optional(),
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
  deviceId?: string;
  numberId?: string;
  to?: string;
  status: string;
  attemptStatus?: string;
  providerStatus?: string;
  message?: string;
  callActive?: boolean;
  idempotentReplay: boolean;
};

function publicTelephonyMessage(message: string) {
  return message
    .replace(/rinkel/gi, "telefonitjänsten")
    .replace(/provider/gi, "telefonitjänsten")
    .replace(/leverantör/gi, "telefonitjänst");
}

function reservationFailure(rawMessage: string, databaseCode?: string | null) {
  const normalized = rawMessage.toUpperCase();
  if (["42P01", "42703", "PGRST204"].includes(databaseCode ?? "")) {
    return { code: "DATABASE_SCHEMA_MISMATCH", message: "Databasschemat är inte synkroniserat med applikationen.", status: 503 };
  }
  if (databaseCode === "42501" || databaseCode === "PGRST301") {
    return { code: "DATABASE_PERMISSION_ERROR", message: "Databasen nekade samtalsåtgärden.", status: 403 };
  }
  if (normalized.includes("RINKEL_PLATFORM_NOT_CONFIGURED") || normalized.includes("RINKEL_API_NOT_VERIFIED")) {
    return { code: "RINKEL_API_NOT_VERIFIED", message: "Telefoni är inte konfigurerad och verifierad av plattformsadministratören.", status: 409 };
  }
  if (normalized.includes("DIAL_CONFIGURATION_INCOMPLETE")) {
    return { code: "DIAL_CONFIGURATION_INCOMPLETE", message: "Användar-, enhets- eller nummerkonfigurationen för telefoni är inte komplett.", status: 409 };
  }
  if (normalized.includes("NUMBER_ALLOCATION") || normalized.includes("DIAL_PERMISSION_DENIED") || normalized.includes("NUMBER_GRANT")) {
    return { code: normalized.includes("DIAL_PERMISSION_DENIED") ? "DIAL_PERMISSION_DENIED" : "NUMBER_ALLOCATION_MISSING", message: "Du saknar åtkomst till ett aktivt utgående telefonnummer.", status: 409 };
  }
  if (normalized.includes("USER_MAPPING") || normalized.includes("MAPPING")) {
    return { code: "USER_MAPPING_MISSING", message: "Säljaren saknar en aktiv telefonimappning.", status: 409 };
  }
  if (normalized.includes("DEVICE")) {
    return { code: "DEVICE_MISSING", message: "Säljaren saknar en aktiv vald telefonienhet.", status: 409 };
  }
  if (normalized.includes("TELEPHONY_DISABLED")) return { code: "TELEPHONY_DISABLED", message: "Telefoni är pausad för företaget.", status: 409 };
  if (normalized.includes("MANUAL_DIALER_DISABLED")) return { code: "MANUAL_DIALER_DISABLED", message: "Manuell uppringning är avstängd för företaget.", status: 409 };
  if (normalized.includes("AUTOMATIC_DIALER_DISABLED") || normalized.includes("RINKEL_AUTODIALER_NOT_READY")) {
    return { code: "RINKEL_AUTODIALER_NOT_READY", message: "Auto-dialern är inte redo. Kontrollera kärnwebhookar och workerstatus.", status: 409 };
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
  const correlationId = crypto.randomUUID();
  let reserved: Reservation | null = null;
  let dialSubmitted = false;
  try {
    const context = await getAppContext();
    assertPermission(context.role, "calls.create");
    const parsed = bodySchema.parse(await request.json());
    const supabase = await createClient();
    const result = await supabase.rpc("rinkel_reserve_platform_outbound_call_v2", {
      p_customer_id: parsed.customerId,
      p_contact_person_id: parsed.contactPersonId ?? null,
      p_target_phone: parsed.targetPhone,
      p_session_id: parsed.sessionId ?? null,
      p_list_member_id: parsed.listMemberId ?? null,
      p_callback_activity_id: parsed.callbackActivityId ?? null,
      p_client_request_id: parsed.clientRequestId,
      p_idempotency_key: parsed.idempotencyKey,
      p_purpose: parsed.purpose,
      p_number_allocation_id: parsed.numberAllocationId ?? null,
    });
    if (result.error || !result.data) {
      const failure = reservationFailure(result.error?.message ?? "rinkel_call_reservation_failed", result.error?.code ?? null);
      console.error("rinkel_call_reservation_failed", {
        correlationId,
        databaseCode: result.error?.code ?? null,
        failureCode: failure.code,
      });
      return NextResponse.json({ error: failure.code, message: failure.message, correlationId }, { status: failure.status });
    }
    reserved = result.data as Reservation;
    if (reserved.idempotentReplay) {
      const uncertain = ["provider_outcome_unknown", "reconciliation_required", "unknown"]
        .includes(reserved.attemptStatus ?? reserved.providerStatus ?? reserved.status);
      const active = reserved.callActive ?? [
        "requested", "dial_requested", "awaiting_provider_event", "matched",
        "provider_outcome_unknown", "reconciliation_required",
      ].includes(reserved.attemptStatus ?? reserved.status);
      return NextResponse.json({
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
    if (!reserved.deviceId || !reserved.numberId || !reserved.to) {
      throw new Error("rinkel_reservation_contract_invalid");
    }

    const admin = createAdminClient();
    const { error: requestStateError } = await admin.from("rinkel_call_attempts_v2").update({
      status: "dial_requested",
      provider_request_started_at: new Date().toISOString(),
    }).eq("tenant_id", context.tenantId).eq("id", reserved.attemptId).eq("call_id", reserved.callId);
    if (requestStateError) throw new Error("DATABASE_CALL_ATTEMPT_UPDATE_FAILED");

    const client = createPlatformRinkelClient(reserved.attemptId);
    await client.dial({
      deviceId: reserved.deviceId,
      to: reserved.to,
      numberId: reserved.numberId,
      anonymous: false,
    });
    dialSubmitted = true;
    const { error: finalizeError } = await admin.rpc("rinkel_finalize_platform_dial", {
      p_call_id: reserved.callId,
      p_attempt_id: reserved.attemptId,
      p_outcome: "accepted",
      p_error_code: null,
      p_error_message: null,
    });
    if (finalizeError) throw new Error("rinkel_dial_finalize_failed");
    return NextResponse.json({
      callId: reserved.callId,
      status: "dial_requested",
      message: "Samtalet initieras på din telefonienhet.",
      correlationId,
    }, { status: 202 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "validation_error", details: error.issues }, { status: 422 });
    }
    const safe = safeRinkelError(error);
    const outcomeUnknown = safe.outcomeUnknown || dialSubmitted;
    if (reserved) {
      const admin = createAdminClient();
      await admin.rpc("rinkel_finalize_platform_dial", {
        p_call_id: reserved.callId,
        p_attempt_id: reserved.attemptId,
        p_outcome: outcomeUnknown ? "unknown" : "failed",
        p_error_code: safe.code,
        p_error_message: safe.message,
      });
    }
    const status = outcomeUnknown ? 202
      : safe.code === "RINKEL_AUTHENTICATION_ERROR" || safe.code === "RINKEL_FORBIDDEN" ? 502
        : safe.code === "RINKEL_RATE_LIMITED" ? 429
          : 409;
    return NextResponse.json({
      error: safe.code,
      message: outcomeUnknown
        ? "Samtalsstartens utfall är oklart. Försök inte igen; Kundexa inväntar säker avstämning."
        : publicTelephonyMessage(safe.message),
      callId: reserved?.callId ?? null,
      status: outcomeUnknown ? "provider_outcome_unknown" : "failed",
      correlationId,
    }, { status });
  }
}
