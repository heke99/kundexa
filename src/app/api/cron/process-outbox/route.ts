import { serverEnv } from "@/lib/env";
import { invokeScheduledEdgeWorker } from "@/lib/workers/scheduled-edge-worker";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

// Kept as its own path because vercel.json schedules it there, but the work now
// goes through the same invoker as every other scheduled worker: a "running"
// heartbeat before the call, a "failed" one on a network error or a non-2xx, and
// job counts on success. Previously this route forwarded the request and
// returned the body, so an outbox that had been failing every minute for days
// left no trace in `platform_worker_heartbeats` — and that table is what the
// platform page and the readiness checks read.
export async function GET(request: Request) {
  const env = serverEnv();
  if (!env.CRON_SECRET) return Response.json({ error: "cron_secret_not_configured" }, { status: 503 });
  if (request.headers.get("authorization") !== `Bearer ${env.CRON_SECRET}`) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  try {
    return Response.json(await invokeScheduledEdgeWorker("process-outbox"));
  } catch (error) {
    // The heartbeat is already written by the invoker; this is the transport
    // answer to Vercel, which retries on the next minute either way.
    const message = error instanceof Error ? error.message : "process_outbox_invocation_failed";
    return Response.json({ error: message, worker: "process-outbox" }, { status: 502 });
  }
}
