import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { serverEnv } from "@/lib/env";
import { sha256 } from "@/lib/crypto";
import { formToObject, verify46ElksNetwork } from "@/lib/webhooks/46elks";

export async function POST(request: Request) {
  if (!await verify46ElksNetwork(request)) return new NextResponse(null, { status: 403 });
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const payload = formToObject(await request.formData());
  const admin = createAdminClient();
  const { data: call } = await admin.from("calls").select("id,tenant_id").eq("callback_token_hash", sha256(token + serverEnv().KUNDEXA_WEBHOOK_PEPPER)).maybeSingle();
  if (!call) return new NextResponse(null, { status: 403 });
  const providerRecordingId = payload.id ?? `${payload.callid ?? call.id}:${payload.created ?? "recording"}`;
  await admin.from("outbox_jobs").upsert({
    tenant_id: call.tenant_id,
    job_type: "recording.download",
    aggregate_type: "call",
    aggregate_id: call.id,
    payload: { call_id: call.id, wav_url: payload.wav, provider_recording_id: providerRecordingId, duration: payload.duration },
    idempotency_key: `recording.download:${providerRecordingId}`,
    priority: 10,
  }, { onConflict: "tenant_id,idempotency_key", ignoreDuplicates: true });
  return new NextResponse(null, { status: 204 });
}
