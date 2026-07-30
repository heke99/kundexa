import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  authenticatePlatformRinkelWebhook,
  parseRinkelWebhookRequest,
  verifyRinkelNetwork,
} from "@/lib/webhooks/rinkel";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ secret: string; event: string }> },
) {
  const params = await context.params;
  if (!authenticatePlatformRinkelWebhook(params.secret)) return new NextResponse(null, { status: 403 });
  const network = await verifyRinkelNetwork(request);
  if (!network.allowed) return new NextResponse(null, { status: 403 });
  let parsed: Awaited<ReturnType<typeof parseRinkelWebhookRequest>>;
  try {
    parsed = await parseRinkelWebhookRequest(request, params.event);
  } catch (error) {
    const code = error instanceof Error ? error.message : "invalid_payload";
    return NextResponse.json({ error: code }, {
      status: code === "payload_too_large" ? 413 : code === "unsupported_content_type" ? 415 : 400,
    });
  }

  const admin = createAdminClient();
  const { data: integration, error: integrationError } = await admin.from("platform_integrations")
    .select("id")
    .eq("provider", "rinkel")
    .is("disabled_at", null)
    .limit(1)
    .maybeSingle();
  if (integrationError || !integration) return new NextResponse(null, { status: 503 });

  const externalCallId = parsed.payload.id;
  const eventAt = "datetime" in parsed.payload ? parsed.payload.datetime : null;
  const providerEventId = [
    parsed.event,
    externalCallId,
    eventAt ?? "insights",
    parsed.payloadHash,
  ].join(":");
  const { data: event, error } = await admin.from("platform_rinkel_webhook_events").upsert({
    platform_integration_id: integration.id,
    event_type: parsed.event,
    external_call_id: externalCallId,
    provider_event_id: providerEventId,
    payload_hash: parsed.payloadHash,
    content_type: parsed.contentType,
    source_ip: network.ip,
    headers: {
      user_agent: request.headers.get("user-agent")?.slice(0, 200) ?? null,
      request_id: request.headers.get("x-request-id")?.slice(0, 100) ?? null,
    },
    payload: parsed.payload,
    event_at: eventAt,
    status: "received",
  }, { onConflict: "provider_event_id", ignoreDuplicates: true }).select("id").maybeSingle();
  if (error) return new NextResponse(null, { status: 503 });

  let eventId = event?.id ?? null;
  if (!eventId) {
    const { data: existing } = await admin.from("platform_rinkel_webhook_events")
      .select("id").eq("provider_event_id", providerEventId).maybeSingle();
    eventId = existing?.id ?? null;
  }
  if (!eventId) return new NextResponse(null, { status: 503 });
  const { error: queueError } = await admin.from("platform_rinkel_jobs").upsert({
    job_type: "rinkel.process_event",
    aggregate_id: eventId,
    idempotency_key: `rinkel.process_event:${eventId}`,
    payload: { event_id: eventId },
  }, { onConflict: "idempotency_key", ignoreDuplicates: true });
  if (queueError) return new NextResponse(null, { status: 503 });
  await Promise.all([
    admin.from("platform_integrations").update({
      webhook_status: "active",
      webhook_last_received_at: new Date().toISOString(),
    }).eq("id", integration.id),
    admin.from("platform_rinkel_webhook_subscriptions").update({
      status: "active",
      last_received_at: new Date().toISOString(),
      last_error: null,
    }).eq("platform_integration_id", integration.id).eq("event_type", parsed.event),
  ]);
  return NextResponse.json({ accepted: true }, { status: 200 });
}
