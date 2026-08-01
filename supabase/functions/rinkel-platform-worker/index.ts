import { createClient } from "npm:@supabase/supabase-js@2.110.7";
import { RinkelClient } from "../_shared/rinkel.ts";

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
  provider_event_id: string;
  payload: Json;
  event_at: string | null;
  received_at: string;
  status: string;
  correlation_attempts: number;
  next_retry_at: string | null;
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
    correlation_status: "conflict",
    tenant_id: null,
    last_error: type,
    processed_at: new Date().toISOString(),
  }).eq("id", event.id);
}

async function markPendingCorrelation(event: EventRow, reason: string) {
  const attempts = Number(event.correlation_attempts ?? 0) + 1;
  const delayMs = Math.min(30 * 60_000, 15_000 * (2 ** Math.min(attempts - 1, 7)));
  const retryAt = new Date(Date.now() + delayMs).toISOString();
  const { error } = await supabase.from("platform_rinkel_webhook_events").update({
    status: "pending_correlation",
    correlation_status: "pending",
    correlation_attempts: attempts,
    next_retry_at: retryAt,
    last_error: reason,
    processed_at: null,
  }).eq("id", event.id);
  if (error) throw new Error(error.message);
}

async function requeuePendingEvents(externalCallId: string) {
  const { data: pending, error: pendingError } = await supabase.from("platform_rinkel_webhook_events")
    .select("id")
    .eq("external_call_id", externalCallId)
    .eq("status", "pending_correlation")
    .limit(100);
  if (pendingError) throw new Error(pendingError.message);
  if (!pending?.length) return;
  const { error } = await supabase.from("platform_rinkel_jobs").upsert(pending.map((item) => ({
    job_type: "rinkel.process_event",
    aggregate_id: item.id,
    idempotency_key: `rinkel.process_event:correlated:${item.id}`,
    payload: { event_id: item.id, reason: "correlation_available" },
    status: "pending",
    available_at: new Date().toISOString(),
  })), { onConflict: "idempotency_key", ignoreDuplicates: true });
  if (error) throw new Error(error.message);
}

async function resolveIncomingTenant(event: EventRow) {
  const to = text(event.payload.to);
  if (!to) {
    await markPendingCorrelation(event, "RINKEL_INCOMING_NUMBER_MISSING");
    return null;
  }
  const { data: number, error: numberError } = await supabase.from("platform_rinkel_numbers")
    .select("id").eq("phone_number_e164", to).eq("active", true).maybeSingle();
  if (numberError) throw new Error(numberError.message);
  if (!number) {
    await markPendingCorrelation(event, "RINKEL_INCOMING_NUMBER_NOT_REGISTERED");
    return null;
  }
  const at = event.event_at ?? event.received_at;
  const { data: allocations, error: allocationsError } = await supabase.from("rinkel_number_allocations")
    .select("id,tenant_id")
    .eq("rinkel_number_id", number.id)
    .lte("valid_from", at)
    .or(`valid_to.is.null,valid_to.gt.${at}`)
    .eq("status", "active");
  if (allocationsError) throw new Error(allocationsError.message);
  if ((allocations ?? []).length === 0) {
    await markPendingCorrelation(event, "RINKEL_INCOMING_ALLOCATION_NOT_AVAILABLE");
    return null;
  }
  if ((allocations ?? []).length > 1) {
    await createConflict(event, "RINKEL_INCOMING_ALLOCATION_CONFLICT", allocations!.map((item) => item.tenant_id), {
      to_suffix: to.slice(-4),
      candidate_count: allocations!.length,
    });
    return null;
  }
  return { tenantId: allocations![0].tenant_id, allocationId: allocations![0].id, numberId: number.id };
}

async function resolveOutgoingAttempt(event: EventRow) {
  const to = text(event.payload.to);
  const from = text(event.payload.from);
  const userId = text(event.payload.userId);
  if (!to || !userId) {
    await markPendingCorrelation(event, "RINKEL_OUTGOING_CORRELATION_FIELDS_MISSING");
    return null;
  }
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
  const { data: attempts, error: attemptsError } = await query;
  if (attemptsError) throw new Error(attemptsError.message);
  if ((attempts ?? []).length === 0) {
    await markPendingCorrelation(event, "RINKEL_OUTGOING_ATTEMPT_NOT_AVAILABLE");
    return null;
  }
  if ((attempts ?? []).length > 1) {
    await createConflict(event, "RINKEL_OUTGOING_CORRELATION_CONFLICT", attempts!.map((item) => item.tenant_id), {
      candidate_attempt_ids: attempts!.map((item) => item.id),
    });
    return null;
  }
  return attempts![0];
}

