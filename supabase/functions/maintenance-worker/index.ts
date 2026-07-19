import { createClient } from "npm:@supabase/supabase-js@2.110.7";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const cronSecret = Deno.env.get("CRON_SECRET")!;
const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

type SegmentJob = { id: string; tenant_id: string; segment_id: string };

Deno.serve(async (request) => {
  if (request.method !== "POST") return new Response("method_not_allowed", { status: 405 });
  if (!cronSecret || request.headers.get("x-cron-secret") !== cronSecret) return new Response("unauthorized", { status: 401 });
  const body = await request.json().catch(() => ({})) as { segmentLimit?: number; retentionLimit?: number; geographyLimit?: number; workerId?: string };
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

  const { data: tenants, error: tenantError } = await supabase.from("tenants").select("id").eq("status", "active").limit(500);
  if (tenantError) return Response.json({ error: tenantError.message }, { status: 500 });
  const retentionResults: unknown[] = [];
  for (const tenant of tenants ?? []) {
    const { data, error } = await supabase.rpc("run_retention_maintenance", { p_tenant_id: tenant.id, p_limit: Math.max(1, Math.min(Number(body.retentionLimit ?? 1000), 10000)) });
    retentionResults.push(error ? { tenantId: tenant.id, error: error.message } : data);
  }
  return Response.json({ workerId, geographyNormalized: Number(geographyNormalized ?? 0), segmentResults, dynamicLists, retentionResults });
});
