import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { canonicalAppBaseUrl, serverEnv } from "@/lib/env";
import { decryptJson, sha256Bytes } from "@/lib/crypto";
import { toJson } from "@/lib/supabase/json";
import { pdfConfigurationSchema } from "@/lib/contracts/pdf-template";
import { createEngineSubmission, documentsConfiguration, documentsRequest, downloadEnginePdf,
  engineDocuments, engineSubmission } from "./docuseal-client";
import type { CreateEnvelopeInput, SigningProvider, VerifiedSigningEvent } from "./provider";

export const docusealProvider: SigningProvider = {
  name: "docuseal",
  async createEnvelope(input: CreateEnvelopeInput) {
    const db = createAdminClient();
    const { data: source, error } = await db.from("contract_documents").select("metadata")
      .eq("tenant_id", input.tenantId).eq("contract_id", input.contractId)
      .eq("contract_version_id", input.contractVersionId).eq("id", input.sourceDocumentId).single();
    if (error || !source) throw new Error("signing_source_document_missing");
    const metadata = source.metadata as Record<string, unknown>;
    const config = pdfConfigurationSchema.parse(metadata.pdf_template);
    if (input.recipients.length !== 1 || !input.recipients[0].email) throw new Error("one_email_signer_required");
    const recipient = input.recipients[0];
    const signer = await createEngineSubmission({ key: input.idempotencyKey, templateId: config.template_id,
      schemaHash: config.schema_hash, role: config.role, name: recipient.fullName,
      email: recipient.email!, recipientId: recipient.recipientId,
      values: metadata.field_values as Record<string, string> });
    return { providerEnvelopeId: String(signer.submission_id), status: "sent",
      recipients: [{ recipientId: recipient.recipientId, providerRecipientId: String(signer.id) }] };
  },
  async createSignerSession(input) {
    const submission = await engineSubmission(Number(input.providerEnvelopeId));
    const signer = submission.submitters.find(item => String(item.id) === input.providerRecipientId);
    if (!signer) throw new Error("signing_recipient_not_found");
    return { url: `${documentsConfiguration().url}/s/${encodeURIComponent(signer.slug)}`,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() };
  },
  async cancelEnvelope(id) {
    // Archive alone does not revoke a known signer URL. Expire the order first.
    await documentsRequest(`/api/submissions/${id}`, { method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ expire_at: new Date(Date.now() - 1000).toISOString(), archived: true }) });
  },
  async fetchEnvelope(id) {
    const submission = await engineSubmission(Number(id));
    const status = submission.status === "completed" ? "completed" : submission.status === "declined" ? "declined"
      : submission.status === "expired" ? "expired" : submission.submitters.some(s => s.completed_at) ? "partially_signed" : "sent";
    return { providerEnvelopeId: String(submission.id), status, completedAt: submission.completed_at,
      evidence: { completed_at: submission.completed_at, signer_ids: submission.submitters.map(s => s.id) } };
  },
  async fetchFinalDocument(id) {
    const submission = await engineSubmission(Number(id));
    if (submission.status !== "completed") throw new Error("completed_signing_order_required");
    const documents = await engineDocuments(Number(id));
    if (documents.documents.length !== 1) throw new Error("merged_signed_document_required");
    return downloadEnginePdf(documents.documents[0].url);
  },
  verifyWebhook(rawBody, headers): VerifiedSigningEvent {
    const time = headers.get("x-kundexa-documents-timestamp") ?? "";
    const signature = headers.get("x-kundexa-documents-signature") ?? "";
    if (!/^\d+$/.test(time) || Math.abs(Date.now() / 1000 - Number(time)) > 300 || !/^[a-f0-9]{64}$/.test(signature))
      throw new Error("invalid_documents_event_signature");
    const expected = createHmac("sha256", documentsConfiguration().secret).update(time + ".").update(rawBody).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) throw new Error("invalid_documents_event_signature");
    const payload = JSON.parse(new TextDecoder().decode(rawBody)) as Record<string, unknown>;
    if (!Number.isInteger(payload.submission_id) || !payload.event_id) throw new Error("invalid_documents_event");
    return { providerEventId: String(payload.event_id), providerEnvelopeId: String(payload.submission_id),
      eventType: "submission.changed", eventAt: new Date(Number(time) * 1000).toISOString(), verified: true, payload };
  },
};

function must(error: { message: string } | null) { if (error) throw new Error(error.message); }

