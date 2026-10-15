import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
const source = await readFile(new URL("../src/lib/signing/docuseal.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { DocuSealSigningProvider, DocuSealOutcomeUnknown } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const input = {
  tenantId: "tenant-a", contractId: "contract", contractVersionId: "v1", sourceDocumentId: "pdf1", idempotencyKey: "stable",
  providerTemplateId: "42", createMode: "initial", callbackUrl: "https://kundexa.example/hooks/docuseal",
  policy: { method: "external_esign", identityAssuranceLevel: "low", orderedSigning: true },
  recipients: [{ recipientId: "r1", fullName: "Test", email: "test@example.test", role: "Customer", required: true, signingOrder: 1, fieldValues: { Price: 10 }, readonlyFields: ["Price"] }],
};
const config = {
  baseUrl: "https://sign.example/api/", signingBaseUrl: "https://sign.example/", apiKey: "test-key",
  webhookUrl: input.callbackUrl, webhookHeaderName: "X-Kundexa-Secret", webhookHeaderSecret: "a".repeat(40), documentOrigins: ["https://sign.example"],
};
let created;
let postCount = 0;
let persisted = [];
const json = (value) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const provider = new DocuSealSigningProvider({ ...config, fetch: async (url, init) => {
  assert.equal(new URL(url).origin, "https://sign.example");
  assert.ok(new URL(url).pathname.startsWith("/api/submissions"), "selfhost API root must be preserved");
  if (init.method === "POST") {
    postCount++;
    created = JSON.parse(init.body);
    const rows = created.submitters.map((s, index) => ({ ...s, id: index + 3, submission_id: 90 }));
    persisted = [{ id: 90, submitters: rows }];
    return json(rows);
  }
  if (new URL(url).searchParams.has("after")) return json({ data: [], pagination: {} });
  return json({ data: persisted, pagination: { next: persisted.length ? 90 : null } });
} });
const first = await provider.createEnvelope(input);
assert.equal(first.providerEnvelopeId, "90");
assert.equal(first.recipients[0].providerRecipientId, "3");
assert.equal(created.send_email, false);
assert.equal(created.send_sms, false);
assert.deepEqual(created.submitters[0].readonly_fields, ["Price"]);
assert.deepEqual(await provider.createEnvelope({ ...input, createMode: "reconcile_only" }), first);
assert.equal(postCount, 1, "recovery must reuse the exact submission without another POST");
persisted = [];
await assert.rejects(provider.createEnvelope({ ...input, createMode: "reconcile_only" }), DocuSealOutcomeUnknown);
assert.equal(postCount, 1, "unmatched unknown creation must never blindly create another submission");
await assert.rejects(provider.createEnvelope({ ...input, policy: { method: "bankid", identityAssuranceLevel: "high" } }), /unsupported/);

const webhook = new TextEncoder().encode(JSON.stringify({ event_type: "submission.completed", timestamp: "2026-10-15T10:00:00Z", data: { id: 90 } }));
assert.throws(() => provider.verifyWebhook(webhook, new Headers()), /unauthorized/);
const headers = new Headers({ "X-Kundexa-Secret": config.webhookHeaderSecret });
const event = provider.verifyWebhook(webhook, headers);
assert.equal(event.providerEnvelopeId, "90");
assert.equal(event.providerEventId, provider.verifyWebhook(webhook, headers).providerEventId);

let documentOrigin = "https://sign.example";
let status = "completed";
let downloaded = 0;
const final = new DocuSealSigningProvider({ ...config, fetch: async (url) => {
  if (new URL(url).pathname.includes("/api/")) return json({ id: 90, status, completed_at: "2026-10-15T10:00:00Z", submitters: [{ id: 3, completed_at: "2026-10-15T10:00:00Z" }], combined_document_url: `${documentOrigin}/final.pdf` });
  downloaded++;
  return new Response("%PDF-test", { headers: { "content-type": "application/pdf" } });
} });
assert.equal(new TextDecoder().decode(await final.fetchFinalDocument("90")), "%PDF-test");
status = "pending";
await assert.rejects(final.fetchFinalDocument("90"), /not_ready/);
status = "completed"; documentOrigin = "https://attacker.example";
await assert.rejects(final.fetchFinalDocument("90"), /untrusted/);
assert.equal(downloaded, 1, "untrusted or unfinished documents must never be fetched");
console.log("DocuSeal adapter: create/reconcile, field locks, invitations, webhook auth, authoritative completion and final PDF trust checks PASS");

const { createHash } = await import("node:crypto");
const pdfBytes = new TextEncoder().encode("%PDF-isolated-source");
const sourceSha256 = createHash("sha256").update(pdfBytes).digest("hex");
const signatureField = { type: "signature", providerName: "Sign", required: true, placements: [{ page: 0, x: 0.1, y: 0.8, width: 0.3, height: 0.1 }] };
let schemaTampered = false;
let receivedProvision;
const provision = new DocuSealSigningProvider({ ...config, fetch: async (url, init) => {
  const path = new URL(url).pathname;
  if (path === "/api/kundexa/templates") {
    receivedProvision = JSON.parse(init.body);
    return json({ provider_template_id: "42", source_sha256: sourceSha256 });
  }
  if (path === "/api/templates/42") return json({
    id: 42, submitters: [{ name: "signer", uuid: "signer-uuid" }],
    schema: [{ attachment_uuid: "doc-uuid" }], documents: [{ uuid: "doc-uuid", url: "https://sign.example/source.pdf" }],
    preferences: { kundexa_frozen: true, kundexa_source_sha256: sourceSha256 },
    fields: [{ name: "Sign", type: schemaTampered ? "text" : "signature", required: true, submitter_uuid: "signer-uuid",
      areas: [{ page: 0, x: 0.1, y: 0.8, w: 0.3, h: 0.1, attachment_uuid: "doc-uuid" }] }],
  });
  if (path === "/source.pdf") return new Response(pdfBytes, { headers: { "content-type": "application/pdf" } });
  throw new Error("Unexpected request");
} });
const provisionInput = { pdfBytes, sourceSha256, externalKey: "envelope-1", fields: [signatureField], role: "signer", createMode: "initial" };
assert.deepEqual(await provision.provisionIsolatedTemplate(provisionInput), { providerTemplateId: "42" });
assert.equal(receivedProvision.external_key, "envelope-1");
assert.equal(receivedProvision.pdf_base64, Buffer.from(pdfBytes).toString("base64"));
await provision.provisionIsolatedTemplate({ ...provisionInput, createMode: "reconcile_only" });
assert.equal(receivedProvision.pdf_base64, undefined, "reconcile must never upload a replacement source");
schemaTampered = true;
await assert.rejects(provision.provisionIsolatedTemplate(provisionInput), /field_mismatch/);
await assert.rejects(provision.provisionIsolatedTemplate({ ...provisionInput, sourceSha256: "0".repeat(64) }), /source_invalid/);
console.log("DocuSeal isolated template: exact source hash/schema, immutable marker, mismatch rejection and reconcile-only payload PASS");

let auditStatus = "completed";
let auditUrl = "https://sign.example/provider-audit.pdf";
let auditType = "application/pdf";
let auditBody = "%PDF-provider-audit";
let auditLength = null;
const auditRequests = [];
const auditProvider = new DocuSealSigningProvider({ ...config, fetch: async (url) => {
  auditRequests.push(new URL(url).pathname);
  if (new URL(url).pathname.includes("/api/")) return json({ id: 90, status: auditStatus,
    completed_at: "2026-10-15T10:00:00Z", submitters: [{ id: 3, completed_at: "2026-10-15T10:00:00Z" }],
    combined_document_url: "https://sign.example/signed-contract.pdf", audit_log_url: auditUrl });
  return new Response(auditBody, { headers: { "content-type": auditType, ...(auditLength ? { "content-length": auditLength } : {}) } });
} });
assert.equal(new TextDecoder().decode(await auditProvider.fetchAuditDocument("90")), "%PDF-provider-audit");
assert.equal(auditRequests.at(-1), "/provider-audit.pdf", "audit must use audit_log_url, never combined_document_url");
auditStatus = "pending";
await assert.rejects(auditProvider.fetchAuditDocument("90"), /audit_document_not_ready/);
auditStatus = "completed"; auditUrl = "https://untrusted.example/audit.pdf";
await assert.rejects(auditProvider.fetchAuditDocument("90"), /origin_untrusted/);
auditUrl = "https://sign.example/provider-audit.pdf"; auditType = "text/html";
await assert.rejects(auditProvider.fetchAuditDocument("90"), /download_failed/);
auditType = "application/pdf"; auditBody = "invalid PDF bytes";
await assert.rejects(auditProvider.fetchAuditDocument("90"), /document_invalid/);
auditBody = "%PDF-audit"; auditLength = String(31 * 1024 * 1024);
await assert.rejects(auditProvider.fetchAuditDocument("90"), /document_invalid/);
auditUrl = "";
await assert.rejects(auditProvider.fetchAuditDocument("90"), /audit_document_not_ready/);
console.log("DocuSeal provider audit: distinct authoritative artifact, completion gate, origin/type/magic/size validation PASS");
