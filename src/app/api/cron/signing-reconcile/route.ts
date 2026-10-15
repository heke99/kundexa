import { createAdminClient } from "@/lib/supabase/admin";
import { serverEnv } from "@/lib/env";
import { continueNativeSigning } from "@/lib/signing/orchestration";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: Request) {
  const secret = serverEnv().CRON_SECRET;
  if (!secret) return Response.json({ error: "cron_secret_not_configured" }, { status: 503 });
  if (request.headers.get("authorization") !== `Bearer ${secret}`) return Response.json({ error: "forbidden" }, { status: 403 });
  const admin = createAdminClient();
  const startedAt = new Date().toISOString();
  const workerId = `signing-reconcile:${crypto.randomUUID()}`;
  async function heartbeat(status: string, processed = 0, failed = 0) {
    const { error } = await admin.rpc("record_platform_worker_heartbeat", {
      p_worker_key: "signing-reconcile", p_worker_id: workerId, p_status: status,
      p_started_at: startedAt, p_finished_at: status === "running" ? null : new Date().toISOString(),
      p_fetched_count: 0, p_processed_count: processed, p_failed_count: failed, p_requeued_count: 0,
      p_metadata: { scheduler: "vercel", runtime: "node" },
    });
    if (error) throw new Error("signing_worker_heartbeat_failed");
  }
  await heartbeat("running");
  // Rotate checked envelopes to the end even after an error; a broken oldest
  // operation must not starve every later completion. Updates touch no evidence.
  const { data: envelopes, error } = await admin.from("signing_envelopes").select("id,status,provider_envelope_id")
    .eq("provider", "kundexa_native").in("status", ["creating", "sent", "partially_signed"])
    .order("updated_at").order("id").limit(5);
  if (error) { await heartbeat("failed", 0, 1); return Response.json({ error: "signing_reconciliation_read_failed" }, { status: 503 }); }
  const deadline = Date.now() + 190_000;
  let processed = 0; let failed = 0;
  for (const envelope of envelopes ?? []) {
    if (Date.now() > deadline) break;
    try {
      await continueNativeSigning(envelope.id); // Reuses the first persisted receipt; no external side effects.
      processed++;
    } catch {
      failed++;
    }
    const { error: touchError } = await admin.from("signing_envelopes").update({ updated_at: new Date().toISOString() }).eq("id", envelope.id);
    if (touchError) { await heartbeat("failed", processed, failed + 1); return Response.json({ error: "signing_reconciliation_progress_failed", processed, failed }, { status: 503 }); }
  }
  await heartbeat(failed ? "degraded" : "healthy", processed, failed);
  return Response.json({ status: failed ? "degraded" : "completed", processed, failed }, { status: failed ? 503 : 200 });
}
