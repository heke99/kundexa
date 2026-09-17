import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { serverEnv } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { verifySinchCallback } from "@/lib/telephony/sinch/callback-signature";

export const runtime = "nodejs";

const WEBHOOK_PATH = "/api/webhooks/sinch";
// En samtalshändelse är liten. Ett stort svar är antingen fel avsändare eller
// ett försök att belasta oss, och båda ska avvisas innan de läses in.
const MAX_BODY_BYTES = 64 * 1024;

const HANDLED = new Set(["ace", "dice", "ice", "notify"]);

export async function POST(request: Request) {
  const env = serverEnv();
  const applicationKey = env.SINCH_APPLICATION_KEY?.trim();
  const applicationSecret = env.SINCH_APPLICATION_SECRET?.trim();

  // Utan nycklar går signaturen inte att pröva, och en händelse som inte kan
  // prövas ska inte behandlas. 503 och inte 200: Sinch gör om leveransen, och
  // händelsen är kvar när konfigurationen är på plats.
  if (!applicationKey || !applicationSecret) {
    console.error("sinch_webhook_unconfigured");
    return new NextResponse(null, { status: 503 });
  }

  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  }

  const verification = verifySinchCallback({
    applicationKey,
    applicationSecret,
    authorization: request.headers.get("authorization"),
    timestamp: request.headers.get("x-timestamp"),
    contentType: request.headers.get("content-type"),
    method: "POST",
    path: WEBHOOK_PATH,
    body: raw,
  });
  if (!verification.valid) {
    // Orsaken loggas men lämnas inte ut. En avsändare som får veta exakt varför
    // signaturen inte höll får hjälp att gissa vidare.
    console.warn("sinch_webhook_rejected", { reason: verification.reason });
    return new NextResponse(null, { status: 403 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const event = typeof payload.event === "string" ? payload.event.toLowerCase() : null;
  const externalCallId = typeof payload.callid === "string" ? payload.callid : null;
  if (!event || !externalCallId) {
    return NextResponse.json({ error: "event_or_callid_missing" }, { status: 400 });
  }
  // En händelse vi inte hanterar kvitteras ändå. Att svara med ett fel skulle få
  // Sinch att göra om leveransen i all oändlighet för något vi ändå inte
  // kommer att behandla.
  if (!HANDLED.has(event)) {
    return NextResponse.json({ accepted: true, handled: false }, { status: 200 });
  }

  // Sinch skickar ingen egen händelse-identifierare, så den byggs av det som
  // gör händelsen unik. Kroppens hash finns med för att två händelser av samma
  // typ på samma samtal och samma sekund ska gå att skilja åt.
  const providerEventId = [
    event,
    externalCallId,
    typeof payload.timestamp === "string" ? payload.timestamp : "no-timestamp",
    createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 32),
  ].join(":");

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("ingest_sinch_voice_event", {
    p_event: event,
    p_external_call_id: externalCallId,
    p_provider_event_id: providerEventId,
    p_payload: payload,
    p_received_at: new Date().toISOString(),
  });
  if (error || !data) {
    console.error("sinch_webhook_ingest_failed", { event, code: error?.code ?? "NO_RESULT" });
    return new NextResponse(null, { status: 503 });
  }

  const result = data as Record<string, unknown>;
  return NextResponse.json({
    accepted: true,
    handled: true,
    duplicate: result.duplicate === true,
    matched: result.matched === true,
  }, { status: 200 });
}
