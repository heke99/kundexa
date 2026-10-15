import { createHash, timingSafeEqual } from "node:crypto";
import type { CreateEnvelopeInput, CreateEnvelopeResult, ProviderEnvelope, SigningProvider, SignerSessionInput, VerifiedSigningEvent } from "./provider";

// Verified against docusealco/docuseal 3c65b0e4ba872fe71d5566c0d09c3ace59a7fb8a:
// app/controllers/api/submissions_controller.rb and lib/{submissions,submitters}/serialize_for_api.rb.
// Webhook custom headers: lib/send_webhook_request.rb (webhook_url.secret).
type Submitter = { id: number; submission_id: number; external_id?: string; email?: string; role?: string; status?: string; completed_at?: string; embed_src?: string; slug?: string };
type Submission = { id: number; status: string; archived_at?: string; completed_at?: string; submitters: Submitter[]; combined_document_url?: string; audit_log_url?: string; documents?: Array<{ url: string }>; template?: { id: number } };
export type DocuSealConfig = {
  /** API root, e.g. https://host.example/api/ or https://api.docuseal.com/ */
  baseUrl: string;
  signingBaseUrl: string;
  apiKey: string;
  webhookUrl: string;
  webhookHeaderName: string;
  webhookHeaderSecret: string;
  /** Explicit trust list for provider-signed document URLs, including storage if separate. */
  documentOrigins: string[];
  fetch?: typeof fetch;
};

export class DocuSealOutcomeUnknown extends Error {
  readonly outcomeUnknown = true;
  constructor() { super("docuseal_create_outcome_unknown_reconcile_required"); }
}

