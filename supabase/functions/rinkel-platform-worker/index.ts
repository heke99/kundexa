import { createClient } from "npm:@supabase/supabase-js@2.110.7";
import { RinkelClient, RINKEL_CORE_WEBHOOK_EVENTS } from "../_shared/rinkel.ts";

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
  created_at?: string;
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
type CallRow = {
  id: string;
  tenant_id: string;
  external_call_id: string | null;
  from_number: string;
  to_number: string;
  provider_user_id: string | null;
  created_at: string;
  initiated_at: string | null;
  answered_at: string | null;
  ended_at: string | null;
  transcription_status: string;
  insights_status: string;
};
type AttemptRow = {
  id: string;
  call_id: string;
  tenant_id: string;
  external_call_id: string | null;
  external_rinkel_user_id: string;
  source_number_e164: string;
  destination_number_e164: string;
  requested_at: string;
};
type CdrProjection = {
  externalCallId: string | null;
  recordId: string | null;
  userId: string | null;
  from: string | null;
  to: string | null;
  startedAt: string | null;
  answeredAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  cause: string | null;
  recordingId: string | null;
};

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function object(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : null;
}

function valueAt(input: unknown, path: string): unknown {
  let current: unknown = input;
  for (const part of path.split(".")) {
    const currentObject = object(current);
    if (!currentObject) return undefined;
    current = currentObject[part];
  }
  return current;
}

function firstText(input: unknown, paths: string[]) {
  for (const path of paths) {
    const value = text(valueAt(input, path));
    if (value) return value;
  }
  return null;
}

