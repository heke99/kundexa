import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
const calls = [];
let claim = true;
let unknown = false;
const evidence = { expires_at: "2030-01-01T00:00:00.000Z", source_document_id: "source", source_sha256: "hash", recipient_name: "Test", email: "test@example.test", public_token_ciphertext: "encrypted" };
const rows = {
  signing_envelopes: { id: "envelope", tenant_id: "tenant", contract_id: "contract", contract_version_id: "version", status: "creating", provider_evidence: evidence, signature_policy: { method: "external_esign", identityAssuranceLevel: "low", requireFinalProviderDocument: true } },
  contract_versions: { commercial_terms: { pdf_fields: { template: { fields: [{ type: "signature", required: true, providerName: "Sign", placements: [] }] } } } },
  contract_documents: { id: "source", sha256: "hash", storage_path: "source.pdf", file_name: "source.pdf" },
  signing_recipients: [{ id: "recipient", required: true }],
  contracts: { title: "Test", contract_number: "KX-1", seller_snapshot: { legal_name: "Test AB" } },
};
const admin = {
  from(table) {
    const result = { data: rows[table], error: null };
    const builder = new Proxy({}, { get(_target, key) {
      if (key === "then") return (resolve) => Promise.resolve(result).then(resolve);
      return () => builder;
    } });
    return builder;
  },
  storage: { from() { return { download: async () => ({ data: new Blob(["%PDF-test"]), error: null }) }; } },
  async rpc(name, args) {
    calls.push([name, args]);
    if (name === "claim_docuseal_submission") return { data: claim, error: null };
    if (name === "commit_docuseal_invitation") return { data: {}, error: null };
    throw new Error(`unexpected_rpc:${name}`);
  },
};
const provider = {
  async provisionIsolatedTemplate(input) { calls.push(["provision", input]); return { providerTemplateId: "10" }; },
  async createEnvelope(input) { calls.push(["create", input]); if (unknown) throw new Error("outcome_unknown"); return { providerEnvelopeId: "20", recipients: [{ providerRecipientId: "30" }] }; },
};
globalThis.__signingTest = { admin, provider };
Object.assign(process.env, { DOCUSEAL_API_URL: "https://sign.example/api/", DOCUSEAL_SIGNING_URL: "https://sign.example", DOCUSEAL_API_KEY: "test", DOCUSEAL_WEBHOOK_SECRET: "a".repeat(32), DOCUSEAL_DOCUMENT_ORIGINS: "https://sign.example" });
let source = await readFile(new URL("../src/lib/signing/orchestration.ts", import.meta.url), "utf8");
let output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
output = output.replace('from "zod"', `from ${JSON.stringify(import.meta.resolve("zod"))}`);
const stubs = {
  './docuseal': 'const DocuSealSigningProvider = class { constructor() { return globalThis.__signingTest.provider; } };',
  './policy': 'const parseSignaturePolicy = (v) => v;',
  '@/lib/supabase/admin': 'const createAdminClient = () => globalThis.__signingTest.admin;',
  '@/lib/env': 'const canonicalAppBaseUrl = () => "https://app.example"; const serverEnv = () => ({ KUNDEXA_ENCRYPTION_KEY: "test", DEFAULT_EMAIL_FROM_ADDRESS: "from@example.test" });',
  '@/lib/crypto': 'const decryptJson = () => ({ token: "test-token" }); const encryptJson = () => "encrypted"; const randomToken = () => "token"; const sha256 = () => "hash";',
  '@/lib/contracts/document-hash': 'const stableJson = JSON.stringify; const hashPdfBytes = () => "hash";',
  '@/lib/contracts/canonical-document': 'const ensureCanonicalContractDocument = () => { throw new Error("unexpected"); };',
  '@/lib/contracts/pdf-field-template': 'const validatePdfTemplate = (v) => v;',
  '@/lib/email/templates/contract-delivery': 'const renderContractDeliveryEmail = () => ({ subject: "subject", text: "text", html: "html" });',
  '@/lib/supabase/json': 'const toJson = (v) => v;',
};
for (const [path, stub] of Object.entries(stubs)) {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  output = output.replace(new RegExp(`import[^;]+from "${escaped}";`, "g"), stub);
}
const module = await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
await module.continueExternalSigning("envelope", true);
assert.deepEqual(calls.map(([name]) => name), ["provision", "claim_docuseal_submission", "create", "commit_docuseal_invitation"]);
assert.equal(calls[2][1].createMode, "initial");
assert.equal(calls[2][1].sourceDocumentId, "source");
assert.equal(calls[2][1].recipients[0].recipientId, "recipient");
assert.equal(calls[2][1].expiresAt, evidence.expires_at);
calls.length = 0; claim = false;
await module.continueExternalSigning("envelope", false);
assert.equal(calls[0][1].createMode, "initial", "The isolated-template endpoint is idempotent and may recover a crash before submission claim");
assert.equal(calls[2][1].createMode, "reconcile_only");
calls.length = 0; unknown = true;
await assert.rejects(module.continueExternalSigning("envelope", false), /outcome_unknown/);
assert.ok(!calls.some(([name]) => name === "commit_docuseal_invitation"));
console.log("DocuSeal orchestration: durable claim before submission, exact identity/expiry, replay reconciliation and no invitation after unknown outcome PASS");
