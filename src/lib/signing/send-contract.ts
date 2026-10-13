import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptJson, randomToken, sha256 } from "@/lib/crypto";
import { serverEnv } from "@/lib/env";
import { ensureCanonicalContractDocument } from "@/lib/contracts/canonical-document";
import { contractDeliveryBlocker } from "@/lib/contracts/delivery-readiness";
import { documentsConfiguration } from "./docuseal-client";

export async function usesDocuseal(db: SupabaseClient, tenantId: string, contractId: string) {
  const { data: contract, error } = await db.from("contracts").select("active_version_id")
    .eq("tenant_id", tenantId).eq("id", contractId).single();
  if (error || !contract) throw new Error("contract_not_found");
  const { data: version, error: versionError } = await db.from("contract_versions").select("signature_policy_snapshot")
    .eq("tenant_id", tenantId).eq("id", contract.active_version_id).single();
  if (versionError || !version) throw new Error("contract_version_not_found");
  return (version.signature_policy_snapshot as Record<string,unknown> | null)?.method === "external_esign";
}

export async function queueDocusealContract(db: SupabaseClient, input: {
  tenantId: string; actorUserId: string; contractId: string; name?: string; email?: string;
  channel: string; expiresAt: string; idempotencyKey: string; serviceContext?: boolean;
}) {
  documentsConfiguration();
  if (input.channel !== "email") throw new Error("pdf_signing_email_channel_required");
  const admin = createAdminClient(); const env = serverEnv();
  if (!env.RESEND_API_KEY || !env.DEFAULT_EMAIL_FROM_ADDRESS) throw new Error("email_not_configured");
  const blocker = await contractDeliveryBlocker(admin, input.tenantId, "email");
  if (blocker) throw new Error(blocker.message);
  const { data: contract, error } = await db.from("contracts").select("counterparty_snapshot")
    .eq("tenant_id", input.tenantId).eq("id", input.contractId).single();
  if (error || !contract) throw new Error("contract_access_denied");
  const customer = contract.counterparty_snapshot as Record<string, unknown>;
  const name = input.name || String(customer.display_name ?? "");
  const email = (input.email || String(customer.email ?? "")).toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email) || name.length < 2) throw new Error("valid_email_recipient_required");
  const canonical = await ensureCanonicalContractDocument(admin, { tenantId: input.tenantId,
    contractId: input.contractId, actorUserId: input.actorUserId });
  const token = randomToken();
  const requestHash = sha256(JSON.stringify({ contractId: input.contractId, name, email,
    channel: "email", expiresAt: input.expiresAt, documentId: canonical.id }));
  const { data, error: queueError } = await db.rpc("prepare_docuseal_signing", {
    p_contract_id: input.contractId, p_document_id: canonical.id, p_recipient_name: name, p_email: email,
    p_expires_at: input.expiresAt, p_token_hash: sha256(token + env.KUNDEXA_WEBHOOK_PEPPER),
    p_token_ciphertext: encryptJson({ token }, env.KUNDEXA_ENCRYPTION_KEY),
    p_idempotency_key: input.idempotencyKey, p_request_hash: requestHash,
    ...(input.serviceContext ? { p_actor_user_id: input.actorUserId, p_tenant_id: input.tenantId } : {}),
  });
  if (queueError) throw new Error(queueError.message);
  return data as unknown as { envelope_id: string; contract_id: string; generation: number; idempotent_replay: boolean };
}
