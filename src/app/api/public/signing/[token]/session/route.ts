import { publicSigningLink } from "@/lib/signing/public-link";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSigningProvider } from "@/lib/signing/provider";
import { canonicalAppBaseUrl } from "@/lib/env";

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params; const result = await publicSigningLink(token);
  if (!result?.envelope.provider_envelope_id || result.envelope.status === "completed") return new Response(null, { status: 410 });
  const db = createAdminClient();
  const { data: allowed, error: rateError } = await db.rpc("consume_rate_limit", { p_tenant_id: result.link.tenant_id,
    p_bucket: `signing-session:${result.link.id}`, p_limit: 20, p_window_seconds: 60 });
  if (rateError || !allowed) return new Response(null, { status: rateError ? 503 : 429 });
  const { data: recipient } = await db.from("signing_recipients").select("provider_recipient_id")
    .eq("tenant_id", result.link.tenant_id).eq("envelope_id", result.envelope.id)
    .eq("contract_recipient_id", result.link.recipient_id).single();
  if (!recipient?.provider_recipient_id) return new Response(null, { status: 503 });
  const session = await getSigningProvider("docuseal").createSignerSession({ providerEnvelopeId: result.envelope.provider_envelope_id,
    providerRecipientId: recipient.provider_recipient_id, returnUrl: `${canonicalAppBaseUrl()}/sign/${token}`,
    idempotencyKey: `session:${result.link.id}` });
  return new Response(null, { status: 303, headers: { location: session.url, "cache-control": "private, no-store", "referrer-policy": "no-referrer" } });
}
