import "server-only";
import { randomUUID } from "node:crypto";
import { serverEnv } from "@/lib/env";
import { mintSinchRegistrationToken, SINCH_MIN_TOKEN_TTL_SECONDS } from "./registration-token";

/**
 * Går webbtelefonen att registrera hos Sinch?
 *
 * Webbläsarens SDK gör registreringen själv och sväljer orsaken när den
 * misslyckas: `DefaultSinchClient.start` fångar felet, skriver det i konsolen
 * och rapporterar bara "Unable to create instance!". Resultatet var nio
 * sessioner som aldrig registrerades och ingen enda rad som sa varför.
 *
 * Servern gör här samma begäran som SDK:t (`POST /ocra/v2/applications/{key}/instances`,
 * med samma JWT, samma kroppsfält och samma förmågor) och läser svaret.
 * Varken token eller hemlighet lämnar funktionen: svaret är status och
 * leverantörens felmeddelande, avkortat.
 *
 * Begäran och kroppen är avlästa ur `sinch-rtc` 2.48.11
 * (`instance/InstanceController.register`, `ocra/api/apis/InstanceApi`).
 */
export type SinchRegistrationProbe =
  | { state: "not_configured" }
  | { state: "ok"; status: number; checkedAt: string }
  | { state: "rejected"; status: number; message: string; checkedAt: string }
  | { state: "unreachable"; message: string; checkedAt: string };

const PROBE_USER = "kundexa-health-probe";

export async function probeSinchRegistration(): Promise<SinchRegistrationProbe> {
  const env = serverEnv();
  const applicationKey = env.SINCH_APPLICATION_KEY?.trim();
  const applicationSecret = env.SINCH_APPLICATION_SECRET?.trim();
  if (!applicationKey || !applicationSecret) return { state: "not_configured" };
  const checkedAt = new Date().toISOString();

  let token: string;
  try {
    token = mintSinchRegistrationToken({
      applicationKey, applicationSecret, userId: PROBE_USER,
      ttlSeconds: SINCH_MIN_TOKEN_TTL_SECONDS * 2,
    }).token;
  } catch (error) {
    return { state: "rejected", status: 0, message: error instanceof Error ? error.message : "token_failed", checkedAt };
  }

  const host = env.SINCH_RTC_ENVIRONMENT_HOST.replace(/\/+$/, "");
  const base = /^https?:\/\//.test(host) ? host : `https://${host}`;
  try {
    const response = await fetch(`${base}/ocra/v2/applications/${encodeURIComponent(applicationKey)}/instances`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: PROBE_USER,
        deviceId: randomUUID(),
        capabilities: ["p2p", "ice-proxy.1", "ocra.1"],
        version: { platform: "js", os: "server", application: "kundexa-health-probe", deviceModelId: "server", deviceModelName: "server" },
      }),
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    if (response.ok) return { state: "ok", status: response.status, checkedAt };
    const text = (await response.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 300);
    return { state: "rejected", status: response.status, message: text || response.statusText, checkedAt };
  } catch (error) {
    return { state: "unreachable", message: error instanceof Error ? error.message.slice(0, 200) : "network_error", checkedAt };
  }
}
