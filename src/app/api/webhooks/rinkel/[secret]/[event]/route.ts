import { NextResponse } from "next/server";
import { sha256 } from "@/lib/crypto";
import { serverEnv } from "@/lib/env";
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

  const env = serverEnv();
  if (!env.RINKEL_WEBHOOK_SECRET) return new NextResponse(null, { status: 503 });
  const base = env.RINKEL_WEBHOOK_PUBLIC_BASE_URL.replace(/\/+$/, "");
  const targetUrl = `${base}/api/webhooks/rinkel/${env.RINKEL_WEBHOOK_SECRET}/${parsed.event}`;
  const receivedAt = new Date().toISOString();
  const eventAt = "datetime" in parsed.payload ? parsed.payload.datetime : null;
  const externalCallId = parsed.payload.id;
  const providerEventId = [
    parsed.event,
    externalCallId,
    eventAt ?? "insights",
    parsed.payloadHash,
  ].join(":");

  // Rinkel retries or disables webhook delivery when acknowledgement is slow.
  // Keep the public callback to one durable database roundtrip: the RPC stores
  // the idempotent raw event, queues async processing, updates receipt health,
  // and writes the platform audit record atomically before this route returns 200.
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("ingest_platform_rinkel_webhook_event", {
    p_event_type: parsed.event,
    p_external_call_id: externalCallId,
    p_provider_event_id: providerEventId,
    p_payload_hash: parsed.payloadHash,
    p_content_type: parsed.contentType,
    p_source_ip: network.ip,
    p_headers: {
      user_agent: request.headers.get("user-agent")?.slice(0, 200) ?? null,
      request_id: request.headers.get("x-request-id")?.slice(0, 100) ?? null,
    },
    p_payload: parsed.payload,
    p_event_at: eventAt,
    p_target_url_hash: sha256(targetUrl),
    p_target_url_redacted: `${base}/api/webhooks/rinkel/[REDACTED]/${parsed.event}`,
    p_received_at: receivedAt,
  });
  if (error || !data) {
    console.error("rinkel_webhook_ingest_failed", {
      eventType: parsed.event,
      code: error?.code ?? "NO_RESULT",
    });
    return new NextResponse(null, { status: 503 });
  }

  const result = data as Record<string, unknown>;
  return NextResponse.json({
    accepted: true,
    duplicate: result.duplicate === true,
  }, { status: 200 });
}
