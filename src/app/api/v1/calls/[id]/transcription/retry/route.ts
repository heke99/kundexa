import { NextResponse } from "next/server";
import { getAppContext } from "@/lib/auth";
import { assertPermission } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const app = await getAppContext();
  assertPermission(app.role, "calls.read");
  const { id: callId } = await context.params;
  const supabase = await createClient();
  const { data: call } = await supabase.from("calls")
    .select("id,provider_connection_id,external_call_id")
    .eq("id", callId)
    .eq("provider", "rinkel")
    .single();
  if (!call?.provider_connection_id || !call.external_call_id) {
    return NextResponse.json({ error: "rinkel_call_not_enrichable" }, { status: 409 });
  }
  const admin = createAdminClient();
  await admin.from("call_transcripts").update({
    status: "pending",
    next_retry_at: new Date().toISOString(),
  }).eq("tenant_id", app.tenantId).eq("call_id", callId).eq("provider", "rinkel");
  const { error } = await admin.from("outbox_jobs").upsert({
    tenant_id: app.tenantId,
    job_type: "rinkel.enrich_call",
    aggregate_type: "call",
    aggregate_id: callId,
    payload: {
      call_id: callId,
      connection_id: call.provider_connection_id,
      external_call_id: call.external_call_id,
    },
    idempotency_key: `rinkel.enrich_call.retry:${callId}:${new Date().toISOString().slice(0, 13)}`,
    priority: 10,
  }, { onConflict: "tenant_id,idempotency_key", ignoreDuplicates: true });
  if (error) return NextResponse.json({ error: "transcription_retry_queue_failed" }, { status: 500 });
  await admin.from("audit_logs").insert({
    tenant_id: app.tenantId,
    actor_user_id: app.userId,
    action: "rinkel.transcription_retry_queued",
    entity_type: "call",
    entity_id: callId,
  });
  return NextResponse.json({ status: "pending" }, { status: 202 });
}