function firstDate(input: unknown, paths: string[]) {
  const value = firstText(input, paths);
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

function firstInteger(input: unknown, paths: string[]) {
  for (const path of paths) {
    const raw = valueAt(input, path);
    const value = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : Number.NaN;
    if (Number.isFinite(value) && value >= 0) return Math.round(value);
  }
  return null;
}

function recordingIdFromUrl(value: string | null) {
  if (!value) return null;
  try {
    const parts = new URL(value).pathname.split("/").filter(Boolean);
    const marker = parts.lastIndexOf("call-recordings");
    const candidate = marker >= 0 ? parts[marker + 1] ?? "" : "";
    return /^[A-Za-z0-9_-]+$/.test(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function projectCdr(record: Json): CdrProjection {
  const cause = firstText(record, ["cause", "endCause", "end_cause", "result.cause", "details.cause"]);
  const directRecordingId = firstText(record, [
    "recordingId",
    "recording_id",
    "callRecordingId",
    "recording.id",
    "details.recordingId",
  ]);
  const recordingUrl = firstText(record, [
    "callRecordingUrl",
    "recordingUrl",
    "recording.url",
    "details.callRecordingUrl",
  ]);
  return {
    externalCallId: firstText(record, ["callId", "call_id", "externalCallId", "external_call_id"]),
    recordId: firstText(record, ["recordId", "record_id", "cdrId", "id"]),
    userId: firstText(record, ["userId", "user_id", "user.id", "agent.id", "details.userId"]),
    from: firstText(record, ["from", "fromNumber", "from_number", "source", "sourceNumber"]),
    to: firstText(record, ["to", "toNumber", "to_number", "destination", "destinationNumber"]),
    startedAt: firstDate(record, ["startedAt", "startTime", "start_time", "datetime", "createdAt", "details.startedAt"]),
    answeredAt: firstDate(record, ["answeredAt", "answerTime", "answer_time", "connectedAt", "details.answeredAt"]),
    endedAt: firstDate(record, ["endedAt", "endTime", "end_time", "completedAt", "details.endedAt"]),
    durationSeconds: firstInteger(record, ["durationSeconds", "duration_seconds", "duration", "details.durationSeconds"]),
    cause: cause ? cause.toUpperCase().slice(0, 100) : null,
    recordingId: directRecordingId && /^[A-Za-z0-9_-]+$/.test(directRecordingId)
      ? directRecordingId
      : recordingIdFromUrl(recordingUrl),
  };
}

function timestampDistance(left: string | null, right: string) {
  if (!left) return Number.POSITIVE_INFINITY;
  return Math.abs(Date.parse(left) - Date.parse(right));
}

function cdrMatchesAttempt(cdr: CdrProjection, call: CallRow, attempt: AttemptRow | null) {
  if (cdr.to && cdr.to !== call.to_number) return false;
  if (cdr.from && cdr.from !== call.from_number) return false;
  if (attempt && cdr.userId && cdr.userId !== attempt.external_rinkel_user_id) return false;
  const reference = attempt?.requested_at ?? call.initiated_at ?? call.created_at;
  const candidateTime = cdr.startedAt ?? cdr.answeredAt ?? cdr.endedAt;
  return !candidateTime || timestampDistance(candidateTime, reference) <= 20 * 60_000;
}

async function persistOpenConflict(input: {
  conflictType: string;
  providerResourceKey: string;
  claimedTenantIds: string[];
  eventId?: string | null;
  details: Json;
}) {
  const claimedTenantIds = [...new Set(input.claimedTenantIds)];
  const { data: existing, error: readError } = await supabase.from("platform_rinkel_conflicts")
    .select("id").eq("conflict_type", input.conflictType).eq("provider_resource_key", input.providerResourceKey)
    .eq("status", "open").maybeSingle();
  if (readError) throw new Error(readError.message);
  if (existing) {
    const { error } = await supabase.from("platform_rinkel_conflicts").update({
      claimed_tenant_ids: claimedTenantIds,
      event_id: input.eventId ?? null,
      details: input.details,
    }).eq("id", existing.id);
    if (error) throw new Error(error.message);
    return;
  }
  const { error } = await supabase.from("platform_rinkel_conflicts").insert({
    conflict_type: input.conflictType,
    provider_resource_type: "call",
    provider_resource_key: input.providerResourceKey,
    claimed_tenant_ids: claimedTenantIds,
    event_id: input.eventId ?? null,
    details: input.details,
    status: "open",
  });
  if (error && error.code !== "23505") throw new Error(error.message);
}

async function createConflict(event: EventRow, type: string, tenants: string[], details: Json) {
  await persistOpenConflict({
    conflictType: type,
    providerResourceKey: event.external_call_id,
    claimedTenantIds: tenants,
    eventId: event.id,
    details: { ...details, event_type: event.event_type },
  });
  await supabase.from("platform_rinkel_webhook_events").update({
    status: "conflict",
    correlation_status: "conflict",
    tenant_id: null,
    last_error: type,
    processed_at: new Date().toISOString(),
  }).eq("id", event.id);
}

async function createCallConflict(call: CallRow, type: string, details: Json) {
  await persistOpenConflict({
    conflictType: type,
    providerResourceKey: call.external_call_id ?? call.id,
    claimedTenantIds: [call.tenant_id],
    details: { ...details, call_id: call.id },
  });
  const { error: callError } = await supabase.from("calls").update({
    status: "reconciliation_required",
    provider_status: "unknown",
    provider_state_updated_at: new Date().toISOString(),
  }).eq("tenant_id", call.tenant_id).eq("id", call.id);
  if (callError) throw new Error(callError.message);
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
  const deviceId = text(event.payload.deviceId) ?? text(event.payload.device_id);
  let query = supabase.from("rinkel_call_attempts_v2")
    .select("id,tenant_id,call_id")
    .eq("external_rinkel_user_id", userId)
    .eq("destination_number_e164", to)
    .gte("requested_at", fromTime)
    .lte("requested_at", toTime)
    .in("status", ["requested", "dial_requested", "awaiting_provider_event", "provider_outcome_unknown"]);
  if (from && from !== "anonymous") query = query.eq("source_number_e164", from);
  if (deviceId) query = query.eq("rinkel_device_id", deviceId);
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
  if (!resolved) return false;
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
  const result = object(data) ?? {};
  if (result.status !== "processed") throw new Error("incoming_event_correlation_failed");
  await requeuePendingEvents(event.external_call_id);
  return true;
}

async function processOutgoing(event: EventRow) {
  const attempt = await resolveOutgoingAttempt(event);
  if (!attempt) return false;
  const { data, error } = await supabase.rpc("correlate_rinkel_outgoing_event", {
    p_event_id: event.id,
    p_attempt_id: attempt.id,
  });
  if (error) throw new Error(error.message);
  const result = object(data) ?? {};
  if (result.status !== "processed") throw new Error("outgoing_event_correlation_failed");
  await requeuePendingEvents(event.external_call_id);
  return true;
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
    return false;
  }
  const { data, error } = await supabase.rpc("apply_rinkel_call_event", { p_event_id: event.id });
  if (error) throw new Error(error.message);
  const result = object(data) ?? {};
  if (result.status === "pending_correlation") return false;
  return result.status === "processed";
}

async function recordWebhookProcessingSuccess(event: EventRow) {
  const processedAt = new Date().toISOString();
  const { error } = await supabase.rpc("record_platform_rinkel_webhook_processed", {
    p_platform_integration_id: event.platform_integration_id,
    p_event_type: event.event_type,
    p_processed_at: processedAt,
  });
  if (error) throw new Error(error.message);
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
  const processed = event.event_type === "incomingCall"
    ? await processIncoming(event)
    : event.event_type === "outgoingCall"
      ? await processOutgoing(event)
      : await processLifecycle(event);
  if (processed) await recordWebhookProcessingSuccess(event);
}

function createRinkelClient(requestId: string) {
  const apiKey = Deno.env.get("RINKEL_API_KEY") ?? "";
  if (!apiKey) throw new Error("rinkel_api_key_missing");
  return new RinkelClient({
    apiKey,
    baseUrl: Deno.env.get("RINKEL_API_BASE_URL") ?? "https://api.rinkel.com/v1",
    timeoutMs: Number(Deno.env.get("RINKEL_REQUEST_TIMEOUT_MS") ?? 15000),
    requestId,
  });
}

async function loadCallAndAttempt(callId: string) {
  const { data: call, error: callError } = await supabase.from("calls")
    .select("id,tenant_id,external_call_id,from_number,to_number,provider_user_id,created_at,initiated_at,answered_at,ended_at,transcription_status,insights_status")
    .eq("id", callId).eq("provider", "rinkel").single();
  if (callError || !call) throw new Error(callError?.message ?? "call_not_found");
  const { data: attempt, error: attemptError } = await supabase.from("rinkel_call_attempts_v2")
    .select("id,call_id,tenant_id,external_call_id,external_rinkel_user_id,source_number_e164,destination_number_e164,requested_at")
    .eq("tenant_id", call.tenant_id).eq("call_id", call.id)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (attemptError) throw new Error(attemptError.message);
  return { call: call as CallRow, attempt: attempt as AttemptRow | null };
}

async function processCallReconciliation(job: Job) {
  let callId = text(job.payload.call_id) ?? job.aggregate_id;
  const attemptId = text(job.payload.attempt_id);
  if (!callId && attemptId) {
    const { data, error } = await supabase.from("rinkel_call_attempts_v2").select("call_id").eq("id", attemptId).single();
    if (error || !data) throw new Error(error?.message ?? "attempt_not_found");
    callId = data.call_id;
  }
  if (!callId) throw new Error("reconciliation_call_id_missing");
  const { call, attempt } = await loadCallAndAttempt(callId);
  const client = createRinkelClient(`reconcile:${job.id}`);
  const knownExternalCallId = call.external_call_id ?? attempt?.external_call_id ?? text(job.payload.external_call_id);
  let projection: CdrProjection | null = null;

  if (knownExternalCallId) {
    const record = await client.getCallByCallId(knownExternalCallId, true);
    if (!record) throw new Error("cdr_not_available");
    projection = projectCdr(record);
    projection.externalCallId = knownExternalCallId;
  } else {
    const reference = attempt?.requested_at ?? call.initiated_at ?? call.created_at;
    const center = Date.parse(reference);
    const records = await client.listCallDetailRecords({
      startDate: new Date(center - 30 * 60_000).toISOString(),
      endDate: new Date(center + 30 * 60_000).toISOString(),
    });
    const candidates = records.map((candidate) => ({ record: candidate, projection: projectCdr(candidate) }))
      .filter((candidate) => cdrMatchesAttempt(candidate.projection, call, attempt));
    if (candidates.length === 0) throw new Error("cdr_not_available");
    if (candidates.length > 1) {
      await createCallConflict(call, "RINKEL_CDR_CORRELATION_CONFLICT", {
        candidate_count: candidates.length,
        candidate_ids: candidates.map((candidate) => candidate.projection.externalCallId ?? candidate.projection.recordId),
      });
      return;
    }
    projection = candidates[0].projection;
    projection.externalCallId = projection.externalCallId ?? projection.recordId;
  }

  const externalCallId = projection.externalCallId;
  if (!externalCallId) throw new Error("cdr_external_call_id_missing");
  const { data, error } = await supabase.rpc("reconcile_rinkel_call_from_cdr", {
    p_call_id: call.id,
    p_external_call_id: externalCallId,
    p_started_at: projection.startedAt,
    p_answered_at: projection.answeredAt,
    p_ended_at: projection.endedAt,
    p_duration_seconds: projection.durationSeconds,
    p_cause: projection.cause,
    p_recording_id: projection.recordingId,
    p_provider_payload: {
      source: "rinkel_cdr",
      retrieved_at: new Date().toISOString(),
      record_id: projection.recordId,
      has_recording: Boolean(projection.recordingId),
    },
  });
  if (error) throw new Error(error.message);
  const result = object(data) ?? {};
  if (result.status !== "reconciled") throw new Error("cdr_reconciliation_failed");
}

async function enqueueReconciliationJobs(rows: Array<{ id: string; call_id: string; tenant_id: string; external_call_id?: string | null }>, reason: string) {
  if (!rows.length) return;
  const bucket = new Date().toISOString().slice(0, 13);
  const { error } = await supabase.from("platform_rinkel_jobs").upsert(rows.map((row) => ({
    job_type: "rinkel.reconcile_call",
    aggregate_id: row.call_id,
    idempotency_key: `rinkel.reconcile_call:${reason}:${row.call_id}:${bucket}`,
    payload: {
      attempt_id: row.id,
      call_id: row.call_id,
      tenant_id: row.tenant_id,
      external_call_id: row.external_call_id ?? null,
      reason,
    },
    status: "pending",
    available_at: new Date().toISOString(),
  })), { onConflict: "idempotency_key", ignoreDuplicates: true });
  if (error) throw new Error(error.message);
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
    .select("id,call_id,tenant_id,external_call_id")
    .in("status", ["provider_outcome_unknown", "awaiting_provider_event", "reconciliation_required"])
    .lt("requested_at", staleAt)
    .limit(100);
  if (staleError) throw new Error(staleError.message);
  for (const attempt of stale ?? []) {
    const { error: attemptError } = await supabase.from("rinkel_call_attempts_v2").update({
      status: "reconciliation_required",
      updated_at: now,
    }).eq("id", attempt.id).neq("status", "completed");
    if (attemptError) throw new Error(attemptError.message);
    const { error: callError } = await supabase.from("calls").update({
      status: "reconciliation_required",
      provider_status: "unknown",
      provider_state_updated_at: now,
    }).eq("id", attempt.call_id)
      .not("status", "in", '("completed","unanswered","failed","blocked","voicemail","outside_business_hours","cancelled")');
    if (callError) throw new Error(callError.message);
  }
  await enqueueReconciliationJobs((stale ?? []) as Array<{ id: string; call_id: string; tenant_id: string; external_call_id: string | null }>, "stale_attempt");

  const incompleteQuery = () => supabase.from("calls")
    .select("id,tenant_id,external_call_id,created_at")
    .eq("provider", "rinkel")
    .not("external_call_id", "is", null)
    .or("provider_status.eq.unknown,recording_status.eq.pending,transcription_status.in.(pending,pending_provider)");
  const [{ data: oldestIncomplete, error: oldestError }, { data: newestIncomplete, error: newestError }] = await Promise.all([
    incompleteQuery().order("created_at", { ascending: true }).limit(50),
    incompleteQuery().order("created_at", { ascending: false }).limit(50),
  ]);
  if (oldestError) throw new Error(oldestError.message);
  if (newestError) throw new Error(newestError.message);
  const incompleteById = new Map<string, { id: string; tenant_id: string; external_call_id: string | null }>();
  for (const call of [...(oldestIncomplete ?? []), ...(newestIncomplete ?? [])]) incompleteById.set(call.id, call);
  await enqueueReconciliationJobs([...incompleteById.values()].map((call) => ({
    id: call.id,
    call_id: call.id,
    tenant_id: call.tenant_id,
    external_call_id: call.external_call_id,
  })), "incomplete_projection");

  const { error: integrationError } = await supabase.from("platform_integrations").update({ last_reconciled_at: now })
    .eq("provider", "rinkel").eq("is_canonical", true).is("disabled_at", null);
  if (integrationError) throw new Error(integrationError.message);
}

async function processEnrichment(job: Job) {
  const tenantId = text(job.payload.tenant_id);
  const callId = text(job.payload.call_id) ?? job.aggregate_id;
  const externalCallId = text(job.payload.external_call_id);
  if (!tenantId || !callId || !externalCallId) throw new Error("enrichment_context_missing");
  const { data: call, error: callError } = await supabase.from("calls").select("id,transcription_status")
    .eq("tenant_id", tenantId).eq("id", callId).eq("provider", "rinkel").single();
  if (callError || !call) throw new Error(callError?.message ?? "call_not_found");
  if (call.transcription_status === "disabled" || call.transcription_status === "available") return;
  const transcript = await createRinkelClient(`enrichment:${job.id}`).getTranscription(externalCallId);
  if (!transcript.available) {
    const checkedAt = new Date().toISOString();
    const waitExpired = Boolean(job.created_at && Date.now() - Date.parse(job.created_at) >= 72 * 60 * 60_000);
    const status = waitExpired ? "not_available" : "pending_provider";
    const { error: pendingError } = await supabase.from("call_transcripts").upsert({
      tenant_id: tenantId, call_id: callId, provider: "rinkel", status, last_checked_at: checkedAt,
      next_retry_at: waitExpired ? null : new Date(Date.now() + 30 * 60_000).toISOString(),
      retry_count: job.attempts,
    }, { onConflict: "call_id,provider" });
    if (pendingError) throw new Error(pendingError.message);
    const { error: callPendingError } = await supabase.from("calls").update({ transcription_status: status })
      .eq("tenant_id", tenantId).eq("id", callId);
    if (callPendingError) throw new Error(callPendingError.message);
    if (waitExpired) return;
    throw new Error("transcription_pending");
  }
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

async function processPlatformRetention() {
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
  const { data: openConflicts, error: conflictError } = await supabase.from("platform_rinkel_conflicts")
    .select("event_id").eq("status", "open").not("event_id", "is", null).limit(1000);
  if (conflictError) throw new Error(conflictError.message);
  const protectedEventIds = new Set((openConflicts ?? []).map((row) => row.event_id).filter(Boolean));

  const { data: events, error: eventError } = await supabase.from("platform_rinkel_webhook_events")
    .select("id").is("tenant_id", null).lt("received_at", cutoff)
    .in("status", ["processed", "dead_letter", "conflict"]).limit(500);
  if (eventError) throw new Error(eventError.message);
  const eventIds = (events ?? []).map((row) => row.id).filter((id) => !protectedEventIds.has(id));
  if (eventIds.length) {
    const { error } = await supabase.from("platform_rinkel_webhook_events").update({
      payload: {}, headers: {}, last_error: null,
    }).in("id", eventIds);
    if (error) throw new Error(error.message);
  }

  const { data: jobs, error: jobError } = await supabase.from("platform_rinkel_jobs")
    .select("id,payload").in("status", ["completed", "dead_letter"]).lt("created_at", cutoff).limit(500);
  if (jobError) throw new Error(jobError.message);
  const jobIds = (jobs ?? []).filter((row) => {
    const payload = object(row.payload) ?? {};
    return !text(payload.tenant_id);
  }).map((row) => row.id);
  if (jobIds.length) {
    const { error } = await supabase.from("platform_rinkel_jobs").update({
      payload: {}, last_error: null, last_error_code: null, last_error_message: null,
    }).in("id", jobIds);
    if (error) throw new Error(error.message);
  }

  const { error: auditError } = await supabase.from("platform_audit_logs").insert({
    actor_user_id: null,
    action: "rinkel.platform_retention_executed",
    entity_type: "telephony_retention",
    entity_id: "rinkel-platform",
    reason: "Scheduled platform-level raw payload retention",
    metadata: { cutoff, tenant_null_events_scrubbed: eventIds.length, platform_jobs_scrubbed: jobIds.length },
  });
  if (auditError) throw new Error(auditError.message);
}

async function runJob(job: Job) {
  if (job.job_type === "rinkel.process_event" || job.job_type === "rinkel.insights.process") return processEvent(job);
  if (job.job_type === "rinkel.enrich_call" || job.job_type === "rinkel.transcription.fetch") return processEnrichment(job);
  if (job.job_type === "rinkel.reconcile_call" || job.job_type === "rinkel.reconcile_unknown_dial") {
    return processCallReconciliation(job);
  }
  if (job.job_type === "rinkel.reconcile_platform") return processReconciliation();
  if (job.job_type === "rinkel.retention_platform") return processPlatformRetention();
  throw new Error(`unsupported_job:${job.job_type}`);
}

async function recordWebhookProcessingFailure(job: Job, errorCode: string, errorMessage: string, retryAt: string) {
  if (job.job_type !== "rinkel.process_event") return;
  const eventId = text(job.payload.event_id) ?? job.aggregate_id;
  if (!eventId) return;
  const { error } = await supabase.rpc("record_platform_rinkel_webhook_failure", {
    p_event_id: eventId,
    p_error_code: errorCode,
    p_error_message: errorMessage,
    p_retry_at: retryAt,
  });
  if (error) throw new Error(`webhook_failure_state_failed:${error.message}`);
}

function classifyJobError(error: unknown) {
  const message = error instanceof Error ? error.message.slice(0, 500) : "unknown_error";
  if (message === "transcription_pending") return { code: "TRANSCRIPTION_PENDING", message, retrySeconds: 30 * 60 };
  if (message.includes("timeout")) return { code: "WORKER_TIMEOUT", message, retrySeconds: 5 * 60 };
  if (message.includes("rate")) return { code: "RINKEL_RATE_LIMITED", message, retrySeconds: 15 * 60 };
  if (message.startsWith("unsupported_job:")) return { code: "WORKER_UNSUPPORTED_JOB", message, retrySeconds: 60 * 60 };
  return { code: "WORKER_JOB_FAILED", message, retrySeconds: null as number | null };
}

async function heartbeat(input: {
  workerId: string;
  status: "running" | "healthy" | "degraded" | "failed";
  startedAt: string;
  finishedAt: string | null;
  fetched: number;
  processed: number;
  failed: number;
  requeued: number;
  errorCode?: string | null;
  errorMessage?: string | null;
}) {
  const { error } = await supabase.rpc("record_platform_worker_heartbeat", {
    p_worker_key: "rinkel-platform-worker",
    p_worker_id: input.workerId,
    p_status: input.status,
    p_started_at: input.startedAt,
    p_finished_at: input.finishedAt,
    p_fetched_count: input.fetched,
    p_processed_count: input.processed,
    p_failed_count: input.failed,
    p_requeued_count: input.requeued,
    p_error_code: input.errorCode ?? null,
    p_error_message: input.errorMessage ?? null,
    p_metadata: { runtime: "supabase-edge", claim: "for_update_skip_locked" },
  });
  if (error) throw new Error(`heartbeat_failed:${error.message}`);
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return new Response("method_not_allowed", { status: 405 });
  if (!cronSecret || request.headers.get("x-cron-secret") !== cronSecret) {
    return new Response("unauthorized", { status: 401 });
  }
  const body = await request.json().catch(() => ({})) as { limit?: number; workerId?: string };
  const limit = Math.max(1, Math.min(Number(body.limit ?? 25), 100));
  const workerId = String(body.workerId ?? `rinkel-platform-worker:${crypto.randomUUID()}`).slice(0, 200);
  const startedAt = new Date().toISOString();
  let processed = 0;
  let failed = 0;
  let requeued = 0;
  const results: Json[] = [];

  try {
    await heartbeat({ workerId, status: "running", startedAt, finishedAt: null, fetched: 0, processed: 0, failed: 0, requeued: 0 });
    const { data: claimed, error: claimError } = await supabase.rpc("claim_platform_rinkel_jobs", {
      p_worker_id: workerId,
      p_limit: limit,
      p_lease_timeout: "00:05:00",
    });
    if (claimError) throw new Error(`job_claim_failed:${claimError.message}`);
    const jobs = (claimed ?? []) as Job[];

    for (const job of jobs) {
      try {
        await runJob(job);
        const { data: finalStatus, error: finishError } = await supabase.rpc("finish_platform_rinkel_job", {
          p_job_id: job.id,
          p_worker_id: workerId,
          p_succeeded: true,
          p_error_code: null,
          p_error_message: null,
          p_retry_at: null,
        });
        if (finishError) throw new Error(`job_finish_failed:${finishError.message}`);
        processed += 1;
        results.push({ id: job.id, status: finalStatus ?? "completed" });
      } catch (caught) {
        const classified = classifyJobError(caught);
        const genericBackoff = Math.min(3600, (2 ** Math.min(job.attempts, 10)) * 30);
        const retrySeconds = classified.retrySeconds ?? genericBackoff;
        const retryAt = new Date(Date.now() + retrySeconds * 1000).toISOString();
        let failureStateError: string | null = null;
        try {
          await recordWebhookProcessingFailure(job, classified.code, classified.message, retryAt);
        } catch (failureStateCaught) {
          failureStateError = failureStateCaught instanceof Error ? failureStateCaught.message : "webhook_failure_state_failed";
        }
        const { data: finalStatus, error: finishError } = await supabase.rpc("finish_platform_rinkel_job", {
          p_job_id: job.id,
          p_worker_id: workerId,
          p_succeeded: false,
          p_error_code: classified.code,
          p_error_message: classified.message,
          p_retry_at: retryAt,
        });
        failed += 1;
        if (finalStatus === "failed") requeued += 1;
        results.push({
          id: job.id,
          status: finalStatus ?? "finish_failed",
          errorCode: classified.code,
          error: [classified.message, failureStateError, finishError ? `job_state_update_failed:${finishError.message}` : null].filter(Boolean).join("; "),
          retryAt: finalStatus === "failed" ? retryAt : null,
        });
      }
    }

    const finishedAt = new Date().toISOString();
    await heartbeat({
      workerId,
      status: failed > 0 ? "degraded" : "healthy",
      startedAt,
      finishedAt,
      fetched: jobs.length,
      processed,
      failed,
      requeued,
    });
    return Response.json({ workerId, fetched: jobs.length, processed, failed, requeued, results });
  } catch (caught) {
    const classified = classifyJobError(caught);
    const finishedAt = new Date().toISOString();
    try {
      await heartbeat({
        workerId,
        status: "failed",
        startedAt,
        finishedAt,
        fetched: results.length,
        processed,
        failed: failed + 1,
        requeued,
        errorCode: classified.code,
        errorMessage: classified.message,
      });
    } catch {
      // Preserve the primary worker error in the HTTP response.
    }
    return Response.json({ error: classified.code, message: classified.message, workerId, results }, { status: 500 });
  }
});
