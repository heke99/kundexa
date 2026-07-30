import crypto from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { sha256 } from "@/lib/crypto";
import { serverEnv } from "@/lib/env";
import { isRinkelWebhookEvent, parseRinkelWebhookPayload } from "@/lib/integrations/rinkel/schemas";
import type { RinkelWebhookEvent, RinkelWebhookPayload } from "@/lib/integrations/rinkel/types";

export type RinkelWebhookConnection = {
  id: string;
  tenant_id: string;
  public_id: string;
  webhook_secret_hash: string;
};

function constantTimeHexEqual(left: string, right: string) {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function authenticateRinkelWebhook(connectionPublicId: string, secret: string) {
  const env = serverEnv();
  if (!/^[0-9a-f-]{36}$/i.test(connectionPublicId) || secret.length < 40 || secret.length > 128) return null;
  const admin = createAdminClient();
  const { data } = await admin.from("tenant_integrations")
    .select("id,tenant_id,public_id,webhook_secret_hash")
    .eq("public_id", connectionPublicId)
    .eq("provider", "rinkel")
    .is("disabled_at", null)
    .maybeSingle();
  if (!data?.webhook_secret_hash) return null;
  const supplied = sha256(secret + env.KUNDEXA_WEBHOOK_PEPPER);
  if (!constantTimeHexEqual(supplied, data.webhook_secret_hash)) return null;
  return data as RinkelWebhookConnection;
}

export function trustedRinkelSourceIp(request: Request) {
  const vercel = request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim();
  const real = request.headers.get("x-real-ip")?.trim();
  return vercel || real || null;
}

export async function verifyRinkelNetwork(request: Request) {
  const env = serverEnv();
  if (!env.RINKEL_ENFORCE_WEBHOOK_IP_ALLOWLIST) return { allowed: true, ip: trustedRinkelSourceIp(request) };
  const ip = trustedRinkelSourceIp(request);
  if (!ip) return { allowed: false, ip: null };
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("is_provider_ip_allowed", { p_provider: "rinkel", p_ip: ip });
  return { allowed: !error && data === true, ip };
}

export async function parseRinkelWebhookRequest(
  request: Request,
  eventValue: string,
): Promise<{ event: RinkelWebhookEvent; payload: RinkelWebhookPayload; payloadHash: string; contentType: string }> {
  if (!isRinkelWebhookEvent(eventValue)) throw new Error("unknown_rinkel_event");
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > 256 * 1024) throw new Error("payload_too_large");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > 256 * 1024) throw new Error("payload_too_large");
  const raw = new TextDecoder().decode(bytes);
  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  let input: unknown;
  if (contentType === "application/json") {
    try {
      input = JSON.parse(raw) as unknown;
    } catch {
      throw new Error("invalid_json");
    }
  } else if (contentType === "application/x-www-form-urlencoded") {
    input = Object.fromEntries(new URLSearchParams(raw).entries());
  } else {
    throw new Error("unsupported_content_type");
  }
  return {
    event: eventValue,
    payload: parseRinkelWebhookPayload(eventValue, input),
    payloadHash: sha256(raw),
    contentType,
  };
}
