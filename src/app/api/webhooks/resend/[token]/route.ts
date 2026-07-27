import { createHmac, timingSafeEqual } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptJson, sha256 } from "@/lib/crypto";
import { serverEnv } from "@/lib/env";
import { isPermanentResendFailure, resendStatusForEvent } from "@/lib/contracts/resend-status";

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
  const { data: event, error: eventError } = await admin.from("provider_webhook_events").upsert({
    tenant_id: integration.tenant_id, provider: "resend", event_type: eventType, provider_event_id: svixId,
    route_key: tokenHash, headers: safeHeaders, payload, status: "received",
  }, { onConflict: "provider,provider_event_id", ignoreDuplicates: true }).select("id,status").maybeSingle();
  if (eventError) return Response.json({ error: "webhook_event_store_failed" }, { status: 500 });
  if (!event) return Response.json({ ok: true, duplicate: true });
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
  const permanent = isPermanentResendFailure(mapped);
  const failureMessage = String(payload.data?.bounce?.message ?? payload.data?.reason ?? eventType).slice(0, 500);
  const emailUpdate: Record<string, unknown> = { status: mapped, provider_status: eventType };
  if (mapped === "sent") emailUpdate.sent_at = occurredAt;
  if (mapped === "delivered") emailUpdate.delivered_at = occurredAt;
  if (mapped === "opened") emailUpdate.opened_at = occurredAt;
  if (mapped === "clicked") emailUpdate.clicked_at = occurredAt;
  if (mapped === "delayed") emailUpdate.delayed_at = occurredAt;
  if (mapped === "bounced") emailUpdate.bounced_at = occurredAt;
  if (mapped === "complained") emailUpdate.complained_at = occurredAt;
  if (mapped === "suppressed") emailUpdate.suppressed_at = occurredAt;
  if (["failed", "bounced", "complained", "suppressed"].includes(mapped)) { emailUpdate.error_message = failureMessage; emailUpdate.failure_code = mapped; }
  await admin.from("email_messages").update(emailUpdate).eq("tenant_id", integration.tenant_id).eq("id", email.id);

  const deliveryUpdate: Record<string, unknown> = { status: mapped, provider_status: eventType };
  if (mapped === "sent") deliveryUpdate.sent_at = occurredAt;
  if (mapped === "delivered") deliveryUpdate.delivered_at = occurredAt;
  if (mapped === "opened") deliveryUpdate.opened_at = occurredAt;
  if (mapped === "clicked") deliveryUpdate.clicked_at = occurredAt;
  if (mapped === "delayed") deliveryUpdate.delayed_at = occurredAt;
  if (mapped === "bounced") deliveryUpdate.bounced_at = occurredAt;
  if (mapped === "complained") deliveryUpdate.complained_at = occurredAt;
  if (mapped === "suppressed") deliveryUpdate.suppressed_at = occurredAt;
  if (["failed", "bounced", "complained", "suppressed"].includes(mapped)) { deliveryUpdate.failure_code = mapped; deliveryUpdate.failure_message = failureMessage; }
  await admin.from("contract_deliveries").update(deliveryUpdate).eq("tenant_id", integration.tenant_id).eq("email_message_id", email.id);

  if (email.contract_id) {
    await admin.from("contract_events").insert({
      tenant_id: integration.tenant_id, contract_id: email.contract_id, event_type: eventType,
      payload: { provider_message_id: providerEmailId, provider_event_id: svixId, email_message_id: email.id, status: mapped, occurred_at: occurredAt },
    });
    if (mapped === "delivered") await admin.from("contracts").update({ status: "delivered" }).eq("tenant_id", integration.tenant_id).eq("id", email.contract_id).eq("status", "sent");
    if (["opened", "clicked"].includes(mapped)) await admin.from("contracts").update({ status: "opened" }).eq("tenant_id", integration.tenant_id).eq("id", email.contract_id).in("status", ["sent", "delivered"]);
    if (permanent) {
      const { data: activeRequests } = await admin.from("contract_acceptance_requests")
        .select("id")
        .eq("tenant_id", integration.tenant_id)
        .eq("contract_id", email.contract_id)
        .eq("status", "pending");
      for (const requestRow of activeRequests ?? []) {
        await admin.rpc("cancel_contract_reminders", {
          p_tenant_id: integration.tenant_id,
          p_acceptance_request_id: requestRow.id,
          p_reason: mapped,
        });
      }
    }
  }
  if (email.customer_id && ["complained", "suppressed"].includes(mapped)) {
    await admin.from("customers").update({ do_not_email: true, blocked_reason: `Resend ${mapped}` }).eq("tenant_id", integration.tenant_id).eq("id", email.customer_id);
  }
  await admin.from("provider_webhook_events").update({ status: "processed", processed_at: new Date().toISOString(), attempts: 1 }).eq("id", event.id);
  return Response.json({ ok: true });
}
