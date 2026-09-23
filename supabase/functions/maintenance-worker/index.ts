import { createClient } from "npm:@supabase/supabase-js@2.110.7";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const cronSecret = Deno.env.get("CRON_SECRET")!;
const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

type SegmentJob = { id: string; tenant_id: string; segment_id: string };

// Varje steg körs för sig. Tidigare avbröt det första fel hela körningen: ett
// orelaterat segment- eller geografifel gjorde att de två stegen som släpper en
// säljares låsta plats aldrig kördes. Nu körs de först, varje steg fångar sitt
// eget fel, och resultatet rapporterar vilket steg som felade (`status:
// "failed"`), så att schemaläggarens hjärtslag visar det i stället för "healthy".
type StepResult = { step: string; status: "completed" | "failed"; error?: string };

async function step<T>(results: StepResult[], name: string, run: () => Promise<T>): Promise<T | null> {
  try {
    const value = await run();
    results.push({ step: name, status: "completed" });
    return value;
  } catch (error) {
    results.push({ step: name, status: "failed", error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

async function rpc(name: string, args: Record<string, unknown>) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.message);
  return data;
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return new Response("method_not_allowed", { status: 405 });
  if (!cronSecret || request.headers.get("x-cron-secret") !== cronSecret) return new Response("unauthorized", { status: 401 });
  const body = await request.json().catch(() => ({})) as { segmentLimit?: number; retentionLimit?: number; geographyLimit?: number; allocationLimit?: number; rateLimitPruneLimit?: number; staleDialAttemptLimit?: number; lostWebphoneSessionLimit?: number; workerId?: string };
  const workerId = String(body.workerId ?? `maintenance-worker:${crypto.randomUUID()}`).slice(0, 200);
  const results: StepResult[] = [];

  // Först det som håller en säljare fast. Ett uppringningsförsök som aldrig fick
  // ett leverantörssvar håller säljarens plats; timgränsen är funktionens egen
  // nedre gräns, kortare än så läser en nätverkshicka som ett tappat samtal.
  const releasedAttempts = await step(results, "release_stale_dial_attempts", () => rpc("release_stale_dial_attempts", {
    p_max_age: "01:00:00",
    p_limit: Math.max(1, Math.min(Number(body.staleDialAttemptLimit ?? 200), 1000)),
  }));
  // En stängd flik slår inga hjärtslag. Efter fem minuters tystnad släpps
  // sessionen och dess plats; med körning var femte minut tar det högst tio.
  const lostSessions = await step(results, "release_lost_webphone_sessions", () => rpc("release_lost_webphone_sessions", {
    p_max_silence: "00:05:00",
    p_limit: Math.max(1, Math.min(Number(body.lostWebphoneSessionLimit ?? 200), 1000)),
  }));

  const segmentResults: unknown[] = [];
  await step(results, "segment_refresh", async () => {
    await rpc("queue_due_segment_refreshes", { p_limit: Math.max(1, Math.min(Number(body.segmentLimit ?? 100), 500)) });
    const claimed = await rpc("claim_segment_refresh_jobs", { p_worker: workerId, p_limit: Math.max(1, Math.min(Number(body.segmentLimit ?? 10), 50)) });
    for (const job of (claimed ?? []) as SegmentJob[]) {
      const { error } = await supabase.rpc("complete_segment_refresh_job", { p_job_id: job.id, p_error: null });
      if (error) {
        await supabase.rpc("complete_segment_refresh_job", { p_job_id: job.id, p_error: error.message });
        segmentResults.push({ id: job.id, status: "failed", error: error.message });
      } else segmentResults.push({ id: job.id, status: "completed" });
    }
  });
  const dynamicLists = await step(results, "refresh_due_dynamic_customer_lists", () =>
    rpc("refresh_due_dynamic_customer_lists", { p_limit: Math.max(1, Math.min(Number(body.segmentLimit ?? 100), 500)) }));
  const geographyNormalized = await step(results, "normalize_due_geographies", () =>
    rpc("normalize_due_geographies", { p_limit: Math.max(1, Math.min(Number(body.geographyLimit ?? 500), 5000)) }));
  const expiredAllocations = await step(results, "release_expired_platform_allocations", () =>
    rpc("release_expired_platform_allocations", { p_limit: Math.max(1, Math.min(Number(body.allocationLimit ?? 100), 1000)) }));
  // Rate-limit counters are only read for the current window, so prune expired ones here.
  // The table is written by every authenticated request; without this it grows unbounded.
  const prunedRateLimits = await step(results, "prune_rate_limit_counters", () => rpc("prune_rate_limit_counters", {
    p_older_than: "01:00:00",
    p_limit: Math.max(1, Math.min(Number(body.rateLimitPruneLimit ?? 10000), 100000)),
  }));

  // Gallring gäller även företag som provar tjänsten, inte bara betalande.
  const retentionResults: unknown[] = [];
  await step(results, "retention", async () => {
    const { data: tenants, error: tenantError } = await supabase.from("tenants").select("id").in("status", ["active", "trial"]).limit(500);
    if (tenantError) throw new Error(tenantError.message);
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
      retentionResults.push(error ? { tenantId: tenant.id, status: "failed", error: error.message } : data);
    }
  });

  return Response.json({
    workerId, results,
    geographyNormalized: Number(geographyNormalized ?? 0), expiredAllocations, prunedRateLimits: Number(prunedRateLimits ?? 0),
    releasedAttempts, lostSessions, segmentResults, dynamicLists, retentionResults,
  });
});
