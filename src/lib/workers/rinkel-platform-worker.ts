import { serverEnv } from "@/lib/env";

export type RinkelWorkerResult = Record<string, unknown>;

export class RinkelWorkerInvocationError extends Error {
  readonly code: string;
  readonly upstreamStatus: number | null;
  readonly upstreamBody: string | null;

  constructor(code: string, message: string, upstreamStatus: number | null = null, upstreamBody: string | null = null) {
    super(message);
    this.name = "RinkelWorkerInvocationError";
    this.code = code;
    this.upstreamStatus = upstreamStatus;
    this.upstreamBody = upstreamBody;
  }
}

function parseBody(body: string): RinkelWorkerResult {
  if (!body.trim()) return {};
  try {
    const parsed = JSON.parse(body) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as RinkelWorkerResult
      : { response: parsed };
  } catch {
    return { response: body.slice(0, 500) };
  }
}

export async function invokeRinkelPlatformWorker(source: string, limit = 50): Promise<RinkelWorkerResult> {
  const env = serverEnv();
  if (!env.CRON_SECRET) {
    throw new RinkelWorkerInvocationError(
      "RINKEL_WORKER_CRON_SECRET_MISSING",
      "CRON_SECRET saknas i servermiljön.",
    );
  }

  let response: Response;
  try {
    response = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/rinkel-platform-worker`, {
      method: "POST",
      headers: {
        "x-cron-secret": env.CRON_SECRET,
        "content-type": "application/json",
        authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      },
      body: JSON.stringify({
        source,
        limit,
        workerId: `${source}:${crypto.randomUUID()}`,
      }),
      cache: "no-store",
    });
  } catch (error) {
    throw new RinkelWorkerInvocationError(
      "RINKEL_WORKER_UNREACHABLE",
      error instanceof Error ? error.message : "Telefoniworkern kunde inte nås.",
    );
  }

  const body = await response.text();
  if (!response.ok) {
    const code = response.status === 404
      ? "RINKEL_WORKER_NOT_DEPLOYED"
      : response.status === 401
        ? "RINKEL_WORKER_SECRET_REJECTED"
        : response.status === 403
          ? "RINKEL_WORKER_FORBIDDEN"
          : `RINKEL_WORKER_HTTP_${response.status}`;
    throw new RinkelWorkerInvocationError(
      code,
      body.slice(0, 500) || `Telefoniworkern svarade med HTTP ${response.status}.`,
      response.status,
      body.slice(0, 500) || null,
    );
  }

  return parseBody(body);
}
