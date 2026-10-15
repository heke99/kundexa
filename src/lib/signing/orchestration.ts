import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { canonicalAppBaseUrl, serverEnv } from "@/lib/env";
import { decryptJson, encryptJson, randomToken, sha256 } from "@/lib/crypto";
import { stableJson, hashPdfBytes } from "@/lib/contracts/document-hash";
import { ensureCanonicalContractDocument } from "@/lib/contracts/canonical-document";
import { validatePdfTemplate, type FrozenPdfTemplate } from "@/lib/contracts/pdf-field-template";
import { renderContractDeliveryEmail } from "@/lib/email/templates/contract-delivery";
import { toJson } from "@/lib/supabase/json";
import { inspectNativeSignaturePng, validateNativeSignerText, renderNativeSignedPdf, renderNativeAuditPdf, type NativeSigningReceipt } from "./native-document";

export const NATIVE_SIGNING_CONSENT = "Jag har granskat avtalet och vill underteckna det med min ritade underskrift. Detta är en enkel elektronisk signatur utan BankID.";
export function nativeSigningConfigured() {
  try { const env = serverEnv(); return Boolean(env.RESEND_API_KEY && z.email().safeParse(env.DEFAULT_EMAIL_FROM_ADDRESS).success); } catch { return false; }
}
export const nativeSigningSchema = z.object({ contractId: z.uuid(), recipientName: z.string().trim().min(2).max(200), email: z.email().transform(value => value.toLowerCase()), expiresAt: z.iso.datetime(), idempotencyKey: z.string().min(8).max(200) });
export async function beginNativeSigning(tenantId: string, actorId: string, raw: z.input<typeof nativeSigningSchema>) {
  const input = nativeSigningSchema.parse(raw);
  if (!nativeSigningConfigured()) throw new Error("platform_email_not_configured");
  const env = serverEnv();
  const admin: SupabaseClient = createAdminClient();
  const document = await ensureCanonicalContractDocument(admin, { tenantId, actorUserId: actorId, contractId: input.contractId });
  const token = randomToken();
  const { data, error } = await admin.rpc("reserve_native_signing", { p_input: toJson({ tenant_id: tenantId, actor_id: actorId, contract_id: input.contractId,
    recipient_name: input.recipientName, email: input.email, expires_at: input.expiresAt, request_key: sha256(input.idempotencyKey), request_hash: sha256(stableJson(input)),
    source_document_id: document.id, source_sha256: document.sha256, public_token_hash: sha256(token + env.KUNDEXA_WEBHOOK_PEPPER),
    public_token_ciphertext: encryptJson({ token }, env.KUNDEXA_ENCRYPTION_KEY) }) });
  if (error || !data) throw new Error(error?.message ?? "signing_reservation_failed");
  return continueNativeSigning(String(data.id));
}
// The API's offered external_esign method is implemented by Kundexa's local engine.
export const beginExternalSigning = beginNativeSigning;

type NativeEnvelope = { id: string; tenant_id: string; contract_id: string; contract_version_id: string; generation: number; status: string; provider_evidence: Record<string, unknown> };
async function readEnvelope(admin: SupabaseClient, envelopeId: string): Promise<NativeEnvelope> {
  const { data, error } = await admin.from("signing_envelopes").select("*").eq("id", envelopeId).eq("provider", "kundexa_native").single();
  if (error || !data) throw new Error("signing_envelope_not_found");
  return data as NativeEnvelope;
}
async function sourceMaterial(admin: SupabaseClient, envelope: NativeEnvelope) {
  const evidence = envelope.provider_evidence;
  const [{ data: source, error }, { data: version, error: versionError }] = await Promise.all([
    admin.from("contract_documents").select("id,sha256,storage_path,file_name,metadata").eq("tenant_id", envelope.tenant_id).eq("contract_id", envelope.contract_id).eq("contract_version_id", envelope.contract_version_id).eq("id", String(evidence.source_document_id)).single(),
    admin.from("contract_versions").select("commercial_terms").eq("tenant_id", envelope.tenant_id).eq("id", envelope.contract_version_id).single(),
  ]);
  if (error || versionError || !source || source.sha256 !== evidence.source_sha256) throw new Error("signing_source_binding_invalid");
  const frozen = (version?.commercial_terms as Record<string, unknown>)?.pdf_fields as FrozenPdfTemplate;
  const template = validatePdfTemplate(frozen?.template, envelope.tenant_id);
  if (!template.fields.some(field => field.type === "signature" && field.required)) throw new Error("required_signature_fields_missing");
  const { data: blob, error: downloadError } = await admin.storage.from("contract-documents").download(source.storage_path);
  if (downloadError || !blob) throw new Error("signing_source_download_failed");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (hashPdfBytes(bytes) !== source.sha256) throw new Error("signing_source_hash_mismatch");
  return { source, bytes, template };
}

