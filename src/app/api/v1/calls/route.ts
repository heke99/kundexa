import { NextResponse } from "next/server";
import { z } from "zod";
import { getAppContext } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptJson } from "@/lib/crypto";
import { serverEnv } from "@/lib/env";
import { assertPermission } from "@/lib/permissions";
import { RinkelClient } from "@/lib/integrations/rinkel/client";
import { safeRinkelError } from "@/lib/integrations/rinkel/errors";

const bodySchema = z.object({
  customerId: z.uuid(),
  sessionId: z.uuid().nullable().optional(),
  listMemberId: z.uuid().nullable().optional(),
  callbackActivityId: z.uuid().nullable().optional(),
  contactPersonId: z.uuid().nullable().optional(),
  targetPhone: z.string().regex(/^\+[1-9][0-9]{7,14}$/),
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
  connectionId?: string;
  deviceId?: string;
  numberId?: string;
  to?: string;
  status: string;
  idempotentReplay: boolean;
};

type RinkelCredentials = { apiKey: string };

export async function GET(request: Request) {
  try {
    const context = await getAppContext();
    assertPermission(context.role, "calls.read");
    const url = new URL(request.url);
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") ?? 50)));
    const supabase = await createClient();
    let query = supabase.from("calls")
      .select("id,direction,status,end_cause,from_number,to_number,initiated_at,answered_at,ended_at,duration_seconds,disposition,recording_status,transcription_status,insights_status,created_at,customers(display_name)")
      .order("created_at", { ascending: false })
      .limit(limit);
    const status = url.searchParams.get("status");
    const direction = url.searchParams.get("direction");
    if (status) query = query.eq("status", status);
    if (direction) query = query.eq("direction", direction);
    const { data, error } = await query;
    if (error) return NextResponse.json({ error: "calls_query_failed" }, { status: 500 });
    return NextResponse.json({ data: data ?? [] });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "internal_error" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  let reserved: Reservation | null = null;
  let dialSubmitted = false;
  try {
    const context = await getAppContext();
    assertPermission(context.role, "calls.create");
    const parsed = bodySchema.parse(await request.json());
    const supabase = await createClient();
    const result = await supabase.rpc("rinkel_reserve_outbound_call", {
      p_customer_id: parsed.customerId,
      p_contact_person_id: parsed.contactPersonId ?? null,
      p_target_phone: parsed.targetPhone,
      p_session_id: parsed.sessionId ?? null,
      p_list_member_id: parsed.listMemberId ?? null,
      p_callback_activity_id: parsed.callbackActivityId ?? null,
      p_client_request_id: parsed.clientRequestId,
      p_idempotency_key: parsed.idempotencyKey,
      p_purpose: parsed.purpose,
    });
    if (result.error || !result.data) {
      const message = result.error?.message ?? "rinkel_call_reservation_failed";
      const conflict = /active_call|not_allowed|do_not_call|nix|outside_|mapping|feature|claim|callback/i.test(message);
      return NextResponse.json({ error: message }, { status: conflict ? 409 : 400 });
    }
    reserved = result.data as Reservation;
    if (reserved.idempotentReplay) {
      return NextResponse.json({ callId: reserved.callId, status: reserved.status, idempotentReplay: true }, { status: 200 });
    }
    if (!reserved.connectionId || !reserved.deviceId || !reserved.numberId || !reserved.to) {
      throw new Error("rinkel_reservation_contract_invalid");
    }

    const env = serverEnv();
    const admin = createAdminClient();
    const { data: integration } = await admin.from("tenant_integrations")
      .select("credentials_ciphertext")
      .eq("tenant_id", context.tenantId)
      .eq("id", reserved.connectionId)
      .eq("provider", "rinkel")
      .in("status", ["connected", "degraded", "active"])
      .is("disabled_at", null)
      .single();
    if (!integration?.credentials_ciphertext) throw new Error("rinkel_integration_not_active");
    const credentials = decryptJson<RinkelCredentials>(integration.credentials_ciphertext, env.KUNDEXA_ENCRYPTION_KEY);
    await admin.from("call_attempts").update({
      status: "dial_requested",
      provider_request_started_at: new Date().toISOString(),
    }).eq("tenant_id", context.tenantId).eq("id", reserved.attemptId).eq("call_id", reserved.callId);

    const client = new RinkelClient({
      apiKey: credentials.apiKey,
      baseUrl: env.RINKEL_API_BASE_URL,
      timeoutMs: env.RINKEL_REQUEST_TIMEOUT_MS,
      requestId: reserved.attemptId,
    });
    await client.dial({
      deviceId: reserved.deviceId,
      to: reserved.to,
      numberId: reserved.numberId,
      anonymous: false,
    });
    dialSubmitted = true;
    const { error: finalizeError } = await admin.rpc("rinkel_finalize_dial_request", {
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
      message: "Samtalet initieras på din Rinkel-enhet.",
    }, { status: 202 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "validation_error", details: error.issues }, { status: 422 });
    }
    const safe = safeRinkelError(error);
    const outcomeUnknown = safe.outcomeUnknown || dialSubmitted;
    if (reserved) {
      const admin = createAdminClient();
      await admin.rpc("rinkel_finalize_dial_request", {
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
        ? "Rinkels svar är oklart. Försök inte igen; Kundexa inväntar webhook eller avstämning."
        : safe.message,
      callId: reserved?.callId ?? null,
      status: outcomeUnknown ? "provider_outcome_unknown" : "failed",
    }, { status });
  }
}
