import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  authenticateRinkelWebhook,
  parseRinkelWebhookRequest,
  verifyRinkelNetwork,
} from "@/lib/webhooks/rinkel";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ connection: string; secret: string; event: string }> },
) {
  const network = await verifyRinkelNetwork(request);
  if (!network.allowed) return new NextResponse(null, { status: 403 });
  const params = await context.params;
  const connection = await authenticateRinkelWebhook(params.connection, params.secret);
  if (!connection) return new NextResponse(null, { status: 403 });

  let parsed: Awaited<ReturnType<typeof parseRinkelWebhookRequest>>;
  try {
    parsed = await parseRinkelWebhookRequest(request, params.event);
  } catch (error) {
    const code = error instanceof Error ? error.message : "invalid_payload";
    const status = code === "payload_too_large" ? 413
      : code === "unsupported_content_type" ? 415
        : 400;
    return NextResponse.json({ error: code }, { status });
  }

  const admin = createAdminClient();
  const providerEventId = [
    connection.id,
    parsed.event,
    parsed.payload.id,
    "datetime" in parsed.payload ? parsed.payload.datetime : "insights",
    parsed.payloadHash,
  ].join(":");
  const { data: created, error } = await admin.from("provider_webhook_events").upsert({
    tenant_id: connection.tenant_id,
    connection_id: connection.id,
    provider: "rinkel",
    event_type: parsed.event,
    provider_event_id: providerEventId,
    route_key: connection.public_id,
    headers: {},
    payload: parsed.payload,
    payload_hash: parsed.payloadHash,
    content_type: parsed.contentType,
    source_ip: network.ip,
    status: "received",
  }, { onConflict: "provider,provider_event_id", ignoreDuplicates: true }).select("id").maybeSingle();
  if (error) return new NextResponse(null, { status: 503 });
  let eventId = created?.id ?? null;
  if (!eventId) {
    const { data: existing } = await admin.from("provider_webhook_events")
      .select("id")
      .eq("provider", "rinkel")
      .eq("provider_event_id", providerEventId)
      .maybeSingle();
    eventId = existing?.id ?? null;
  }
  if (!eventId) return new NextResponse(null, { status: 503 });

  const { error: queueError } = await admin.from("outbox_jobs").upsert({
    tenant_id: connection.tenant_id,
    job_type: "rinkel.process_event",
    aggregate_type: "provider_webhook_event",
    aggregate_id: eventId,
    payload: { event_id: eventId, connection_id: connection.id },
    idempotency_key: `rinkel.process_event:${eventId}`,
    priority: 5,
  }, { onConflict: "tenant_id,idempotency_key", ignoreDuplicates: true });
  if (queueError) return new NextResponse(null, { status: 503 });
  await admin.from("tenant_integrations").update({
    webhook_status: "active",
    webhook_last_received_at: new Date().toISOString(),
  }).eq("tenant_id", connection.tenant_id).eq("id", connection.id);
  return NextResponse.json({ accepted: true }, { status: 200 });
}