export async function continueNativeSigning(envelopeId: string) {
  const admin: SupabaseClient = createAdminClient();
  const envelope = await readEnvelope(admin, envelopeId);
  if (envelope.status === "completed") return { envelopeId, status: "signed", replay: true };
  if (envelope.provider_evidence.native_signature) {
    await finalizeNativeReceipt(envelope);
    return { envelopeId, status: "signed", replay: true };
  }
  if (Date.parse(String(envelope.provider_evidence.expires_at)) <= Date.now() && ["creating", "sent", "partially_signed"].includes(envelope.status)) {
    const { data: expired, error: expireError } = await admin.rpc("expire_native_signing", { p_envelope_id: envelope.id });
    if (expireError) throw new Error("signing_expiry_write_failed");
    if (expired) return { envelopeId, status: "expired", replay: true };
    // A concurrent signature claim may have won the row lock. Re-read its
    // immutable receipt before deciding whether any work remains.
    const current = await readEnvelope(admin, envelopeId);
    if (current.provider_evidence.native_signature) {
      await finalizeNativeReceipt(current);
      return { envelopeId, status: "signed", replay: true };
    }
    return { envelopeId, status: current.status, replay: true };
  }
  if (envelope.status !== "creating") return { envelopeId, status: envelope.status, replay: true };
  const evidence = envelope.provider_evidence;
  const { source } = await sourceMaterial(admin, envelope);
  const env = serverEnv();
  if (!nativeSigningConfigured()) throw new Error("platform_email_not_configured");
  const token = decryptJson<{ token: string }>(String(evidence.public_token_ciphertext), env.KUNDEXA_ENCRYPTION_KEY).token;
  const { data: contract, error } = await admin.from("contracts").select("contract_number,title").eq("tenant_id", envelope.tenant_id).eq("id", envelope.contract_id).single();
  if (error || !contract) throw new Error("signing_contract_read_failed");
  const seller = (source.metadata as { locked_parties?: { seller?: { legal_name?: string } } })?.locked_parties?.seller;
  if (!seller?.legal_name) throw new Error("signing_source_locked_parties_required");
  const rendered = renderContractDeliveryEmail({ legalName: seller.legal_name, customerName: String(evidence.recipient_name), contractNumber: contract.contract_number,
    contractTitle: contract.title, acceptUrl: `${canonicalAppBaseUrl()}/sign/${token}`,
    expiresAt: new Intl.DateTimeFormat("sv-SE", { dateStyle: "long", timeStyle: "short", timeZone: "Europe/Stockholm" }).format(new Date(String(evidence.expires_at))) });
  const { data, error: commitError } = await admin.rpc("commit_native_invitation", { p_input: toJson({ envelope_id: envelope.id, email_from: env.DEFAULT_EMAIL_FROM_ADDRESS,
    ...rendered, attachments: [{ document_id: source.id, filename: source.file_name, mime_type: "application/pdf" }] }) });
  if (commitError) throw new Error(commitError.message);
  return { envelopeId, status: "sent", replay: Boolean(data?.idempotent_replay) };
}

