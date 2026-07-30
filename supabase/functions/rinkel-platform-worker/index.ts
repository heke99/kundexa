import { createClient } from "npm:@supabase/supabase-js@2.110.7";
import { mapRinkelCause, RinkelClient } from "../_shared/rinkel.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const cronSecret = Deno.env.get("CRON_SECRET")!;
const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

type Json = Record<string, unknown>;
type Job = {
  id: string;
  job_type: string;
  aggregate_id: string | null;
  payload: Json;
  attempts: number;
  max_attempts: number;
};
type EventRow = {
  id: string;
  platform_integration_id: string;
  tenant_id: string | null;
  event_type: string;
  external_call_id: string;
  payload: Json;
  event_at: string | null;
  received_at: string;
  status: string;
};

function text(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

async function createConflict(event: EventRow, type: string, tenants: string[], details: Json) {
  await supabase.from("platform_rinkel_conflicts").upsert({
    conflict_type: type,
    provider_resource_type: "call",
    provider_resource_key: event.external_call_id,
    claimed_tenant_ids: [...new Set(tenants)],
    event_id: event.id,
    details: { ...details, event_type: event.event_type },
    status: "open",
  }, { onConflict: "conflict_type,provider_resource_key", ignoreDuplicates: true });
  await supabase.from("platform_rinkel_webhook_events").update({
    status: "conflict",
    tenant_id: null,
    last_error: type,
    processed_at: new Date().toISOString(),
  }).eq("id", event.id);
}

async function resolveIncomingTenant(event: EventRow) {
  const to = text(event.payload.to);
  if (!to) return null;
  const { data: number } = await supabase.from("platform_rinkel_numbers")
    .select("id").eq("phone_number_e164", to).eq("active", true).maybeSingle();
  if (!number) return null;
  const at = event.event_at ?? event.received_at;
  const { data: allocations } = await supabase.from("rinkel_number_allocations")
    .select("id,tenant_id")
    .eq("rinkel_number_id", number.id)
    .lte("valid_from", at)
    .or(`valid_to.is.null,valid_to.gt.${at}`)
    .eq("status", "active");
  if ((allocations ?? []).length !== 1) {
    await createConflict(event, "RINKEL_INCOMING_ALLOCATION_CONFLICT", (allocations ?? []).map((item) => item.tenant_id), {
      to_suffix: to.slice(-4),
      candidate_count: allocations?.length ?? 0,
    });
    return null;
  }
  return { tenantId: allocations![0].tenant_id, allocationId: allocations![0].id, numberId: number.id };
}

async function resolveOutgoingAttempt(event: EventRow) {
  const to = text(event.payload.to);
  const from = text(event.payload.from);
  const userId = text(event.payload.userId);
  if (!to || !userId) return null;
  const at = new Date(event.event_at ?? event.received_at).getTime();
  const fromTime = new Date(at - 10 * 60_000).toISOString();
  const toTime = new Date(at + 10 * 60_000).toISOString();
  let query = supabase.from("rinkel_call_attempts_v2")
    .select("id,tenant_id,call_id")
    .eq("external_rinkel_user_id", userId)
    .eq("destination_number_e164", to)
    .gte("requested_at", fromTime)
    .lte("requested_at", toTime)
    .in("status", ["requested", "dial_requested", "awaiting_provider_event", "provider_outcome_unknown"]);
  if (from && from !== "anonymous") query = query.eq("source_number_e164", from);
  const { data: attempts } = await query;
  if ((attempts ?? []).length !== 1) {
    await createConflict(event, "RINKEL_OUTGOING_CORRELATION_CONFLICT", (attempts ?? []).map((item) => item.tenant_id), {
      candidate_attempt_ids: (attempts ?? []).map((item) => item.id),
    });
    return null;
  }
  return attempts![0];
}

async function ensureCallForStartOrEnd(event: EventRow) {
  const { data: calls } = await supabase.from("calls")
    .select("id,tenant_id").eq("provider", "rinkel").eq("external_call_id", event.external_call_id).limit(2);
  if ((calls ?? []).length === 1) return calls![0];
  if ((calls ?? []).length > 1) {
    await createConflict(event, "RINKEL_EXTERNAL_CALL_DUPLICATE", calls!.map((item) => item.tenant_id), {});
  }
  return null;
}

async function processIncoming(event: EventRow) {
  const resolved = await resolveIncomingTenant(event);
  if (!resolved) return;
  const from = text(event.payload.from) ?? "anonymous";
  const to = text(event.payload.to)!;
  const { data: existing } = await supabase.from("calls")
    .select("id").eq("provider", "rinkel").eq("tenant_id", resolved.tenantId)
    .eq("external_call_id", event.external_call_id).maybeSingle();
  let callId = existing?.id ?? null;
  if (!callId) {
    const { data: created, error } = await supabase.from("calls").insert({
      tenant_id: resolved.tenantId,
      provider: "rinkel",
      external_call_id: event.external_call_id,
      direction: "inbound",
      from_number: from,
      to_number: to,
      status: "ringing",
      callback_token_hash: crypto.randomUUID().replaceAll("-", ""),
      metadata: {
        platform_integration_id: event.platform_integration_id,
        number_allocation_id: resolved.allocationId,
        platform_rinkel_number_id: resolved.numberId,
      },
      initiated_at: event.event_at ?? event.received_at,
    }).select("id").single();
    if (error || !created) throw error ?? new Error("incoming_call_create_failed");
    callId = created.id;
  }
  await supabase.from("call_events").upsert({
    tenant_id: resolved.tenantId,
    call_id: callId,
    event_type: event.event_type,
    provider_event_id: event.id,
    occurred_at: event.event_at ?? event.received_at,
    payload: { external_call_id: event.external_call_id },
  }, { onConflict: "tenant_id,provider_event_id", ignoreDuplicates: true });
  await supabase.from("platform_rinkel_webhook_events").update({
    tenant_id: resolved.tenantId,
    status: "processed",
    processed_at: new Date().toISOString(),
  }).eq("id", event.id);
}

async function processOutgoing(event: EventRow) {
  const attempt = await resolveOutgoingAttempt(event);
  if (!attempt) return;
  await Promise.all([
    supabase.from("rinkel_call_attempts_v2").update({
      status: "matched",
      external_call_id: event.external_call_id,
      updated_at: new Date().toISOString(),
    }).eq("id", attempt.id).eq("tenant_id", attempt.tenant_id),
    supabase.from("calls").update({
      external_call_id: event.external_call_id,
      status: "ringing",
      initiated_at: event.event_at ?? event.received_at,
    }).eq("id", attempt.call_id).eq("tenant_id", attempt.tenant_id),
    supabase.from("platform_rinkel_webhook_events").update({
      tenant_id: attempt.tenant_id,
      status: "processed",
      processed_at: new Date().toISOString(),
    }).eq("id", event.id),
  ]);
}

async function processLifecycle(event: EventRow) {
  const call = await ensureCallForStartOrEnd(event);
  if (!call) {
    if (event.status !== "conflict") {
      await createConflict(event, "RINKEL_CALL_NOT_CORRELATED", [], {});
    }
    return;
  }
  const occurredAt = event.event_at ?? event.received_at;
  if (event.event_type === "callStart") {
    await supabase.from("calls").update({
      status: "answered",
      answered_at: occurredAt,
      provider_user_id: text(event.payload.userId),
    }).eq("id", call.id).eq("tenant_id", call.tenant_id);
  } else if (event.event_type === "callEnd") {
    const cause = text(event.payload.cause) ?? "UNANSWERED";
    const status = mapRinkelCause(cause as Parameters<typeof mapRinkelCause>[0]);
    const { data: row } = await supabase.from("calls").select("answered_at,initiated_at,created_at")
      .eq("id", call.id).eq("tenant_id", call.tenant_id).single();
    const started = Date.parse(row?.answered_at ?? row?.initiated_at ?? row?.created_at ?? occurredAt);
    const ended = Date.parse(occurredAt);
    await supabase.from("calls").update({
      status,
      end_cause: cause,
      ended_at: occurredAt,
      duration_seconds: Math.max(0, Math.floor((ended - started) / 1000)),
      recording_status: text(event.payload.callRecordingUrl) ? "available_at_provider" : "unavailable",
    }).eq("id", call.id).eq("tenant_id", call.tenant_id);
    await supabase.from("rinkel_call_attempts_v2").update({
      status: "completed",
      updated_at: new Date().toISOString(),
    }).eq("call_id", call.id).eq("tenant_id", call.tenant_id);
  } else if (event.event_type === "callInsights") {
    await supabase.from("call_insights").upsert({
      tenant_id: call.tenant_id,
      call_id: call.id,
      source: "rinkel",
      status: "available",
      sentiment: text(event.payload.sentiment),
      topics: Array.isArray(event.payload.topics) ? event.payload.topics : [],
      summary: text(event.payload.summary),
      analysis: { payload_version: 1 },
      generated_at: new Date().toISOString(),
    }, { onConflict: "call_id,source" });
    await supabase.from("calls").update({ insights_status: "available" })
      .eq("id", call.id).eq("tenant_id", call.tenant_id);
  }
  await Promise.all([
    supabase.from("call_events").upsert({
      tenant_id: call.tenant_id,
      call_id: call.id,
      event_type: event.event_type,
      provider_event_id: event.id,
      occurred_at: occurredAt,
      payload: { external_call_id: event.external_call_id },
    }, { onConflict: "tenant_id,provider_event_id", ignoreDuplicates: true }),
    supabase.from("platform_rinkel_webhook_events").update({
      tenant_id: call.tenant_id,
      status: "processed",
      processed_at: new Date().toISOString(),
    }).eq("id", event.id),
  ]);
}

async function processEvent(job: Job) {
  const eventId = text(job.payload.event_id) ?? job.aggregate_id;
  if (!eventId) throw new Error("event_id_missing");
  const { data, error } = await supabase.from("platform_rinkel_webhook_events")
    .select("*").eq("id", eventId).single();
  if (error || !data) throw new Error("event_not_found");
  const event = data as EventRow;
  if (["processed", "conflict"].includes(event.status)) return;
  await supabase.from("platform_rinkel_webhook_events").update({
    status: "processing",
    attempts: Number((data as { attempts?: number }).attempts ?? 0) + 1,
  }).eq("id", event.id).in("status", ["received", "failed"]);
  if (event.event_type === "incomingCall") await processIncoming(event);
  else if (event.event_type === "outgoingCall") await processOutgoing(event);
  else await processLifecycle(event);
}

async function processReconciliation() {
  const staleAt = new Date(Date.now() - 15 * 60_000).toISOString();
  const { data: stale } = await supabase.from("rinkel_call_attempts_v2")
    .select("id,call_id")
    .in("status", ["provider_outcome_unknown", "awaiting_provider_event"])
    .lt("requested_at", staleAt)
    .limit(100);
  for (const attempt of stale ?? []) {
    await supabase.from("rinkel_call_attempts_v2").update({
      status: "reconciliation_required",
      updated_at: new Date().toISOString(),
    }).eq("id", attempt.id);
    await supabase.from("calls").update({ status: "reconciliation_required" }).eq("id", attempt.call_id)
      .not("status", "in", '("completed","unanswered","failed","blocked","voicemail","outside_business_hours","cancelled")');
  }
  await supabase.from("platform_integrations").update({ last_reconciled_at: new Date().toISOString() })
    .eq("provider", "rinkel").is("disabled_at", null);
}

async function processEnrichment(job: Job) {
  const tenantId = text(job.payload.tenant_id);
  const callId = text(job.payload.call_id) ?? job.aggregate_id;
  const externalCallId = text(job.payload.external_call_id);
  const apiKey = Deno.env.get("RINKEL_API_KEY") ?? "";
  if (!tenantId || !callId || !externalCallId || !apiKey) throw new Error("enrichment_context_missing");
  const { data: call } = await supabase.from("calls").select("id,transcription_status")
    .eq("tenant_id", tenantId).eq("id", callId).eq("provider", "rinkel").single();
  if (!call) throw new Error("call_not_found");
  const client = new RinkelClient({
    apiKey,
    baseUrl: Deno.env.get("RINKEL_API_BASE_URL") ?? "https://api.rinkel.com/v1",
    timeoutMs: Number(Deno.env.get("RINKEL_REQUEST_TIMEOUT_MS") ?? 15000),
    requestId: job.id,
  });
  const transcript = await client.getTranscription(externalCallId);
  if (!transcript.available) throw new Error("transcription_pending");
  const rawTranscript = typeof transcript.value === "string" ? transcript.value : JSON.stringify(transcript.value);
  await supabase.from("call_transcripts").upsert({
    tenant_id: tenantId,
    call_id: callId,
    provider: "rinkel",
    status: "available",
    raw_transcript: rawTranscript,
    structured_transcript: typeof transcript.value === "object" ? transcript.value : null,
    generated_at: new Date().toISOString(),
    last_checked_at: new Date().toISOString(),
  }, { onConflict: "call_id,provider" });
  await supabase.from("calls").update({ transcription_status: "available" })
    .eq("tenant_id", tenantId).eq("id", callId);
}

async function runJob(job: Job) {
  if (job.job_type === "rinkel.process_event") return processEvent(job);
  if (job.job_type === "rinkel.enrich_call") return processEnrichment(job);
  if (job.job_type === "rinkel.reconcile_platform" || job.job_type === "rinkel.reconcile_unknown_dial") {
    return processReconciliation();
  }
  throw new Error(`unsupported_job:${job.job_type}`);
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return new Response("method_not_allowed", { status: 405 });
  if (!cronSecret || request.headers.get("x-cron-secret") !== cronSecret) {
    return new Response("unauthorized", { status: 401 });
  }
  const body = await request.json().catch(() => ({})) as { limit?: number; workerId?: string };
  const limit = Math.max(1, Math.min(Number(body.limit ?? 25), 100));
  const workerId = String(body.workerId ?? `rinkel-platform-worker:${crypto.randomUUID()}`).slice(0, 200);
  const { data: candidates, error } = await supabase.from("platform_rinkel_jobs").select("*")
    .in("status", ["pending", "failed"]).lte("available_at", new Date().toISOString())
    .order("created_at").limit(limit);
  if (error) return Response.json({ error: error.message }, { status: 500 });
  const results: Json[] = [];
  for (const candidate of (candidates ?? []) as Job[]) {
    const { data: claimed } = await supabase.from("platform_rinkel_jobs").update({
      status: "processing",
      locked_at: new Date().toISOString(),
      locked_by: workerId,
      attempts: candidate.attempts + 1,
    }).eq("id", candidate.id).in("status", ["pending", "failed"]).select("*").maybeSingle();
    if (!claimed) continue;
    try {
      await runJob(claimed as Job);
      await supabase.from("platform_rinkel_jobs").update({
        status: "completed",
        completed_at: new Date().toISOString(),
        locked_at: null,
        locked_by: null,
        last_error: null,
      }).eq("id", candidate.id);
      results.push({ id: candidate.id, status: "completed" });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message.slice(0, 500) : "unknown_error";
      const terminal = candidate.attempts + 1 >= candidate.max_attempts;
      await supabase.from("platform_rinkel_jobs").update({
        status: terminal ? "dead_letter" : "failed",
        available_at: new Date(Date.now() + Math.min(3600, (2 ** Math.min(candidate.attempts, 10)) * 30) * 1000).toISOString(),
        locked_at: null,
        locked_by: null,
        last_error: message,
      }).eq("id", candidate.id);
      results.push({ id: candidate.id, status: terminal ? "dead_letter" : "failed", error: message });
    }
  }
  return Response.json({ workerId, results });
});