export async function sendDocusealEnvelope(tenantId: string, envelopeId: string) {
  const db = createAdminClient();
  const { data: envelope, error } = await db.from("signing_envelopes").select("*")
    .eq("tenant_id", tenantId).eq("id", envelopeId).eq("provider", "docuseal").single(); must(error);
  if (!envelope) throw new Error("signing_envelope_not_found");
  const { data: contract, error: contractError } = await db.from("contracts").select("*")
    .eq("tenant_id", tenantId).eq("id", envelope.contract_id).single(); must(contractError);
  if (!contract || contract.acceptance_generation !== envelope.generation || contract.active_version_id !== envelope.contract_version_id
    || ["cancelled","expired","superseded"].includes(contract.status)) {
    if (envelope.provider_envelope_id) await docusealProvider.cancelEnvelope(envelope.provider_envelope_id);
    return;
  }
  if (["cancelled","expired","declined","failed","completed"].includes(envelope.status)) return;
  const { data: recipients, error: recipientsError } = await db.from("signing_recipients")
    .select("*,contract_recipients(*)").eq("tenant_id", tenantId).eq("envelope_id", envelopeId); must(recipientsError);
  if (!recipients || recipients.length !== 1) throw new Error("one_signing_recipient_required");
  const recipient = recipients[0].contract_recipients as unknown as { id: string; full_name: string; email: string; role: string };
  const evidence = envelope.provider_evidence as Record<string, unknown>;
  const { data: link, error: linkError } = await db.from("contract_signing_links").select("token_ciphertext")
    .eq("tenant_id", tenantId).eq("envelope_id", envelopeId).eq("recipient_id", recipient.id).single(); must(linkError);
  if (!link) throw new Error("signing_link_missing");
  const env = serverEnv();
  const token = decryptJson<{ token: string }>(link.token_ciphertext, env.KUNDEXA_ENCRYPTION_KEY).token;
  const url = `${canonicalAppBaseUrl()}/sign/${encodeURIComponent(token)}`;
  if (!envelope.provider_envelope_id) {
    const config = pdfConfigurationSchema.parse(evidence.template);
    const signer = await createEngineSubmission({ key: `sign:${tenantId}:${envelopeId}`, templateId: config.template_id,
      schemaHash: config.schema_hash, role: config.role, name: recipient.full_name,
      email: recipient.email, recipientId: recipient.id, values: evidence.values as Record<string,string>,
      expiresAt: String(evidence.expires_at), returnUrl: url });
    // Durable engine idempotency closes the provider-success/local-write-failure gap.
    const saved = await db.from("signing_envelopes").update({ provider_envelope_id: String(signer.submission_id),
      status: "sent", sent_at: new Date().toISOString() }).eq("tenant_id", tenantId).eq("id", envelopeId);
    must(saved.error); envelope.provider_envelope_id = String(signer.submission_id);
    must((await db.from("signing_recipients").update({ provider_recipient_id: String(signer.id), status: "sent" })
      .eq("tenant_id", tenantId).eq("id", recipients[0].id)).error);
  } else if (!recipients[0].provider_recipient_id) {
    const submission = await engineSubmission(Number(envelope.provider_envelope_id));
    if (submission.submitters.length !== 1 || submission.submitters[0].email.toLowerCase() !== recipient.email.toLowerCase())
      throw new Error("provider_recipient_binding_mismatch");
    must((await db.from("signing_recipients").update({ provider_recipient_id: String(submission.submitters[0].id), status: "sent" })
      .eq("tenant_id", tenantId).eq("id", recipients[0].id)).error);
  }
  const issuer = (contract.seller_snapshot as Record<string, unknown>)?.legal_name ?? "Kundexa";
  const queued = await db.rpc("queue_docuseal_invitation", { p_tenant_id: tenantId, p_envelope_id: envelopeId,
    p_from_address: env.DEFAULT_EMAIL_FROM_ADDRESS!, p_subject: `Signera avtal ${contract.contract_number}`,
    p_body: `Hej ${recipient.full_name},\n\nGranska och signera ditt avtal hos ${issuer}:\n${url}\n\nEn signerad kopia skickas när signeringen är klar.` });
  must(queued.error);
  if (!queued.data) await docusealProvider.cancelEnvelope(envelope.provider_envelope_id!);
}

