import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptJson, sha256 } from "@/lib/crypto";
import { serverEnv } from "@/lib/env";

export const runtime = "nodejs";

function constantTimeEquals(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function readPayload(request: Request) {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("application/json")) return await request.json() as Record<string, unknown>;
  const form = await request.formData();
  return Object.fromEntries(form.entries());
}

export async function POST(request: Request) {
  const referenceId = crypto.randomUUID();
  try {
    const url = new URL(request.url);
    const projectId = url.searchParams.get("project") ?? "";
    const secret = url.searchParams.get("secret") ?? "";
    if (!projectId || !secret) return NextResponse.json({ error: "webhook_auth_missing", referenceId }, { status: 401 });
    const payload = await readPayload(request);
    const runToken = String(payload.run_token ?? "").trim();
    const dataReady = String(payload.data_ready ?? "1").toLowerCase();
    if (!runToken) return NextResponse.json({ error: "run_token_missing", referenceId }, { status: 422 });
    if (!["1", "true", "yes"].includes(dataReady)) return NextResponse.json({ accepted: true, ignored: true, referenceId }, { status: 202 });

    const admin = createAdminClient();
    const env = serverEnv();
    const project = await admin.from("parsehub_projects")
      .select("id,tenant_id,import_profile_id,webhook_secret_hash,active")
      .eq("id", projectId).eq("active", true).maybeSingle();
    if (project.error || !project.data?.webhook_secret_hash) return NextResponse.json({ error: "webhook_project_not_found", referenceId }, { status: 404 });
    const calculated = sha256(`${secret}:${env.KUNDEXA_WEBHOOK_PEPPER}`);
    if (!constantTimeEquals(calculated, project.data.webhook_secret_hash)) return NextResponse.json({ error: "webhook_auth_invalid", referenceId }, { status: 401 });

    const runTokenHash = sha256(runToken);
    const idempotencyKey = sha256(`${project.data.tenant_id}:${project.data.id}:${runTokenHash}:data`);
    const inserted = await admin.from("parsehub_runs").upsert({
      tenant_id: project.data.tenant_id,
      parsehub_project_id: project.data.id,
      import_profile_id: project.data.import_profile_id,
      run_token_hash: runTokenHash,
      run_token_ciphertext: encryptJson({ runToken }, env.KUNDEXA_ENCRYPTION_KEY),
      idempotency_key: idempotencyKey,
      status: "queued",
      webhook_received_at: new Date().toISOString(),
      next_attempt_at: new Date().toISOString(),
      metadata: { dataReady: true },
    }, { onConflict: "tenant_id,idempotency_key", ignoreDuplicates: true }).select("id,status").maybeSingle();
    if (inserted.error) throw new Error(inserted.error.message);
    return NextResponse.json({ accepted: true, duplicate: !inserted.data, referenceId }, { status: 202 });
  } catch {
    return NextResponse.json({ error: "webhook_processing_failed", referenceId }, { status: 500 });
  }
}
