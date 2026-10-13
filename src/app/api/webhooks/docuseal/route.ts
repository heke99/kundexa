import { createAdminClient } from "@/lib/supabase/admin";
import { docusealProvider, reconcileDocusealEnvelope } from "@/lib/signing/docuseal";

export async function POST(request: Request) {
  if (Number(request.headers.get("content-length") ?? 0) > 64_000) return new Response(null, { status: 413 });
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.length > 64_000) return new Response(null, { status: 413 });
  let event;
  try { event = docusealProvider.verifyWebhook(body, request.headers); }
  catch { return Response.json({ error: "invalid_signature" }, { status: 403 }); }
  const db = createAdminClient();
  const { data: envelope, error } = await db.from("signing_envelopes").select("id,tenant_id")
    .eq("provider", "docuseal").eq("provider_envelope_id", event.providerEnvelopeId).maybeSingle();
  if (error || !envelope) return Response.json({ error: "envelope_not_registered" }, { status: 503 });
  try { await reconcileDocusealEnvelope(envelope.tenant_id, envelope.id); return Response.json({ received: true }); }
  catch { return Response.json({ error: "reconciliation_failed" }, { status: 503 }); }
}