export async function nativeSigningSession(token: string) {
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(token)) throw new Error("signing_link_invalid");
  const admin: SupabaseClient = createAdminClient();
  const tokenHash = sha256(token + serverEnv().KUNDEXA_WEBHOOK_PEPPER);
  const { data, error } = await admin.from("signing_envelopes").select("*").eq("provider", "kundexa_native").contains("provider_evidence", { public_token_hash: tokenHash }).single();
  if (error || !data) throw new Error("signing_link_invalid");
  const envelope = data as NativeEnvelope;
  if (!["sent", "partially_signed", "completed"].includes(envelope.status)) throw new Error("signing_link_inactive");
  const evidence = envelope.provider_evidence;
  if (!evidence.native_signature && Date.parse(String(evidence.expires_at)) <= Date.now()) throw new Error("signing_expired");
  const [{ data: tenant }, { data: contract }] = await Promise.all([
    admin.from("tenants").select("status").eq("id", envelope.tenant_id).single(),
    admin.from("contracts").select("title,active_version_id,acceptance_generation").eq("tenant_id", envelope.tenant_id).eq("id", envelope.contract_id).single(),
  ]);
  if (!tenant || !["active", "trial"].includes(tenant.status) || !contract || contract.active_version_id !== envelope.contract_version_id || contract.acceptance_generation !== envelope.generation) throw new Error("signing_link_inactive");
  return { envelope, tokenHash, title: String(contract.title), recipientName: String(evidence.recipient_name), completed: envelope.status === "completed" };
}
export async function nativeSigningDocument(token: string) {
  const session = await nativeSigningSession(token);
  const admin = createAdminClient();
  const { data: allowed, error: limitError } = await admin.rpc("consume_rate_limit", { p_tenant_id: session.envelope.tenant_id, p_bucket: `native-preview:${session.envelope.id}`, p_limit: 60, p_window_seconds: 60 });
  if (limitError || !allowed) throw new Error("signing_rate_limited");
  const material = await sourceMaterial(admin, session.envelope);
  return material.bytes;
}

export const nativeSignatureSubmissionSchema = z.object({ signerName: z.string().trim().min(2).max(200), consent: z.literal(true), signaturePng: z.string().max(750_000), idempotencyKey: z.uuid() }).strict();
async function persistPrivate(admin: SupabaseClient, path: string, bytes: Uint8Array, contentType: string) {
  const hash = hashPdfBytes(bytes);
  const { error } = await admin.storage.from("contract-documents").upload(path, bytes, { contentType, upsert: false });
  if (error) {
    const { data: existing, error: readError } = await admin.storage.from("contract-documents").download(path);
    if (readError || !existing || hashPdfBytes(new Uint8Array(await existing.arrayBuffer())) !== hash) throw new Error("signing_artifact_storage_failed");
  }
  return hash;
}
export async function submitNativeSignature(token: string, raw: unknown, metadata: { ipAddress: string | null; userAgent: string | null }) {
  const input = nativeSignatureSubmissionSchema.parse(raw);
  const session = await nativeSigningSession(token);
  const admin: SupabaseClient = createAdminClient();
  const { data: allowed, error: rateError } = await admin.rpc("consume_rate_limit", { p_tenant_id: session.envelope.tenant_id, p_bucket: `native-sign:${session.envelope.id}`, p_limit: 10, p_window_seconds: 60 });
  if (rateError || !allowed) throw new Error("signing_rate_limited");
  if (input.signerName !== session.recipientName) throw new Error("signing_recipient_name_mismatch");
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(input.signaturePng);
  if (!match) throw new Error("signature_png_required");
  const png = new Uint8Array(Buffer.from(match[1], "base64"));
  if (png.length < 60 || png.length > 512 * 1024 || Buffer.from(png).toString("base64") !== match[1]) throw new Error("signature_png_invalid");
  inspectNativeSignaturePng(png);
  await validateNativeSignerText(input.signerName, NATIVE_SIGNING_CONSENT);
  const envelope = session.envelope;
  const signatureHash = hashPdfBytes(png);
  const signaturePath = `${envelope.tenant_id}/${envelope.contract_id}/${envelope.contract_version_id}/signatures/${signatureHash}.png`;
  await persistPrivate(admin, signaturePath, png, "image/png");
  const requestHash = sha256(stableJson({ source_sha256: envelope.provider_evidence.source_sha256, signature_sha256: signatureHash, signer_name: input.signerName, consent: NATIVE_SIGNING_CONSENT }));
  const { data: claimed, error } = await admin.rpc("claim_native_signature", { p_input: toJson({ envelope_id: envelope.id, public_token_hash: session.tokenHash,
    request_key: input.idempotencyKey, request_hash: requestHash, source_sha256: envelope.provider_evidence.source_sha256,
    signature_sha256: signatureHash, signature_storage_path: signaturePath, signer_name: input.signerName, consent: true,
    ip_address: metadata.ipAddress, user_agent: metadata.userAgent?.slice(0,1000) ?? null }) });
  if (error || !claimed) throw new Error(error?.message ?? "signature_claim_failed");
  const persisted = claimed.provider_evidence ? claimed as NativeEnvelope : await readEnvelope(admin, envelope.id);
  await finalizeNativeReceipt(persisted);
  return { status: "signed" as const };
}

