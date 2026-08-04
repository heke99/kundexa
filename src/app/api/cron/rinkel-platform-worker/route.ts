import { serverEnv } from "@/lib/env";
import {
  invokeRinkelPlatformWorker,
  RinkelWorkerInvocationError,
} from "@/lib/workers/rinkel-platform-worker";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  const env = serverEnv();
  if (!env.CRON_SECRET) {
    return Response.json({ error: "cron_secret_not_configured" }, { status: 503 });
  }
  if (request.headers.get("authorization") !== `Bearer ${env.CRON_SECRET}`) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  try {
    const result = await invokeRinkelPlatformWorker("vercel_cron", 50);
    return Response.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof RinkelWorkerInvocationError) {
      // Never return the upstream 404 directly. The Next.js route exists; a
      // 404 from Supabase means the Edge Function itself is not deployed.
      return Response.json({
        error: error.code.toLowerCase(),
        worker: "rinkel-platform-worker",
        upstreamStatus: error.upstreamStatus,
        message: error.code === "RINKEL_WORKER_NOT_DEPLOYED"
          ? "Telefoniworkerns Edge Function saknas i Supabase-projektet."
          : "Telefoniworkern kunde inte köras.",
      }, { status: 502 });
    }
    return Response.json({
      error: "rinkel_worker_invocation_failed",
      worker: "rinkel-platform-worker",
    }, { status: 502 });
  }
}
