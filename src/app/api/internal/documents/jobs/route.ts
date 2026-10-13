import { z } from "zod";
import { serverEnv } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { docusealProvider, reconcileDocusealEnvelope, sendDocusealEnvelope } from "@/lib/signing/docuseal";

export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: Request) {
  const secret = serverEnv().CRON_SECRET;
  if (!secret || request.headers.get("x-cron-secret") !== secret) return Response.json({ error: "forbidden" }, { status: 403 });
  try {
    const { jobId } = z.object({ jobId: z.uuid() }).parse(await request.json());
    const db = createAdminClient();
    const { data: job, error } = await db.from("outbox_jobs").select("*").eq("id", jobId).eq("status", "processing").single();
    if (error || !job || !["docuseal.send","docuseal.reconcile","docuseal.cancel"].includes(job.job_type))
      return Response.json({ error: "claimed_documents_job_required" }, { status: 409 });
    const envelopeId = String((job.payload as Record<string,unknown>).envelope_id ?? "");
    z.uuid().parse(envelopeId);
    if (job.job_type === "docuseal.send") await sendDocusealEnvelope(job.tenant_id, envelopeId);
    else if (job.job_type === "docuseal.cancel") {
      const { data: envelope, error: envelopeError } = await db.from("signing_envelopes").select("provider_envelope_id,status")
        .eq("tenant_id", job.tenant_id).eq("id", envelopeId).eq("provider","docuseal").single();
      if (envelopeError || !envelope) throw new Error("signing_envelope_missing");
      if (envelope.status === "completed") return Response.json({ completed: true });
      if (envelope.provider_envelope_id) await docusealProvider.cancelEnvelope(envelope.provider_envelope_id);
      const saved = await db.from("signing_envelopes").update({ status: "cancelled", cancelled_at: new Date().toISOString() })
        .eq("tenant_id", job.tenant_id).eq("id", envelopeId).neq("status","completed");
      if (saved.error) throw new Error(saved.error.message);
    }
    else {
      const result = await reconcileDocusealEnvelope(job.tenant_id, envelopeId);
      if (!result.completed) return Response.json({ pending: true });
    }
    return Response.json({ completed: true });
  } catch (error) {
    console.error("documents_job_failed", { error: error instanceof Error ? error.message : "unknown" });
    return Response.json({ error: "documents_job_failed" }, { status: 502 });
  }
}
