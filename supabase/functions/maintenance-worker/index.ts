import { createClient } from "npm:@supabase/supabase-js@2.110.7";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const cronSecret = Deno.env.get("CRON_SECRET")!;
const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

type SegmentJob = { id: string; tenant_id: string; segment_id: string };

Deno.serve(async (request) => {
  if (request.method !== "POST") return new Response("method_not_allowed", { status: 405 });
  if (!cronSecret || request.headers.get("x-cron-secret") !== cronSecret) return new Response("unauthorized", { status: 401 });
  const body = await request.json().catch(() => ({})) as { segmentLimit?: number; retentionLimit?: number; geographyLimit?: number; allocationLimit?: number; rateLimitPruneLimit?: number; staleDialAttemptLimit?: number; lostWebphoneSessionLimit?: number; workerId?: string };
  const workerId = String(body.workerId ?? `maintenance-worker:${crypto.randomUUID()}`).slice(0, 200);
  await supabase.rpc("queue_due_segment_refreshes", { p_limit: Math.max(1, Math.min(Number(body.segmentLimit ?? 100), 500)) });
  const { data: claimed, error: claimError } = await supabase.rpc("claim_segment_refresh_jobs", { p_worker: workerId, p_limit: Math.max(1, Math.min(Number(body.segmentLimit ?? 10), 50)) });
  if (claimError) return Response.json({ error: claimError.message }, { status: 500 });
  const segmentResults: unknown[] = [];
  for (const job of (claimed ?? []) as SegmentJob[]) {
    const { error } = await supabase.rpc("complete_segment_refresh_job", { p_job_id: job.id, p_error: null });
    if (error) {
      await supabase.rpc("complete_segment_refresh_job", { p_job_id: job.id, p_error: error.message });
      segmentResults.push({ id: job.id, status: "failed", error: error.message });
    } else segmentResults.push({ id: job.id, status: "completed" });
  }
  const { data: dynamicLists, error: dynamicListError } = await supabase.rpc("refresh_due_dynamic_customer_lists", { p_limit: Math.max(1, Math.min(Number(body.segmentLimit ?? 100), 500)) });
  if (dynamicListError) return Response.json({ error: dynamicListError.message }, { status: 500 });

  const { data: geographyNormalized, error: geographyError } = await supabase.rpc("normalize_due_geographies", { p_limit: Math.max(1, Math.min(Number(body.geographyLimit ?? 500), 5000)) });
  if (geographyError) return Response.json({ error: geographyError.message }, { status: 500 });

  const { data: expiredAllocations, error: allocationError } = await supabase.rpc("release_expired_platform_allocations", { p_limit: Math.max(1, Math.min(Number(body.allocationLimit ?? 100), 1000)) });
  if (allocationError) return Response.json({ error: allocationError.message }, { status: 500 });

  // Rate-limit counters are only read for the current window, so prune expired ones here.
  // The table is written by every authenticated request; without this it grows unbounded.
  const { data: prunedRateLimits, error: rateLimitPruneError } = await supabase.rpc("prune_rate_limit_counters", {
    p_older_than: "01:00:00",
    p_limit: Math.max(1, Math.min(Number(body.rateLimitPruneLimit ?? 10000), 100000)),
  });
  if (rateLimitPruneError) return Response.json({ error: rateLimitPruneError.message }, { status: 500 });

  // Ett uppringningsförsök som aldrig fick ett leverantörssvar håller säljarens
  // plats för alltid. Skyddsnätet fanns men var aldrig schemalagt -- vilket
  // betyder att ingen säljare någonsin blev frisläppt av det. Nu körs det.
  // Timgränsen är funktionens egen nedre gräns: kortare än så läser en
  // nätverkshicka som ett tappat samtal.
  const { data: releasedAttempts, error: releaseError } = await supabase.rpc("release_stale_dial_attempts", {
    p_max_age: "01:00:00",
    p_limit: Math.max(1, Math.min(Number(body.staleDialAttemptLimit ?? 200), 1000)),
  });
  if (releaseError) return Response.json({ error: releaseError.message }, { status: 500 });

  const { data: lostSessions, error: lostSessionError } = await supabase.rpc("release_lost_webphone_sessions", {
    p_max_silence: "00:05:00",
    p_limit: Math.max(1, Math.min(Number(body.lostWebphoneSessionLimit ?? 200), 1000)),
  });
  if (lostSessionError) return Response.json({ error: lostSessionError.message }, { status: 500 });

  const { data: tenants, error: tenantError } = await supabase.from("tenants").select("id").eq("status", "active").limit(500);
  if (tenantError) return Response.json({ error: tenantError.message }, { status: 500 });
  const retentionResults: unknown[] = [];
  const retentionBucket = new Date().toISOString().slice(0, 10);
  for (const tenant of tenants ?? []) {
    await supabase.from("outbox_jobs").upsert({
      tenant_id: tenant.id,
      job_type: "telephony.retention",
      aggregate_type: "tenant",
      aggregate_id: tenant.id,
      payload: {},
      idempotency_key: `telephony.retention:${tenant.id}:${retentionBucket}`,
      priority: 90,
    }, { onConflict: "tenant_id,idempotency_key", ignoreDuplicates: true });
    const { data, error } = await supabase.rpc("run_retention_maintenance", { p_tenant_id: tenant.id, p_limit: Math.max(1, Math.min(Number(body.retentionLimit ?? 1000), 10000)) });
    retentionResults.push(error ? { tenantId: tenant.id, error: error.message } : data);
  }
  return Response.json({ workerId, geographyNormalized: Number(geographyNormalized ?? 0), expiredAllocations, prunedRateLimits: Number(prunedRateLimits ?? 0), releasedAttempts, lostSessions, segmentResults, dynamicLists, retentionResults });
});
