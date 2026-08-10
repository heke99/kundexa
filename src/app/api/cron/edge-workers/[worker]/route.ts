import { serverEnv } from "@/lib/env";
import { invokeScheduledEdgeWorker, isScheduledEdgeWorker } from "@/lib/workers/scheduled-edge-worker";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request, { params }: { params: Promise<{ worker: string }> }) {
  const env = serverEnv();
  if (!env.CRON_SECRET) return Response.json({ error: "cron_secret_not_configured" }, { status: 503 });
  if (request.headers.get("authorization") !== `Bearer ${env.CRON_SECRET}`) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  const { worker } = await params;
  if (!isScheduledEdgeWorker(worker)) return Response.json({ error: "worker_not_scheduled" }, { status: 404 });
  try {
    return Response.json(await invokeScheduledEdgeWorker(worker));
  } catch (error) {
    const message = error instanceof Error ? error.message : "edge_worker_invocation_failed";
    return Response.json({ error: message, worker }, { status: 502 });
  }
}
