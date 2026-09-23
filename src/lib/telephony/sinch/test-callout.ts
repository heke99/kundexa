import "server-only";
import { serverEnv } from "@/lib/env";

/**
 * Ett testsamtal direkt från Sinch, utan webbläsaren.
 *
 * Exakt det Sinch egen getting-started beskriver: `ttsCallout` från ett nummer
 * tilldelat appen till ett verifierat nummer, som läser upp en mening. Ringer
 * det är kontot och numren i ordning och ett fel sitter i webbläsarvägen;
 * ringer det inte svarar Sinch här med en felorsak, i stället för den
 * intetsägande GENERALERROR som webbläsarvägen ger.
 *
 * Källa: developers.sinch.com/docs/voice/getting-started (hämtad 2026-09-23).
 */
export type SinchTestCalloutResult =
  | { ok: true; callId: string }
  | { ok: false; status: number; message: string };

export async function placeSinchTestCallout(input: { cli: string; destination: string }): Promise<SinchTestCalloutResult> {
  const env = serverEnv();
  const key = env.SINCH_APPLICATION_KEY?.trim();
  const secret = env.SINCH_APPLICATION_SECRET?.trim();
  if (!key || !secret) return { ok: false, status: 0, message: "Telefonitjänstens nycklar saknas på servern." };
  try {
    const response = await fetch("https://calling.api.sinch.com/calling/v1/callouts", {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString("base64")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        method: "ttsCallout",
        ttsCallout: {
          cli: input.cli,
          destination: { type: "number", endpoint: input.destination },
          locale: "en-US",
          text: "This is a test call from Kundexa.",
        },
      }),
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
    const text = await response.text().catch(() => "");
    if (response.ok) {
      const callId = (() => { try { return String((JSON.parse(text) as { callId?: unknown }).callId ?? ""); } catch { return ""; } })();
      return { ok: true, callId };
    }
    return { ok: false, status: response.status, message: text.replace(/\s+/g, " ").slice(0, 300) || response.statusText };
  } catch (error) {
    return { ok: false, status: 0, message: error instanceof Error ? error.message.slice(0, 200) : "network_error" };
  }
}