async function processIncoming(event: EventRow) {
  const resolved = await resolveIncomingTenant(event);
  if (!resolved) return;
  const from = text(event.payload.from) ?? "anonymous";
  const to = text(event.payload.to)!;
  const { data, error } = await supabase.rpc("correlate_rinkel_incoming_event", {
    p_event_id: event.id,
    p_tenant_id: resolved.tenantId,
    p_allocation_id: resolved.allocationId,
    p_number_id: resolved.numberId,
    p_from: from,
    p_to: to,
  });
  if (error) throw new Error(error.message);
  const result = data && typeof data === "object" && !Array.isArray(data) ? data as Json : {};
  if (result.status !== "processed") throw new Error("incoming_event_correlation_failed");
  await requeuePendingEvents(event.external_call_id);
}

async function processOutgoing(event: EventRow) {
  const attempt = await resolveOutgoingAttempt(event);
  if (!attempt) return;
  const { data, error } = await supabase.rpc("correlate_rinkel_outgoing_event", {
    p_event_id: event.id,
    p_attempt_id: attempt.id,
  });
  if (error) throw new Error(error.message);
  const result = data && typeof data === "object" && !Array.isArray(data) ? data as Json : {};
  if (result.status !== "processed") throw new Error("outgoing_event_correlation_failed");
  await requeuePendingEvents(event.external_call_id);
}

async function processLifecycle(event: EventRow) {
  const { data: calls, error: callsError } = await supabase.from("calls")
    .select("id,tenant_id")
    .eq("provider", "rinkel")
    .eq("external_call_id", event.external_call_id)
    .limit(2);
  if (callsError) throw new Error(callsError.message);
  if ((calls ?? []).length > 1) {
    await createConflict(event, "RINKEL_EXTERNAL_CALL_DUPLICATE", calls!.map((item) => item.tenant_id), {});
    return;
  }
  const { data, error } = await supabase.rpc("apply_rinkel_call_event", { p_event_id: event.id });
  if (error) throw new Error(error.message);
  const result = data && typeof data === "object" && !Array.isArray(data) ? data as Json : {};
  if (result.status === "pending_correlation") return;
}

async function processEvent(job: Job) {
  const eventId = text(job.payload.event_id) ?? job.aggregate_id;
  if (!eventId) throw new Error("event_id_missing");
  const { data, error } = await supabase.from("platform_rinkel_webhook_events")
    .select("*").eq("id", eventId).single();
  if (error || !data) throw new Error("event_not_found");
  const event = data as EventRow;
  if (["processed", "conflict", "dead_letter"].includes(event.status)) return;
  const { data: claimed, error: claimError } = await supabase.from("platform_rinkel_webhook_events").update({
    status: "processing",
    attempts: Number((data as { attempts?: number }).attempts ?? 0) + 1,
  }).eq("id", event.id).in("status", ["received", "failed", "pending_correlation"]).select("id").maybeSingle();
  if (claimError) throw new Error(claimError.message);
  if (!claimed) return;
  if (event.event_type === "incomingCall") await processIncoming(event);
  else if (event.event_type === "outgoingCall") await processOutgoing(event);
  else await processLifecycle(event);
}

async function processReconciliation() {
  const now = new Date().toISOString();
  const { data: pendingEvents, error: pendingEventsError } = await supabase.from("platform_rinkel_webhook_events")
    .select("id,next_retry_at")
    .eq("status", "pending_correlation")
    .lte("next_retry_at", now)
    .limit(100);
  if (pendingEventsError) throw new Error(pendingEventsError.message);
  if (pendingEvents?.length) {
    const { error } = await supabase.from("platform_rinkel_jobs").upsert(pendingEvents.map((event) => ({
      job_type: "rinkel.process_event",
      aggregate_id: event.id,
      idempotency_key: `rinkel.process_event:retry:${event.id}:${event.next_retry_at ?? "due"}`,
      payload: { event_id: event.id, reason: "scheduled_correlation_retry" },
      status: "pending",
      available_at: now,
    })), { onConflict: "idempotency_key", ignoreDuplicates: true });
    if (error) throw new Error(error.message);
  }

  const staleAt = new Date(Date.now() - 15 * 60_000).toISOString();
  const { data: stale, error: staleError } = await supabase.from("rinkel_call_attempts_v2")
    .select("id,call_id")
    .in("status", ["provider_outcome_unknown", "awaiting_provider_event"])
    .lt("requested_at", staleAt)
    .limit(100);
  if (staleError) throw new Error(staleError.message);
  for (const attempt of stale ?? []) {
    const { error: attemptError } = await supabase.from("rinkel_call_attempts_v2").update({
      status: "reconciliation_required",
      updated_at: now,
    }).eq("id", attempt.id);
    if (attemptError) throw new Error(attemptError.message);
    const { error: callError } = await supabase.from("calls").update({
      status: "reconciliation_required",
      provider_status: "provider_outcome_unknown",
      provider_state_updated_at: now,
    }).eq("id", attempt.call_id)
      .not("status", "in", '("completed","unanswered","failed","blocked","voicemail","outside_business_hours","cancelled")');
    if (callError) throw new Error(callError.message);
  }
  const { error: integrationError } = await supabase.from("platform_integrations").update({ last_reconciled_at: now })
    .eq("provider", "rinkel").is("disabled_at", null);
  if (integrationError) throw new Error(integrationError.message);
}

