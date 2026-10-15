import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { serverEnv } from "@/lib/env";
import { sha256 } from "@/lib/crypto";
import { docusealProvider } from "@/lib/signing/orchestration";
export async function GET(_request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const refused = () => new NextResponse("Signeringslänken är inte tillgänglig. Kontakta avsändaren.", { status: 410, headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" } });
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(token)) return refused();
  try {
    const admin = createAdminClient();
    const tokenHash = sha256(token + serverEnv().KUNDEXA_WEBHOOK_PEPPER);
    const { data: envelope, error } = await admin.from("signing_envelopes").select("id,tenant_id,contract_id,contract_version_id,generation,status,provider_envelope_id,provider_evidence")
      .eq("provider", "docuseal").contains("provider_evidence", { public_token_hash: tokenHash }).single();
    if (error || !envelope || !["sent", "partially_signed"].includes(envelope.status) || !envelope.provider_envelope_id) return refused();
    const evidence = envelope.provider_evidence as Record<string, unknown>;
    if (Date.parse(String(evidence.expires_at)) <= Date.now()) return refused();
    const [{ data: contract }, { data: tenant }, { data: signer }] = await Promise.all([
      admin.from("contracts").select("active_version_id,acceptance_generation").eq("tenant_id", envelope.tenant_id).eq("id", envelope.contract_id).single(),
      admin.from("tenants").select("status").eq("id", envelope.tenant_id).single(),
      admin.from("signing_recipients").select("id,provider_recipient_id").eq("tenant_id", envelope.tenant_id).eq("envelope_id", envelope.id).single(),
    ]);
    if (!contract || !tenant || !["active", "trial"].includes(tenant.status) || contract.active_version_id !== envelope.contract_version_id || contract.acceptance_generation !== envelope.generation || !signer?.provider_recipient_id) return refused();
    const { data: allowed, error: rateError } = await admin.rpc("consume_rate_limit", { p_tenant_id: envelope.tenant_id, p_bucket: `signer-session:${envelope.id}`, p_limit: 10, p_window_seconds: 60 });
    if (rateError || !allowed) return refused();
    const session = await docusealProvider().createSignerSession({ providerEnvelopeId: envelope.provider_envelope_id, providerRecipientId: signer.provider_recipient_id, returnUrl: "", idempotencyKey: envelope.id });
    return NextResponse.redirect(session.url, { status: 303, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  } catch { return refused(); }
}
