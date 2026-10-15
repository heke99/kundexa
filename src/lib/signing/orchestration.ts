import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { DocuSealSigningProvider } from "./docuseal";
import type { CreateEnvelopeInput, VerifiedSigningEvent } from "./provider";
import { parseSignaturePolicy } from "./policy";
import { createAdminClient } from "@/lib/supabase/admin";
import { canonicalAppBaseUrl, serverEnv } from "@/lib/env";
import { decryptJson, encryptJson, randomToken, sha256 } from "@/lib/crypto";
import { stableJson, hashPdfBytes } from "@/lib/contracts/document-hash";
import { ensureCanonicalContractDocument } from "@/lib/contracts/canonical-document";
import { validatePdfTemplate, type FrozenPdfTemplate } from "@/lib/contracts/pdf-field-template";
import { renderContractDeliveryEmail } from "@/lib/email/templates/contract-delivery";
import { toJson } from "@/lib/supabase/json";

const configSchema = z.object({
  DOCUSEAL_API_URL: z.url(), DOCUSEAL_SIGNING_URL: z.url(), DOCUSEAL_API_KEY: z.string().min(1),
  DOCUSEAL_WEBHOOK_HEADER_NAME: z.string().default("x-kundexa-signing-secret"), DOCUSEAL_WEBHOOK_SECRET: z.string().min(32),
  DOCUSEAL_DOCUMENT_ORIGINS: z.string().min(1),
});
export function docusealProvider() {
  const config = configSchema.parse(process.env);
  return new DocuSealSigningProvider({ baseUrl: config.DOCUSEAL_API_URL, signingBaseUrl: config.DOCUSEAL_SIGNING_URL,
    apiKey: config.DOCUSEAL_API_KEY, webhookUrl: `${canonicalAppBaseUrl()}/api/webhooks/docuseal`, webhookHeaderName: config.DOCUSEAL_WEBHOOK_HEADER_NAME,
    webhookHeaderSecret: config.DOCUSEAL_WEBHOOK_SECRET, documentOrigins: config.DOCUSEAL_DOCUMENT_ORIGINS.split(",").map((item) => new URL(item.trim()).origin) });
}
export function docusealConfigured() {
  try { docusealProvider(); return true; } catch { return false; }
}
export const externalSigningSchema = z.object({
  contractId: z.uuid(), recipientName: z.string().trim().min(2).max(200), email: z.email().transform((value) => value.toLowerCase()),
  expiresAt: z.iso.datetime(), idempotencyKey: z.string().min(8).max(200),
});
export async function beginExternalSigning(tenantId: string, actorId: string, raw: z.input<typeof externalSigningSchema>) {
  const input = externalSigningSchema.parse(raw);
  if (!docusealConfigured()) throw new Error("signing_provider_not_configured");
  const env = serverEnv();
  if (!env.RESEND_API_KEY || !env.DEFAULT_EMAIL_FROM_ADDRESS) throw new Error("platform_email_not_configured");
  z.email().parse(env.DEFAULT_EMAIL_FROM_ADDRESS);
  const admin: SupabaseClient = createAdminClient();
  const document = await ensureCanonicalContractDocument(admin, { tenantId, actorUserId: actorId, contractId: input.contractId });
  const token = randomToken();
  const payload = { tenant_id: tenantId, actor_id: actorId, contract_id: input.contractId, recipient_name: input.recipientName, email: input.email,
    expires_at: input.expiresAt, request_key: sha256(input.idempotencyKey), request_hash: sha256(stableJson(input)),
    source_document_id: document.id, source_sha256: document.sha256,
    public_token_hash: sha256(token + env.KUNDEXA_WEBHOOK_PEPPER), public_token_ciphertext: encryptJson({ token }, env.KUNDEXA_ENCRYPTION_KEY) };
  const { data, error } = await admin.rpc("reserve_docuseal_signing", { p_input: toJson(payload) });
  if (error || !data) throw new Error(error?.message ?? "signing_reservation_failed");
  return continueExternalSigning(String(data.id));
}

/** The idempotent isolated-template endpoint may be retried. Only the durable
 * submission-claim winner may send the one non-idempotent submission POST. */
