import { z } from "zod";
import { getAppContext } from "@/lib/auth";
import { assertPermission } from "@/lib/permissions";
import { createAdminClient } from "@/lib/supabase/admin";
import { apiJson, getCorrelationId } from "@/lib/api-correlation";

const schema = z.object({ callId: z.uuid(), attemptId: z.uuid(), webphoneSessionId: z.uuid() });
/** Persist intent before the SDK side effect. An ambiguous response deliberately
 * cannot be replayed as permission to dial again. Reconciliation owns recovery. */
export async function POST(request: Request) {
  const correlationId = getCorrelationId(request);
  try {
    const context = await getAppContext();
    assertPermission(context.role, "calls.create");
    const input = schema.parse(await request.json());
    const admin = createAdminClient();
    const { data: session, error: sessionError } = await admin.from("webphone_sessions").select("id")
      .eq("tenant_id", context.tenantId).eq("seller_user_id", context.userId)
      .eq("id", input.webphoneSessionId).in("status", ["registering", "registered"]).maybeSingle();
    if (sessionError || !session) return apiJson(correlationId, { sdkStartAllowed: false, error: "webphone_session_not_active" }, { status: 409 });
    const { data, error } = await admin.from("dial_attempts").update({ status: "dial_requested", provider_request_started_at: new Date().toISOString() })
      .eq("tenant_id", context.tenantId).eq("seller_user_id", context.userId).eq("id", input.attemptId)
      .eq("call_id", input.callId).eq("webphone_session_id", session.id).eq("status", "requested")
      .is("provider_request_started_at", null).is("external_call_id", null)
      .gt("expires_at", new Date().toISOString()).select("id").maybeSingle();
    if (error) return apiJson(correlationId, { sdkStartAllowed: false, error: "dial_start_claim_unavailable" }, { status: 503 });
    return apiJson(correlationId, { sdkStartAllowed: Boolean(data), callId: input.callId, attemptId: input.attemptId }, { status: data ? 200 : 409 });
  } catch (error) {
    return apiJson(correlationId, { sdkStartAllowed: false, error: error instanceof z.ZodError ? "validation_error" : "dial_start_claim_failed" }, { status: error instanceof z.ZodError ? 422 : 403 });
  }
}
