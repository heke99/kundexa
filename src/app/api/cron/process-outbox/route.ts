import { serverEnv } from "@/lib/env";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const env = serverEnv();
  if (!env.CRON_SECRET) return Response.json({ error: "cron_secret_not_configured" }, { status: 503 });
  const authorization = request.headers.get("authorization");
  if (authorization !== `Bearer ${env.CRON_SECRET}`) return Response.json({ error: "forbidden" }, { status: 403 });
  const response = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/process-outbox`, {
    method: "POST",
    headers: { "x-cron-secret": env.CRON_SECRET, "content-type": "application/json" },
    body: JSON.stringify({ source: "vercel_cron" }),
    cache: "no-store",
  });
  const body = await response.text();
  return new Response(body, { status: response.status, headers: { "content-type": response.headers.get("content-type") ?? "application/json" } });
}
