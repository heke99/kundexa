import { NextResponse } from "next/server";
import { z } from "zod";
import { getAppContext } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { randomToken, sha256 } from "@/lib/crypto";
import { serverEnv } from "@/lib/env";
import { assertPermission } from "@/lib/permissions";

const bodySchema = z.object({
  customerId: z.uuid(),
  idempotencyKey: z.string().min(8).max(200).optional(),
  purpose: z.enum(["direct_marketing", "customer_service", "contract_followup"]).default("direct_marketing"),
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
    const { data: callId, error } = await supabase.rpc("queue_outbound_call", {
      p_customer_id: parsed.customerId,
      p_callback_token_hash: sha256(callbackToken + env.KUNDEXA_WEBHOOK_PEPPER),
      p_callback_token: callbackToken,
      p_voice_client_number: voiceClient.client_number_e164,
      p_idempotency_key: parsed.idempotencyKey || request.headers.get("idempotency-key") || `api.call:${crypto.randomUUID()}`,
      p_purpose: parsed.purpose,
    });
    if (error) {
      const conflict = /contact_not_allowed|usage_hard_limit|feature_disabled|nix/i.test(error.message);
      return NextResponse.json({ error: error.message }, { status: conflict ? 409 : 400 });
    }
    return NextResponse.json({ callId, status: "queued" }, { status: 202 });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "validation_error", details: error.issues }, { status: 422 });
    return NextResponse.json({ error: error instanceof Error ? error.message : "internal_error" }, { status: 500 });
  }
}