export async function finalizeNativeReceipt(envelope: NativeEnvelope) {
  const admin: SupabaseClient = createAdminClient();
  const receipt = envelope.provider_evidence.native_signature as Record<string, unknown> | undefined;
  if (!receipt) throw new Error("signature_receipt_required");
  const { bytes: sourceBytes, template } = await sourceMaterial(admin, envelope);
  const { data: signature, error } = await admin.storage.from("contract-documents").download(String(receipt.signature_storage_path));
  if (error || !signature) throw new Error("signature_receipt_image_missing");
  const signatureBytes = new Uint8Array(await signature.arrayBuffer());
  if (hashPdfBytes(signatureBytes) !== receipt.signature_sha256) throw new Error("signature_receipt_image_hash_mismatch");
  const renderedReceipt: NativeSigningReceipt = { receiptId: String(receipt.receipt_id), envelopeId: envelope.id, tenantId: envelope.tenant_id,
    contractId: envelope.contract_id, contractVersionId: envelope.contract_version_id, generation: envelope.generation,
    sourceSha256: String(receipt.source_sha256), signatureSha256: String(receipt.signature_sha256), signerName: String(receipt.signer_name),
    acceptedAt: String(receipt.accepted_at), consent: String(receipt.acceptance_text), requestKey: String(receipt.request_key), requestHash: String(receipt.request_hash) };
  const signedBytes = await renderNativeSignedPdf({ sourceBytes, signaturePngBytes: signatureBytes, receipt: renderedReceipt, template });
  const signedHash = hashPdfBytes(signedBytes);
  const auditBytes = await renderNativeAuditPdf({ ...renderedReceipt, finalSha256: signedHash });
  const prefix = `${envelope.tenant_id}/${envelope.contract_id}/${envelope.contract_version_id}`;
  const auditHash = hashPdfBytes(auditBytes);
  const signedPath = `${prefix}/native/${String(receipt.receipt_id)}/signed.pdf`; const auditPath = `${prefix}/native/${String(receipt.receipt_id)}/audit.pdf`;
  await Promise.all([persistPrivate(admin, signedPath, signedBytes, "application/pdf"), persistPrivate(admin, auditPath, auditBytes, "application/pdf")]);
  const { data, error: finalError } = await admin.rpc("finalize_native_signature", { p_input: toJson({ envelope_id: envelope.id, public_token_hash: envelope.provider_evidence.public_token_hash,
    request_key: receipt.request_key, request_hash: receipt.request_hash, receipt_id: receipt.receipt_id,
    source_sha256: receipt.source_sha256, signature_sha256: receipt.signature_sha256,
    storage_path: signedPath, sha256: signedHash, size_bytes: signedBytes.length, audit_storage_path: auditPath, audit_sha256: auditHash, audit_size_bytes: auditBytes.length }) });
  if (finalError) throw new Error(finalError.message);
  return data;
}
