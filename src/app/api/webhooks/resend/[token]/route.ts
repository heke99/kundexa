import { createHmac, timingSafeEqual } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptJson, sha256 } from "@/lib/crypto";
import { serverEnv } from "@/lib/env";
import { resendStatusForEvent } from "@/lib/contracts/resend-status";
import { toJson } from "@/lib/supabase/json";

type ResendCredentials = { webhookSigningSecret?: string };
type ResendPayload = { type?: string; created_at?: string; data?: { email_id?: string; id?: string; to?: string[]; bounce?: { message?: string }; reason?: string } };

function verifySvix(rawBody: string, id: string, timestamp: string, signatureHeader: string, secret: string) {
  const time = Number(timestamp);
  if (!Number.isFinite(time) || Math.abs(Date.now() / 1000 - time) > 300) return false;
  const encodedSecret = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  let key: Buffer;
  try { key = Buffer.from(encodedSecret, "base64"); } catch { return false; }
  if (!key.length) return false;
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest();
  const candidates = signatureHeader.split(/\s+/).flatMap((part) => {
    const [version, value] = part.split(",", 2);
    return version === "v1" && value ? [value] : [];
  });
  return candidates.some((candidate) => {
    try { const actual = Buffer.from(candidate, "base64"); return actual.length === expected.length && timingSafeEqual(actual, expected); } catch { return false; }
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const rawBody = await request.text();
  const svixId = request.headers.get("svix-id") ?? "";
  const svixTimestamp = request.headers.get("svix-timestamp") ?? "";
  const svixSignature = request.headers.get("svix-signature") ?? "";
  if (!token || !svixId || !svixTimestamp || !svixSignature) return Response.json({ error: "missing_webhook_signature" }, { status: 400 });

  const env = serverEnv();
  const admin = createAdminClient();
  const tokenHash = sha256(token + env.KUNDEXA_WEBHOOK_PEPPER);
  const { data: integration } = await admin.from("tenant_integrations")
    .select("id,tenant_id,status,credentials_ciphertext,configuration")
    .eq("provider_type", "email").eq("provider", "resend")
    .contains("configuration", { webhook_path_token_hash: tokenHash }).limit(1).maybeSingle();
  if (!integration?.credentials_ciphertext || integration.status === "revoked") return Response.json({ error: "webhook_not_found" }, { status: 404 });
  let credentials: ResendCredentials;
  try { credentials = decryptJson<ResendCredentials>(integration.credentials_ciphertext, env.KUNDEXA_ENCRYPTION_KEY); }
  catch { return Response.json({ error: "webhook_configuration_invalid" }, { status: 500 }); }
  if (!credentials.webhookSigningSecret || !verifySvix(rawBody, svixId, svixTimestamp, svixSignature, credentials.webhookSigningSecret)) {
    return Response.json({ error: "invalid_webhook_signature" }, { status: 401 });
  }

  let payload: ResendPayload;
  try { payload = JSON.parse(rawBody) as ResendPayload; } catch { return Response.json({ error: "invalid_json" }, { status: 400 }); }
  const eventType = String(payload.type ?? "unknown");
  const providerEmailId = String(payload.data?.email_id ?? payload.data?.id ?? "");
  const safeHeaders = { "svix-id": svixId, "svix-timestamp": svixTimestamp, "svix-signature-present": true };
  const { data: insertedEvent, error: eventError } = await admin.from("provider_webhook_events").upsert({
    tenant_id: integration.tenant_id, provider: "resend", event_type: eventType, provider_event_id: svixId,
    route_key: tokenHash, headers: toJson(safeHeaders), payload: toJson(payload), status: "received",
  }, { onConflict: "provider,provider_event_id", ignoreDuplicates: true }).select("id,status").maybeSingle();
  if (eventError) return Response.json({ error: "webhook_event_store_failed" }, { status: 500 });

  let event = insertedEvent;
  if (!event) {
    const { data: existingEvent, error: existingEventError } = await admin.from("provider_webhook_events")
      .select("id,status")
      .eq("tenant_id", integration.tenant_id)
      .eq("provider", "resend")
      .eq("provider_event_id", svixId)
      .maybeSingle();
    if (existingEventError || !existingEvent) return Response.json({ error: "webhook_event_replay_lookup_failed" }, { status: 500 });
    if (["processed", "ignored"].includes(existingEvent.status)) return Response.json({ ok: true, duplicate: true });
    event = existingEvent;
    await admin.from("provider_webhook_events").update({
      status: "received", processed_at: null, last_error: null, payload: toJson(payload), headers: toJson(safeHeaders),
    }).eq("id", event.id);
  }

  const mapped = resendStatusForEvent(eventType);
  if (!mapped || !providerEmailId) {
    await admin.from("provider_webhook_events").update({ status: "ignored", processed_at: new Date().toISOString() }).eq("id", event.id);
    return Response.json({ ok: true, ignored: true });
  }

  const { data: email } = await admin.from("email_messages")
    .select("id,tenant_id,contract_id,customer_id,status")
    .eq("tenant_id", integration.tenant_id).eq("provider_message_id", providerEmailId).maybeSingle();
  if (!email) {
    await admin.from("provider_webhook_events").update({ status: "unmatched", processed_at: new Date().toISOString(), last_error: "email_message_not_found" }).eq("id", event.id);
    return Response.json({ ok: true, unmatched: true });
  }

  const occurredAt = payload.created_at && Number.isFinite(new Date(payload.created_at).getTime()) ? payload.created_at : new Date().toISOString();
  const failureMessage = String(payload.data?.bounce?.message ?? payload.data?.reason ?? eventType).slice(0, 500);
  const projection = await admin.rpc("apply_resend_delivery_event", {
    p_tenant_id: integration.tenant_id,
    p_email_message_id: email.id,
    p_provider_event_id: svixId,
    p_provider_event_type: eventType,
    p_status: mapped,
    p_occurred_at: occurredAt,
    p_payload: toJson(payload),
    p_failure_message: failureMessage,
  });
  if (projection.error) {
    await admin.from("provider_webhook_events").update({
      status: "failed",
      processed_at: new Date().toISOString(),
      attempts: 1,
      last_error: projection.error.message.slice(0, 500),
    }).eq("id", event.id);
    return Response.json({ error: "delivery_projection_failed" }, { status: 500 });
  }
  const projectionResult = projection.data && typeof projection.data === "object" && !Array.isArray(projection.data)
    ? projection.data as Record<string, unknown>
    : {};
  const applied = projectionResult.applied === true;
  return Response.json({ ok: true, applied, projectionReason: projectionResult.reason ?? null });
}
