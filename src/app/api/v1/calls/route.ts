import { NextResponse } from "next/server";
import { z } from "zod";
import { getAppContext } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { randomToken, sha256 } from "@/lib/crypto";
import { serverEnv } from "@/lib/env";
import { assertPermission } from "@/lib/permissions";

const bodySchema = z.object({
  customerId: z.uuid(),
  sessionId: z.uuid().optional(),
  listMemberId: z.uuid().optional(),
  callbackActivityId: z.uuid().nullable().optional(),
  contactPersonId: z.uuid().nullable().optional(),
  targetPhone: z.string().regex(/^\+[1-9][0-9]{7,14}$/).optional(),
  idempotencyKey: z.string().min(8).max(200).optional(),
  purpose: z.enum(["direct_marketing", "customer_service", "contract_followup"]).default("direct_marketing"),
}).superRefine((value, context) => {
  if (Boolean(value.sessionId) !== Boolean(value.listMemberId)) context.addIssue({ code: "custom", message: "sessionId och listMemberId måste anges tillsammans" });
  if (value.contactPersonId && !value.targetPhone) context.addIssue({ code: "custom", message: "targetPhone krävs när contactPersonId anges" });
});

export async function POST(request: Request) {
  try {
    const ctx = await getAppContext();
    assertPermission(ctx.role, "calls.create");
    const parsed = bodySchema.parse(await request.json());
    const supabase = await createClient();
    const { data: voiceClient } = await supabase.from("voice_clients").select("client_number_e164")
      .eq("assigned_user_id", ctx.userId).eq("status", "active").maybeSingle();
    if (!voiceClient?.client_number_e164) return NextResponse.json({ error: "voice_client_not_configured" }, { status: 409 });

    const callbackToken = randomToken();
    const env = serverEnv();
    const common = {
      p_callback_token_hash: sha256(callbackToken + env.KUNDEXA_WEBHOOK_PEPPER),
      p_callback_token: callbackToken,
      p_voice_client_number: voiceClient.client_number_e164,
      p_idempotency_key: parsed.idempotencyKey || request.headers.get("idempotency-key") || `api.call:${crypto.randomUUID()}`,
      p_purpose: parsed.purpose,
    };
    const hasExplicitTarget = Boolean(parsed.targetPhone);
    const result = parsed.sessionId && parsed.listMemberId
      ? hasExplicitTarget
        ? await supabase.rpc("queue_list_outbound_call_target", {
            ...common,
            p_session_id: parsed.sessionId,
            p_list_member_id: parsed.listMemberId,
            p_callback_activity_id: parsed.callbackActivityId ?? null,
            p_contact_person_id: parsed.contactPersonId ?? null,
            p_target_phone: parsed.targetPhone!,
          })
        : await supabase.rpc("queue_list_outbound_call", {
            ...common,
            p_session_id: parsed.sessionId,
            p_list_member_id: parsed.listMemberId,
            p_callback_activity_id: parsed.callbackActivityId ?? null,
          })
      : parsed.callbackActivityId
        ? await supabase.rpc("queue_callback_outbound_call", {
            ...common,
            p_activity_id: parsed.callbackActivityId,
            p_customer_id: parsed.customerId,
          })
        : hasExplicitTarget
          ? await supabase.rpc("queue_outbound_call_target", {
              ...common,
              p_customer_id: parsed.customerId,
              p_contact_person_id: parsed.contactPersonId ?? null,
              p_target_phone: parsed.targetPhone!,
            })
          : await supabase.rpc("queue_outbound_call", { ...common, p_customer_id: parsed.customerId });
    const { data: callId, error } = result;
    if (error) {
      const conflict = /contact_not_allowed|usage_hard_limit|feature_disabled|nix|target_phone|contact_person/i.test(error.message);
      return NextResponse.json({ error: error.message }, { status: conflict ? 409 : 400 });
    }
    return NextResponse.json({ callId, status: "queued" }, { status: 202 });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "validation_error", details: error.issues }, { status: 422 });
    return NextResponse.json({ error: error instanceof Error ? error.message : "internal_error" }, { status: 500 });
  }
}