export async function continueExternalSigning(envelopeId: string) {
  const admin: SupabaseClient = createAdminClient();
  const provider = docusealProvider();
  const { data: envelope, error } = await admin.from("signing_envelopes").select("*").eq("id", envelopeId).eq("provider", "docuseal").single();
  if (error || !envelope) throw new Error("signing_envelope_not_found");
  if (envelope.provider_envelope_id) return { envelopeId, status: envelope.status, replay: true };
  if (envelope.status !== "creating") throw new Error("signing_envelope_not_creating");
  const evidence = envelope.provider_evidence as Record<string, string>;
  if (Date.parse(evidence.expires_at) <= Date.now()) throw new Error("signing_expired");
  const [{ data: version, error: versionError }, { data: source, error: sourceError }, { data: recipients, error: recipientError }] = await Promise.all([
    admin.from("contract_versions").select("commercial_terms").eq("tenant_id", envelope.tenant_id).eq("id", envelope.contract_version_id).single(),
    admin.from("contract_documents").select("id,sha256,storage_path,file_name").eq("tenant_id", envelope.tenant_id).eq("id", evidence.source_document_id).eq("contract_version_id", envelope.contract_version_id).single(),
    admin.from("signing_recipients").select("id,contract_recipient_id,role,required,signing_order").eq("tenant_id", envelope.tenant_id).eq("envelope_id", envelope.id),
  ]);
  if (versionError || sourceError || recipientError || !source || source.sha256 !== evidence.source_sha256 || recipients?.length !== 1) throw new Error("signing_source_binding_invalid");
  const frozen = (version?.commercial_terms as Record<string, unknown>)?.pdf_fields as FrozenPdfTemplate;
  const template = validatePdfTemplate(frozen?.template, envelope.tenant_id);
  const signatures = template.fields.filter((field) => field.type === "signature");
  if (!signatures.length || signatures.some((field) => !field.required)) throw new Error("required_signature_fields_missing");
  const { data: blob, error: downloadError } = await admin.storage.from("contract-documents").download(source.storage_path);
  if (downloadError || !blob) throw new Error("signing_source_download_failed");
  const pdfBytes = new Uint8Array(await blob.arrayBuffer());
  if (hashPdfBytes(pdfBytes) !== evidence.source_sha256) throw new Error("signing_source_hash_mismatch");
  const isolated = await provider.provisionIsolatedTemplate({ pdfBytes, sourceSha256: evidence.source_sha256, externalKey: envelope.id,
    fields: signatures, role: "signer", createMode: "initial" });
  const { data: submissionInitial, error: claimError } = await admin.rpc("claim_docuseal_submission", { p_envelope_id: envelope.id, p_template_id: isolated.providerTemplateId });
  if (claimError) throw new Error("signing_submission_claim_failed");
  const request: CreateEnvelopeInput = {
    tenantId: envelope.tenant_id, contractId: envelope.contract_id, contractVersionId: envelope.contract_version_id,
    sourceDocumentId: source.id, idempotencyKey: envelope.id, policy: parseSignaturePolicy(envelope.signature_policy),
    callbackUrl: `${canonicalAppBaseUrl()}/api/webhooks/docuseal`, providerTemplateId: isolated.providerTemplateId,
    createMode: submissionInitial === true ? "initial" : "reconcile_only", expiresAt: evidence.expires_at,
    recipients: [{ recipientId: recipients[0].id, fullName: evidence.recipient_name, email: evidence.email, role: "signer", required: true, signingOrder: 1 }],
  };
  const result = await provider.createEnvelope(request);
  const env = serverEnv();
  const token = decryptJson<{ token: string }>(evidence.public_token_ciphertext, env.KUNDEXA_ENCRYPTION_KEY).token;
  const { data: contract, error: contractError } = await admin.from("contracts").select("contract_number,title,seller_snapshot").eq("tenant_id", envelope.tenant_id).eq("id", envelope.contract_id).single();
  if (contractError || !contract) throw new Error("signing_contract_read_failed");
  const seller = contract.seller_snapshot as Record<string, unknown>;
  const rendered = renderContractDeliveryEmail({ legalName: String(seller?.legal_name ?? "Avsändaren"), customerName: evidence.recipient_name,
    contractNumber: contract.contract_number, contractTitle: contract.title, acceptUrl: `${canonicalAppBaseUrl()}/sign/${token}`,
    expiresAt: new Intl.DateTimeFormat("sv-SE", { dateStyle: "long", timeStyle: "short", timeZone: "Europe/Stockholm" }).format(new Date(evidence.expires_at)) });
  const { data, error: commitError } = await admin.rpc("commit_docuseal_invitation", { p_input: toJson({ envelope_id: envelope.id,
    provider_envelope_id: result.providerEnvelopeId, provider_recipient_id: result.recipients[0].providerRecipientId,
    provider_template_id: isolated.providerTemplateId, email_from: env.DEFAULT_EMAIL_FROM_ADDRESS, ...rendered,
    attachments: [{ document_id: source.id, filename: source.file_name, mime_type: "application/pdf" }] }) });
  if (commitError) throw new Error(commitError.message);
  return { envelopeId: envelope.id as string, status: "sent", replay: Boolean(data?.idempotent_replay) };
}