export class DocuSealSigningProvider implements SigningProvider {
  readonly name = "docuseal";
  readonly capabilities = { methods: ["external_esign"] as const, orderedSigning: true, finalDocument: true, providerInvitations: false, createIdempotency: false };
  private readonly base: URL;
  private readonly fetcher: typeof fetch;
  constructor(private readonly config: DocuSealConfig) {
    this.base = new URL(config.baseUrl.endsWith("/") ? config.baseUrl : `${config.baseUrl}/`);
    if (new URL(config.signingBaseUrl).protocol !== "https:" || this.base.protocol !== "https:" || !config.apiKey || config.webhookHeaderSecret.length < 32
      || !/^x-[a-z0-9-]+$/i.test(config.webhookHeaderName) || new URL(config.webhookUrl).protocol !== "https:") {
      throw new Error("docuseal_configuration_invalid");
    }
    this.fetcher = config.fetch ?? fetch;
  }
  private id(value: string) {
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("docuseal_identifier_invalid");
    return value;
  }
  private async request(path: string, init?: RequestInit) {
    const response = await this.fetcher(new URL(path.replace(/^\//, ""), this.base), {
      ...init, redirect: "error", signal: AbortSignal.timeout(20_000),
      headers: { "X-Auth-Token": this.config.apiKey, "Content-Type": "application/json", ...init?.headers },
    });
    if (!response.ok) throw new Error(`docuseal_http_${response.status}`);
    return response;
  }
  async provisionIsolatedTemplate(input: {
    pdfBytes: Uint8Array; sourceSha256: string; externalKey: string; name?: string;
    fields: Array<{ type: string; providerName: string; required: boolean; placements: Array<{ page: number; x: number; y: number; width: number; height: number }> }>;
    role: "signer"; createMode: "initial" | "reconcile_only";
  }): Promise<{ providerTemplateId: string }> {
    if (createHash("sha256").update(input.pdfBytes).digest("hex") !== input.sourceSha256
      || !input.fields.length || input.fields.some((f) => f.type !== "signature")) throw new Error("docuseal_template_source_invalid");
    const response = await this.request("/kundexa/templates", {
      method: "POST", body: JSON.stringify({
        external_key: input.externalKey, source_sha256: input.sourceSha256,
        pdf_base64: input.createMode === "initial" ? Buffer.from(input.pdfBytes).toString("base64") : undefined,
        name: input.name ?? `Kundexa ${input.externalKey}`, role: input.role, mode: input.createMode,
        fields: input.fields.map(({ providerName, required, placements }) => ({ providerName, required, placements })),
      }),
    });
    const body = await response.json() as { provider_template_id: string; source_sha256: string };
    if (body.source_sha256 !== input.sourceSha256) throw new Error("docuseal_template_source_mismatch");
    const providerTemplateId = this.id(body.provider_template_id);
    await this.verifyTemplateSchema(providerTemplateId, input);
    return { providerTemplateId };
  }

  async verifyTemplateSchema(providerTemplateId: string, input: {
    pdfBytes: Uint8Array; sourceSha256: string; role: string;
    fields: Array<{ providerName: string; required: boolean; placements: Array<{ page: number; x: number; y: number; width: number; height: number }> }>;
  }): Promise<void> {
    type Area = { page: number; x: number; y: number; w: number; h: number; attachment_uuid: string };
    const template = await (await this.request(`/templates/${this.id(providerTemplateId)}`)).json() as {
      id: number; archived_at?: string; submitters: Array<{ name: string; uuid: string }>;
      fields: Array<{ name: string; type: string; required: boolean; submitter_uuid: string; areas: Area[] }>;
      documents: Array<{ uuid: string; url: string }>;
      schema: Array<{ attachment_uuid: string; dynamic?: boolean }>;
      preferences?: { kundexa_frozen?: boolean; kundexa_source_sha256?: string };
    };
    if (String(template.id) !== providerTemplateId || template.archived_at || template.submitters?.length !== 1
      || template.submitters[0].name !== input.role || template.documents?.length !== 1 || template.schema?.length !== 1
      || template.schema[0].dynamic || template.schema[0].attachment_uuid !== template.documents[0].uuid
      || !template.preferences?.kundexa_frozen || template.preferences.kundexa_source_sha256 !== input.sourceSha256
      || template.fields?.length !== input.fields.length) throw new Error("docuseal_template_schema_mismatch");
    const document = template.documents[0];
    for (const expected of input.fields) {
      const actual = template.fields.filter((f) => f.name === expected.providerName);
      if (actual.length !== 1 || actual[0].type !== "signature" || actual[0].required !== expected.required
        || actual[0].submitter_uuid !== template.submitters[0].uuid || actual[0].areas.length !== expected.placements.length) throw new Error("docuseal_template_field_mismatch");
      for (let i = 0; i < expected.placements.length; i++) {
        const p = expected.placements[i], a = actual[0].areas[i];
        if (a.attachment_uuid !== document.uuid || a.page !== p.page || a.x !== p.x || a.y !== p.y || a.w !== p.width || a.h !== p.height) throw new Error("docuseal_template_area_mismatch");
      }
    }
    const bytes = await this.downloadPdf(document.url);
    if (createHash("sha256").update(bytes).digest("hex") !== input.sourceSha256
      || createHash("sha256").update(input.pdfBytes).digest("hex") !== input.sourceSha256) throw new Error("docuseal_template_document_mismatch");
  }

  private externalId(input: CreateEnvelopeInput, recipientId: string) {
    return createHash("sha256").update(JSON.stringify([input.tenantId, input.contractId, input.contractVersionId, input.sourceDocumentId, input.idempotencyKey, recipientId])).digest("hex");
  }
  private result(submissionId: number, submitters: Submitter[], input: CreateEnvelopeInput): CreateEnvelopeResult {
    if (!Number.isSafeInteger(submissionId) || submissionId < 1 || submitters.length !== input.recipients.length) throw new Error("docuseal_submission_mismatch");
    const recipients = input.recipients.map((recipient) => {
      const matches = submitters.filter((s) => s.external_id === this.externalId(input, recipient.recipientId));
      if (matches.length !== 1 || !Number.isSafeInteger(matches[0].id) || matches[0].role !== recipient.role
        || matches[0].email?.toLowerCase() !== recipient.email?.toLowerCase()) throw new Error("docuseal_recipient_mismatch");
      return { recipientId: recipient.recipientId, providerRecipientId: String(matches[0].id) };
    });
    return { providerEnvelopeId: String(submissionId), status: "draft", recipients };
  }
  /** Upstream has no external_id submission filter; exhaust pages and compare exact recipient identities. */
  async reconcileEnvelope(input: CreateEnvelopeInput): Promise<CreateEnvelopeResult | null> {
    const templateId = this.id(input.providerTemplateId ?? "");
    let after: string | undefined;
    const matches: CreateEnvelopeResult[] = [];
    const seen = new Set<string>();
    for (let page = 0; page < 1000; page++) {
      const query = new URLSearchParams({ template_id: templateId, limit: "100" });
      if (after) query.set("after", after);
      const body = await (await this.request(`/submissions?${query}`)).json() as { data: Submission[]; pagination: { next?: number } };
      if (!Array.isArray(body.data)) throw new Error("docuseal_reconciliation_invalid");
      for (const submission of body.data) {
        if (submission.submitters?.some((s) => input.recipients.some((r) => s.external_id === this.externalId(input, r.recipientId)))) {
          matches.push(this.result(submission.id, submission.submitters, input));
        }
      }
      if (!body.data.length || !body.pagination?.next) {
        if (matches.length > 1) throw new Error("docuseal_reconciliation_conflict");
        return matches[0] ?? null;
      }
      after = String(body.pagination.next);
      if (seen.has(after)) throw new Error("docuseal_pagination_loop");
      seen.add(after);
    }
    throw new Error("docuseal_reconciliation_incomplete");
  }
  async createEnvelope(input: CreateEnvelopeInput): Promise<CreateEnvelopeResult> {
    if (input.policy.method !== "external_esign" || input.policy.identityAssuranceLevel !== "low"
      || input.callbackUrl !== this.config.webhookUrl || !input.recipients.length
      || input.recipients.some((r) => !r.required || !r.email)
      || !["initial", "reconcile_only"].includes(input.createMode ?? "")) throw new Error("docuseal_request_unsupported");
    if (input.expiresAt && (!Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= Date.now())) throw new Error("docuseal_expiry_invalid");
    const templateId = this.id(input.providerTemplateId ?? "");
    const previous = await this.reconcileEnvelope(input);
    if (previous) return previous;
    // No provider idempotency guarantee. Unknown POSTs must never be automatically repeated.
    if (input.createMode === "reconcile_only") throw new DocuSealOutcomeUnknown();
    let rows: Submitter[];
    try {
      rows = await (await this.request("/submissions", {
        method: "POST", body: JSON.stringify({
          template_id: Number(templateId), expire_at: input.expiresAt, send_email: false, send_sms: false,
          submitters_order: input.policy.orderedSigning ? "preserved" : "random",
          submitters: [...input.recipients].sort((a, b) => a.signingOrder - b.signingOrder).map((r) => ({
            name: r.fullName, email: r.email, role: r.role, external_id: this.externalId(input, r.recipientId),
            send_email: false, send_sms: false, values: r.fieldValues ?? {}, readonly_fields: r.readonlyFields ?? [],
            metadata: { kundexa_contract_version: input.contractVersionId, kundexa_source_document: input.sourceDocumentId },
          })),
        }),
      })).json() as Submitter[];
      if (!Array.isArray(rows) || !rows.length || rows.some((r) => r.submission_id !== rows[0].submission_id)) throw new Error("docuseal_create_response_invalid");
      return this.result(rows[0].submission_id, rows, input);
    } catch {
      throw new DocuSealOutcomeUnknown();
    }
  }
  async createSignerSession(input: SignerSessionInput) {
    const envelope = await this.submission(input.providerEnvelopeId);
    if (envelope.archived_at || envelope.status !== "pending") throw new Error("docuseal_envelope_not_signable");
    const recipient = envelope.submitters.find((s) => String(s.id) === this.id(input.providerRecipientId));
    if (!recipient?.slug || recipient.completed_at) throw new Error("docuseal_recipient_not_signable");
    const url = new URL(`/s/${encodeURIComponent(recipient.slug)}`, this.config.signingBaseUrl);
    // Slug links have no proven expiry in upstream; never invent a provider expiration.
    return { url: url.href, expiresAt: null };
  }
  private async submission(id: string): Promise<Submission> {
    const body = await (await this.request(`/submissions/${this.id(id)}?include=combined_document_url`)).json() as Submission;
    if (String(body.id) !== id || !Array.isArray(body.submitters)) throw new Error("docuseal_submission_invalid");
    return body;
  }
  async cancelEnvelope(id: string) { await this.request(`/submissions/${this.id(id)}`, { method: "DELETE" }); }
  async fetchEnvelope(id: string): Promise<ProviderEnvelope> {
    const body = await this.submission(id);
    const status = body.archived_at ? "cancelled" : body.status === "completed" ? "completed"
      : body.status === "declined" ? "declined" : body.status === "expired" ? "expired"
      : body.status === "pending" ? (body.submitters.some((s) => s.completed_at) ? "partially_signed" : "sent") : "failed";
    return { providerEnvelopeId: id, status, completedAt: body.completed_at, evidence: { submitters: body.submitters } };
  }
  async fetchFinalDocument(id: string) {
    const body = await this.submission(id);
    if (body.archived_at || body.status !== "completed" || !body.completed_at || !body.submitters.length
      || body.submitters.some((s) => !s.completed_at)) throw new Error("docuseal_final_document_not_ready");
    return this.downloadPdf(body.combined_document_url ?? "");
  }
  async fetchAuditDocument(id: string) {
    // The pinned API's show action ensures an audit_trail is generated for completed submissions.
    // SerializeForApi.audit_log_url is Submission#audit_trail_url, not the signed contract PDF.
    const body = await this.submission(id);
    if (body.archived_at || body.status !== "completed" || !body.completed_at || !body.submitters.length
      || body.submitters.some((s) => !s.completed_at) || !body.audit_log_url) throw new Error("docuseal_audit_document_not_ready");
    return this.downloadPdf(body.audit_log_url);
  }
  private async downloadPdf(value: string) {
    const url = new URL(value);
    if (url.protocol !== "https:" || !this.config.documentOrigins.includes(url.origin)) throw new Error("docuseal_document_origin_untrusted");
    const response = await this.fetcher(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (!response.ok || !response.headers.get("content-type")?.toLowerCase().includes("application/pdf")) throw new Error("docuseal_document_download_failed");
    const limit = 30 * 1024 * 1024;
    if (Number(response.headers.get("content-length")) > limit || !response.body) throw new Error("docuseal_document_invalid");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        length += chunk.byteLength;
        if (length > limit) { await reader.cancel(); throw new Error("docuseal_document_invalid"); }
        chunks.push(chunk);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    if (bytes.length < 5 || bytes.length > limit || new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") throw new Error("docuseal_document_invalid");
    return bytes;
  }
  verifyWebhook(rawBody: Uint8Array, headers: Headers): VerifiedSigningEvent {
    const actual = Buffer.from(headers.get(this.config.webhookHeaderName) ?? "");
    const expected = Buffer.from(this.config.webhookHeaderSecret);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("docuseal_webhook_unauthorized");
    const body = JSON.parse(new TextDecoder().decode(rawBody)) as { event_type: string; timestamp: string; data: Record<string, unknown> };
    if (!/^submission\.(created|completed|archived|expired)$|^form\.(completed|declined|viewed|started)$/.test(body.event_type)
      || !Number.isFinite(Date.parse(body.timestamp)) || !body.data || typeof body.data !== "object") throw new Error("docuseal_webhook_invalid");
    const envelopeId = body.event_type.startsWith("submission.") ? body.data.id : body.data.submission_id;
    return {
      providerEventId: createHash("sha256").update(rawBody).digest("hex"),
      providerEnvelopeId: this.id(String(envelopeId)),
      providerRecipientId: body.event_type.startsWith("form.") ? this.id(String(body.data.id)) : null,
      eventType: body.event_type, eventAt: body.timestamp, verified: true, payload: body.data,
    };
  }
}