export async function reconcileDocusealEnvelope(tenantId: string, envelopeId: string) {
  const db = createAdminClient();
  const { data: envelope, error } = await db.from("signing_envelopes").select("*")
    .eq("tenant_id", tenantId).eq("id", envelopeId).eq("provider", "docuseal").single(); must(error);
  if (!envelope?.provider_envelope_id) throw new Error("provider_signing_operation_missing");
  if (envelope.status === "completed") return { completed: true };
  const { data: contract, error: contractError } = await db.from("contracts").select("active_version_id,acceptance_generation,status")
    .eq("tenant_id", tenantId).eq("id", envelope.contract_id).single(); must(contractError);
  if (!contract || contract.acceptance_generation !== envelope.generation || contract.active_version_id !== envelope.contract_version_id
    || ["cancelled","superseded"].includes(contract.status) || envelope.status === "cancelled") {
    await docusealProvider.cancelEnvelope(envelope.provider_envelope_id); return { completed: true };
  }
  const submission = await engineSubmission(Number(envelope.provider_envelope_id));
  if (["declined","expired"].includes(submission.status)) {
    const terminal = await db.rpc("project_docuseal_terminal", { p_tenant_id: tenantId,
      p_envelope_id: envelopeId, p_provider_id: envelope.provider_envelope_id, p_status: submission.status });
    must(terminal.error);
    return { completed: true };
  }
  if (submission.status !== "completed") return { completed: false };
  const { data: recipients, error: recipientError } = await db.from("signing_recipients").select("*")
    .eq("tenant_id", tenantId).eq("envelope_id", envelopeId); must(recipientError);
  if (!recipients?.length) throw new Error("signing_recipients_missing");
  for (const recipient of recipients) {
    const signer = submission.submitters.find(item => String(item.id) === recipient.provider_recipient_id);
    if (!signer || signer.status !== "completed" || !signer.completed_at) throw new Error("required_provider_signer_incomplete");
    must((await db.from("signing_recipients").update({ status: "signed", signed_at: signer.completed_at,
      identity_assurance_level: "low" }).eq("tenant_id", tenantId).eq("id", recipient.id)).error);
  }
  const eventId = `docuseal-completed:${submission.id}:${submission.completed_at}`;
  must((await db.from("signing_events").upsert({ tenant_id: tenantId, envelope_id: envelopeId, provider: "docuseal",
    provider_event_id: eventId, event_type: "submission.completed", event_at: submission.completed_at!, verified: true,
    processing_status: "processed", payload: { fetched_from_provider: true, submission_id: submission.id,
      completed_at: submission.completed_at, signer_ids: submission.submitters.map(s => s.id) } },
    { onConflict: "provider,provider_event_id" })).error);
  const bytes = await docusealProvider.fetchFinalDocument(envelope.provider_envelope_id);
  const hash = sha256Bytes(bytes);
  const path = `${tenantId}/${envelope.contract_id}/${envelope.contract_version_id}/signed-${envelopeId}-${hash}.pdf`;
  const upload = await db.storage.from("contract-documents").upload(path, bytes, { contentType: "application/pdf", upsert: false });
  if (upload.error && !upload.error.message.toLowerCase().includes("already exists")) must(upload.error);
  const { data: document, error: documentError } = await db.from("contract_documents").upsert({
    tenant_id: tenantId, contract_id: envelope.contract_id, contract_version_id: envelope.contract_version_id,
    document_type: "signed_pdf", file_name: `signerat-avtal.pdf`, storage_path: path,
    mime_type: "application/pdf", size_bytes: bytes.length, sha256: hash,
    metadata: { provider: "docuseal", envelope_id: envelopeId, generation: envelope.generation },
  }, { onConflict: "tenant_id,storage_path" }).select("id").single(); must(documentError);
  if (!document) throw new Error("signed_document_persistence_failed");
  if (submission.audit_log_url) {
    const audit = await downloadEnginePdf(submission.audit_log_url);
    const auditHash = sha256Bytes(audit);
    const auditPath = `${tenantId}/${envelope.contract_id}/${envelope.contract_version_id}/audit-${envelopeId}-${auditHash}.pdf`;
    const auditUpload = await db.storage.from("contract-documents").upload(auditPath, audit, { contentType: "application/pdf", upsert: false });
    if (auditUpload.error && !auditUpload.error.message.toLowerCase().includes("already exists")) must(auditUpload.error);
    must((await db.from("contract_documents").upsert({ tenant_id: tenantId, contract_id: envelope.contract_id,
      contract_version_id: envelope.contract_version_id, document_type: "evidence_pdf", file_name: "signeringsbevis.pdf",
      storage_path: auditPath, mime_type: "application/pdf", size_bytes: audit.length, sha256: auditHash,
      metadata: { provider: "docuseal", envelope_id: envelopeId, generation: envelope.generation } },
      { onConflict: "tenant_id,storage_path" })).error);
  }
  const finalized = await db.rpc("finalize_signing_envelope", { p_envelope_id: envelopeId, p_final_document_id: document.id,
    p_provider_evidence: toJson({ provider: "docuseal", provider_event_id: eventId, generation: envelope.generation,
      submission_id: submission.id, completed_at: submission.completed_at,
      source_document_sha256: (envelope.provider_evidence as Record<string,unknown>).source_sha256,
      final_document_sha256: hash }) }); must(finalized.error);
  return { completed: true };
}