async function processEnrichment(job: Job) {
  const tenantId = text(job.payload.tenant_id);
  const callId = text(job.payload.call_id) ?? job.aggregate_id;
  const externalCallId = text(job.payload.external_call_id);
  const apiKey = Deno.env.get("RINKEL_API_KEY") ?? "";
  if (!tenantId || !callId || !externalCallId || !apiKey) throw new Error("enrichment_context_missing");
  const { data: call, error: callError } = await supabase.from("calls").select("id,transcription_status")
    .eq("tenant_id", tenantId).eq("id", callId).eq("provider", "rinkel").single();
  if (callError || !call) throw new Error(callError?.message ?? "call_not_found");
  const client = new RinkelClient({
    apiKey,
    baseUrl: Deno.env.get("RINKEL_API_BASE_URL") ?? "https://api.rinkel.com/v1",
    timeoutMs: Number(Deno.env.get("RINKEL_REQUEST_TIMEOUT_MS") ?? 15000),
    requestId: job.id,
  });
  const transcript = await client.getTranscription(externalCallId);
  if (!transcript.available) throw new Error("transcription_pending");
  const rawTranscript = typeof transcript.value === "string" ? transcript.value : JSON.stringify(transcript.value);
  const { error: transcriptError } = await supabase.from("call_transcripts").upsert({
    tenant_id: tenantId,
    call_id: callId,
    provider: "rinkel",
    status: "available",
    raw_transcript: rawTranscript,
    structured_transcript: typeof transcript.value === "object" ? transcript.value : null,
    generated_at: new Date().toISOString(),
    last_checked_at: new Date().toISOString(),
  }, { onConflict: "call_id,provider" });
  if (transcriptError) throw new Error(transcriptError.message);
  const { error: transcriptionStatusError } = await supabase.from("calls").update({ transcription_status: "available" })
    .eq("tenant_id", tenantId).eq("id", callId);
  if (transcriptionStatusError) throw new Error(transcriptionStatusError.message);
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
    const { data: claimed, error: claimError } = await supabase.from("platform_rinkel_jobs").update({
      status: "processing",
      locked_at: new Date().toISOString(),
      locked_by: workerId,
      attempts: candidate.attempts + 1,
    }).eq("id", candidate.id).in("status", ["pending", "failed"]).select("*").maybeSingle();
    if (claimError) {
      results.push({ id: candidate.id, status: "claim_failed", error: claimError.message });
      continue;
    }
    if (!claimed) continue;
    try {
      await runJob(claimed as Job);
      const { error: completionError } = await supabase.from("platform_rinkel_jobs").update({
        status: "completed",
        completed_at: new Date().toISOString(),
        locked_at: null,
        locked_by: null,
        last_error: null,
      }).eq("id", candidate.id);
      if (completionError) throw new Error(completionError.message);
      results.push({ id: candidate.id, status: "completed" });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message.slice(0, 500) : "unknown_error";
      const terminal = candidate.attempts + 1 >= candidate.max_attempts;
      const { error: failureUpdateError } = await supabase.from("platform_rinkel_jobs").update({
        status: terminal ? "dead_letter" : "failed",
        available_at: new Date(Date.now() + Math.min(3600, (2 ** Math.min(candidate.attempts, 10)) * 30) * 1000).toISOString(),
        locked_at: null,
        locked_by: null,
        last_error: message,
      }).eq("id", candidate.id);
      results.push({
        id: candidate.id,
        status: terminal ? "dead_letter" : "failed",
        error: failureUpdateError ? `${message}; job_state_update_failed:${failureUpdateError.message}` : message,
      });
    }
  }
  return Response.json({ workerId, results });
});