export async function reconcileExternalSigning(event: VerifiedSigningEvent) {
  const admin: SupabaseClient = createAdminClient();
  const { data: envelope, error } = await admin.from("signing_envelopes").select("*").eq("provider", "docuseal").eq("provider_envelope_id", event.providerEnvelopeId).single();
  if (error || !envelope) throw new Error("signing_envelope_unmatched");
  const provider = docusealProvider();
  const status = await provider.fetchEnvelope(event.providerEnvelopeId);
  const { data: recipients, error: recipientError } = await admin.from("signing_recipients").select("id,provider_recipient_id").eq("tenant_id", envelope.tenant_id).eq("envelope_id", envelope.id);
  const submitters = (status.evidence?.submitters ?? []) as Array<{ id: number; email?: string; completed_at?: string }>;
  const evidence = envelope.provider_evidence as Record<string, string>;
  if (recipientError || recipients?.length !== 1 || submitters.length !== 1 || String(submitters[0].id) !== recipients[0].provider_recipient_id || submitters[0].email?.toLowerCase() !== evidence.email) throw new Error("signing_provider_recipient_mismatch");
  if (status.status !== "completed") {
    const { error: eventError } = await admin.from("signing_events").upsert({ tenant_id: envelope.tenant_id, envelope_id: envelope.id,
      provider: "docuseal", provider_event_id: event.providerEventId, event_type: event.eventType, event_at: event.eventAt,
      verified: true, processing_status: "processed", payload: toJson({ signal: event.payload, server_status: status.status }) }, { onConflict: "provider,provider_event_id" });
    if (eventError) throw new Error("signing_event_write_failed");
    if (["cancelled", "expired", "declined"].includes(status.status)) {
      const { error: updateError } = await admin.from("signing_envelopes").update({ status: status.status }).eq("id", envelope.id).neq("status", "completed");
      if (updateError) throw new Error("signing_status_write_failed");
    }
    return { status: status.status };
  }
  if (!status.completedAt || !submitters[0].completed_at || Date.parse(status.completedAt) > Date.parse(evidence.expires_at)) throw new Error("signing_completion_invalid");
  const [bytes, auditBytes] = await Promise.all([provider.fetchFinalDocument(event.providerEnvelopeId), provider.fetchAuditDocument(event.providerEnvelopeId)]);
  const auditHash = hashPdfBytes(auditBytes);
  const auditPath = `${envelope.tenant_id}/${envelope.contract_id}/${envelope.contract_version_id}/provider-audit-${envelope.id}-${auditHash}.pdf`;
  const { error: auditUploadError } = await admin.storage.from("contract-documents").upload(auditPath, auditBytes, { contentType: "application/pdf", upsert: false });
  if (auditUploadError) {
    const { data: existingAudit, error: auditReadError } = await admin.storage.from("contract-documents").download(auditPath);
    if (auditReadError || !existingAudit || hashPdfBytes(new Uint8Array(await existingAudit.arrayBuffer())) !== auditHash) throw new Error("signing_provider_audit_storage_failed");
  }
  const hash = hashPdfBytes(bytes);
  const path = `${envelope.tenant_id}/${envelope.contract_id}/${envelope.contract_version_id}/signing-${envelope.id}-${hash}.pdf`;
  const { error: uploadError } = await admin.storage.from("contract-documents").upload(path, bytes, { contentType: "application/pdf", upsert: false });
  if (uploadError) {
    const { data: existing, error: existingError } = await admin.storage.from("contract-documents").download(path);
    if (existingError || !existing || hashPdfBytes(new Uint8Array(await existing.arrayBuffer())) !== hash) throw new Error("signing_final_storage_failed");
  }
  const { data, error: finalError } = await admin.rpc("complete_docuseal_signing", { p_input: toJson({ envelope_id: envelope.id,
    provider_envelope_id: event.providerEnvelopeId, provider_recipient_id: recipients[0].provider_recipient_id,
    source_sha256: evidence.source_sha256, storage_path: path, sha256: hash, size_bytes: bytes.length, completed_at: status.completedAt,
    audit_storage_path: auditPath, audit_sha256: auditHash, audit_size_bytes: auditBytes.length,
    event_id: event.providerEventId, evidence: { signal: event.payload, server: status.evidence, final_sha256: hash } }) });
  if (finalError) throw new Error(finalError.message);
  return data;
}
