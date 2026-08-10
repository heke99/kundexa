import { serverEnv } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/database.types";

export const scheduledEdgeWorkers = [
  "automation-runner",
  "data-worker",
  "ingestion-worker",
  "compliance-worker",
  "parsehub-worker",
  "maintenance-worker",
] as const;

export type ScheduledEdgeWorker = (typeof scheduledEdgeWorkers)[number];

const payloads: Record<ScheduledEdgeWorker, Record<string, unknown>> = {
  "automation-runner": { source: "vercel_cron" },
  "data-worker": { source: "vercel_cron", limit: 20 },
  "ingestion-worker": { source: "vercel_cron", limit: 20 },
  "compliance-worker": { source: "vercel_cron", limit: 20, queueLimit: 100 },
  "parsehub-worker": { source: "vercel_cron" },
  "maintenance-worker": { source: "vercel_cron" },
};

export function isScheduledEdgeWorker(value: string): value is ScheduledEdgeWorker {
  return (scheduledEdgeWorkers as readonly string[]).includes(value);
}

function summarizeWorkerResult(value: unknown) {
  if (!value || typeof value !== "object") return { fetched: 0, processed: 0, failed: 0, requeued: 0 };
  const record = value as Record<string, unknown>;
  const rows = Array.isArray(record.results) ? record.results : Array.isArray(record.jobs) ? record.jobs : [];
  const statuses = rows.flatMap((row) => row && typeof row === "object" ? [String((row as Record<string, unknown>).status ?? "")] : []);
  const failed = statuses.filter((status) => ["failed", "dead_letter", "error"].includes(status)).length;
  const requeued = statuses.filter((status) => ["queued", "requeued", "retrying"].includes(status)).length;
  return {
    fetched: Number(record.fetched ?? record.claimed ?? rows.length ?? 0) || 0,
    processed: Number(record.processed ?? statuses.filter((status) => ["completed", "processed", "success"].includes(status)).length) || 0,
    failed: Number(record.failed ?? failed) || 0,
    requeued: Number(record.requeued ?? requeued) || 0,
  };
}

async function heartbeat(input: {
  worker: ScheduledEdgeWorker;
  workerId: string;
  status: "running" | "healthy" | "failed";
  startedAt: string;
  finishedAt: string | null;
  counts?: { fetched: number; processed: number; failed: number; requeued: number };
  errorCode?: string | null;
  errorMessage?: string | null;
  metadata?: Json;
}) {
  const admin = createAdminClient();
  const counts = input.counts ?? { fetched: 0, processed: 0, failed: 0, requeued: 0 };
  const { error } = await admin.rpc("record_platform_worker_heartbeat", {
    p_worker_key: input.worker,
    p_worker_id: input.workerId,
    p_status: input.status,
    p_started_at: input.startedAt,
    p_finished_at: input.finishedAt,
    p_fetched_count: counts.fetched,
    p_processed_count: counts.processed,
    p_failed_count: counts.failed,
    p_requeued_count: counts.requeued,
    p_error_code: input.errorCode ?? null,
    p_error_message: input.errorMessage ?? null,
    p_metadata: input.metadata ?? { scheduler: "vercel" },
  });
  if (error) throw new Error(`worker_heartbeat_failed:${error.message}`);
}

export async function invokeScheduledEdgeWorker(worker: ScheduledEdgeWorker) {
  const env = serverEnv();
  if (!env.CRON_SECRET) throw new Error("cron_secret_not_configured");
  const startedAt = new Date().toISOString();
  const workerId = `${worker}:vercel:${crypto.randomUUID()}`;
  await heartbeat({ worker, workerId, status: "running", startedAt, finishedAt: null });

  let response: Response;
  try {
    response = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/${worker}`, {
      method: "POST",
      headers: { "x-cron-secret": env.CRON_SECRET, "content-type": "application/json" },
      body: JSON.stringify(payloads[worker]),
      cache: "no-store",
      signal: AbortSignal.timeout(50_000),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "worker_network_failure";
    await heartbeat({
      worker,
      workerId,
      status: "failed",
      startedAt,
      finishedAt: new Date().toISOString(),
      counts: { fetched: 0, processed: 0, failed: 1, requeued: 0 },
      errorCode: "EDGE_WORKER_NETWORK_FAILURE",
      errorMessage: message.slice(0, 300),
    });
    throw new Error("edge_worker_network_failure");
  }

  const text = await response.text();
  let parsed: unknown = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  const counts = summarizeWorkerResult(parsed);
  const finishedAt = new Date().toISOString();
  if (!response.ok) {
    await heartbeat({
      worker,
      workerId,
      status: "failed",
      startedAt,
      finishedAt,
      counts: { ...counts, failed: Math.max(1, counts.failed) },
      errorCode: `EDGE_WORKER_HTTP_${response.status}`,
      errorMessage: `Scheduled Edge Function returned HTTP ${response.status}.`,
      metadata: { scheduler: "vercel", upstreamStatus: response.status },
    });
    throw new Error(`edge_worker_http_${response.status}`);
  }

  await heartbeat({
    worker,
    workerId,
    status: counts.failed > 0 ? "failed" : "healthy",
    startedAt,
    finishedAt,
    counts,
    errorCode: counts.failed > 0 ? "EDGE_WORKER_REPORTED_FAILURES" : null,
    errorMessage: counts.failed > 0 ? `${counts.failed} worker jobs reported failure.` : null,
    metadata: { scheduler: "vercel", upstreamStatus: response.status },
  });
  return { worker, status: counts.failed > 0 ? "degraded" : "healthy", ...counts };
}
