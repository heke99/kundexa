import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
let ts;
try {
  ts = (await import("typescript")).default;
} catch {
  ts = (await import("file:///opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript/lib/typescript.js")).default;
}

function transpile(source, fileName) {
  const result = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    fileName,
    reportDiagnostics: true,
  });
  const errors = (result.diagnostics ?? []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  assert.equal(errors.length, 0, `${fileName}: ${errors.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")).join("\n")}`);
  return result.outputText;
}

async function importSource(source, fileName) {
  const output = transpile(source, fileName);
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

const documentHashSource = (await readFile(new URL("../src/lib/contracts/document-hash.ts", import.meta.url), "utf8"))
  .replace('import { sha256, sha256Bytes } from "@/lib/crypto";', `
    import crypto from "node:crypto";
    const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
    const sha256Bytes = (value) => crypto.createHash("sha256").update(value).digest("hex");
  `);
const documentHash = await importSource(documentHashSource, "document-hash.ts");
assert.equal(documentHash.stableJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
assert.equal(documentHash.stableJson({ nested: { z: true, a: null }, list: [2, 1] }), '{"list":[2,1],"nested":{"a":null,"z":true}}');
assert.equal(documentHash.hashContractSnapshot({ b: 2, a: 1 }), crypto.createHash("sha256").update('{"a":1,"b":2}').digest("hex"));
assert.equal(documentHash.hashPdfBytes(new Uint8Array([37, 80, 68, 70])), crypto.createHash("sha256").update(new Uint8Array([37, 80, 68, 70])).digest("hex"));

const documentHashUrl = `data:text/javascript;base64,${Buffer.from(transpile(documentHashSource, "document-hash.ts")).toString("base64")}`;
const snapshotSource = (await readFile(new URL("../src/lib/contracts/canonical-contract-snapshot.ts", import.meta.url), "utf8"))
  .replace('from "@/lib/contracts/document-hash"', `from "${documentHashUrl}"`);
const canonicalSnapshot = await importSource(snapshotSource, "canonical-contract-snapshot.ts");
const snapshotInput = {
  id: "contract-1", contract_number: "KX-1", title: "Avtal", audience: "B2B", sales_channel: "telephone",
  starts_on: null, ends_on: null, binding_months: null, notice_months: null, value: 100, currency: "SEK",
  created_at: "2026-07-27T10:00:00.000Z", seller_snapshot: { legal_name: "Test AB" }, counterparty_snapshot: { display_name: "Kund AB" },
};
const versionInput = { id: "version-1", version: 1, title: "Avtal", rendered_body: "Text", rendered_terms: "Villkor", commercial_terms: {}, template_version_id: null, price_version_id: null, created_at: "2026-07-27T10:05:00.000Z" };
const callInput = { id: "call-1", ended_at: "2026-07-27T09:59:00.000Z", disposition: "interested", user_id: "user-1" };
const firstSnapshot = canonicalSnapshot.createCanonicalContractSnapshot(snapshotInput, versionInput, callInput);
const secondSnapshot = canonicalSnapshot.createCanonicalContractSnapshot(snapshotInput, versionInput, callInput);
assert.equal(firstSnapshot.snapshot.generated_at, versionInput.created_at);
assert.equal(firstSnapshot.snapshotHash, secondSnapshot.snapshotHash, "Canonical snapshots must be deterministic across retries");

const reminderTimeSource = await readFile(new URL("../supabase/functions/_shared/reminder-time.ts", import.meta.url), "utf8");
const reminderTime = await importSource(reminderTimeSource, "reminder-time.ts");
assert.equal(reminderTime.inQuietHours(new Date("2026-07-27T20:30:00.000Z"), "UTC", "20:00", "08:00"), true);
assert.equal(reminderTime.inQuietHours(new Date("2026-07-27T07:30:00.000Z"), "UTC", "20:00", "08:00"), true);
assert.equal(reminderTime.inQuietHours(new Date("2026-07-27T12:00:00.000Z"), "UTC", "20:00", "08:00"), false);
assert.equal(reminderTime.inQuietHours(new Date("2026-07-27T10:00:00.000Z"), "UTC", "09:00", "17:00"), true);

const resendStatusSource = await readFile(new URL("../src/lib/contracts/resend-status.ts", import.meta.url), "utf8");
const resendStatus = await importSource(resendStatusSource, "resend-status.ts");
assert.equal(resendStatus.resendStatusForEvent("email.sent"), "sent");
assert.equal(resendStatus.resendStatusForEvent("email.delivery_delayed"), "delayed");
assert.equal(resendStatus.resendStatusForEvent("email.unknown"), null);
assert.equal(resendStatus.isPermanentResendFailure("bounced"), true);
assert.equal(resendStatus.isPermanentResendFailure("failed"), false);

const layoutSource = await readFile(new URL("../src/lib/email/render-email-layout.ts", import.meta.url), "utf8");
const layoutOutput = transpile(layoutSource, "render-email-layout.ts");
const layoutUrl = `data:text/javascript;base64,${Buffer.from(layoutOutput).toString("base64")}`;
const deliverySource = (await readFile(new URL("../src/lib/email/templates/contract-delivery.ts", import.meta.url), "utf8"))
  .replace('from "@/lib/email/render-email-layout"', `from "${layoutUrl}"`);
const delivery = await importSource(deliverySource, "contract-delivery.ts");
const rendered = delivery.renderContractDeliveryEmail({
  legalName: "Test & Co AB", customerName: "A <B>", contractNumber: "KX-1",
  contractTitle: "Avtal", acceptUrl: "https://example.test/accept/token", expiresAt: "1 augusti 2026",
});
assert.equal(rendered.subject, "Avtal KX-1 från Test & Co AB");
assert.match(rendered.html, /A &lt;B&gt;/);
assert.match(rendered.html, /Granska och acceptera avtalet/);
assert.match(rendered.text, /https:\/\/example\.test\/accept\/token/);

console.log("Contract delivery unit tests passed: stable snapshot/PDF hashes, reminder quiet hours, Resend mapping and escaped email templates.");
