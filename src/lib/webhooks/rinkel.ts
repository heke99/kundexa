import crypto from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { sha256 } from "@/lib/crypto";
import { serverEnv } from "@/lib/env";
import { isRinkelWebhookEvent, parseRinkelWebhookPayload } from "@/lib/integrations/rinkel/schemas";
import type { RinkelWebhookEvent, RinkelWebhookPayload } from "@/lib/integrations/rinkel/types";

export function authenticatePlatformRinkelWebhook(secret: string) {
  const env = serverEnv();
  if (!env.RINKEL_WEBHOOK_SECRET || secret.length < 40 || secret.length > 128) return false;
  const supplied = Buffer.from(secret);
  const expected = Buffer.from(env.RINKEL_WEBHOOK_SECRET);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

export function trustedRinkelSourceIp(request: Request) {
  const env = serverEnv();
  if (process.env.VERCEL === "1") {
    return request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() || null;
  }
  if (env.RINKEL_TRUST_X_REAL_IP) {
    return request.headers.get("x-real-ip")?.trim() || null;
  }
  return null;
}

export async function verifyRinkelNetwork(request: Request) {
  const env = serverEnv();
  if (!env.RINKEL_ENFORCE_WEBHOOK_IP_ALLOWLIST) return { allowed: true, ip: trustedRinkelSourceIp(request) };
  const ip = trustedRinkelSourceIp(request);
  if (!ip) return { allowed: false, ip: null };
  if (env.RINKEL_WEBHOOK_ALLOWED_IPS.includes(ip)) return { allowed: true, ip };
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
