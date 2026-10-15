import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { PDFDocument, degrees, decodePDFRawStream } from "pdf-lib";
import { deflateSync } from "node:zlib";
import ts from "typescript";
const require = createRequire(import.meta.url);
const transpile = (source) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const dataUrl = (source) => `data:text/javascript;base64,${Buffer.from(transpile(source)).toString("base64")}`;
const geometrySource = await readFile(new URL("../src/lib/signing/ported/docuseal-geometry.ts", import.meta.url), "utf8");
const geometryUrl = dataUrl(geometrySource);
let source = await readFile(new URL("../src/lib/signing/native-document.ts", import.meta.url), "utf8");
source = source.replace('"./ported/docuseal-geometry"', JSON.stringify(geometryUrl));
for (const name of ["pdf-lib", "@pdf-lib/upng"]) source = source.replace(JSON.stringify(name), JSON.stringify(pathToFileURL(require.resolve(name)).href));
const engine = await import(dataUrl(source));
const { signatureImagePlacement } = await import(geometryUrl);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const encodePng = (rgba, width, height) => {
  const crc32 = bytes => {
    let crc = 0xffffffff;
    for (const byte of bytes) { crc ^= byte; for (let b = 0; b < 8; b++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const result = Buffer.alloc(data.length + 12); result.writeUInt32BE(data.length); body.copy(result, 4); result.writeUInt32BE(crc32(body), result.length - 4); return result;
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(scanlines, y * (width * 4 + 1) + 1);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(scanlines)), chunk("IEND", Buffer.alloc(0))]);
};
const pixels = new Uint8Array(120 * 60 * 4);
for (let y = 10; y < 50; y++) for (let x = 10; x < 110; x++) {
  if (Math.abs(y - (15 + (x % 30))) < 3) pixels[(y * 120 + x) * 4 + 3] = 255;
}
const signaturePngBytes = encodePng(pixels, 120, 60);
assert.deepEqual(engine.inspectNativeSignaturePng(signaturePngBytes), { width: 120, height: 60 });
const original = await PDFDocument.create({ updateMetadata: false }); original.addPage([600, 800]); original.addPage([600, 800]);
const sourceBytes = await original.save({ useObjectStreams: false });
const receipt = { receiptId: "receipt", envelopeId: "env", tenantId: "tenant", contractId: "contract", contractVersionId: "v1", generation: 1, recipientName: "Östergårds Företag AB", recipientEmail: "asa@example.test",
  sourceSha256: hash(sourceBytes), signatureSha256: hash(signaturePngBytes), signerName: "Åsa Östergård", acceptedAt: "2026-10-15T12:34:56Z",
  consent: "Jag godkänner avtalet och vill underteckna med min ritade underskrift.", requestKey: "stable-request", requestHash: "a".repeat(64) };
const placement = { page: 0, x: 0.1, y: 0.2, width: 0.4, height: 0.1 };
const template = { schemaVersion: 1, storagePath: "tenant/templates/source.pdf", sha256: hash(sourceBytes), pageSizes: [{ width: 600, height: 800 }, { width: 600, height: 800 }],
  fields: [{ id: "sign", label: "Underskrift", providerName: "Sign", type: "signature", source: "", required: true, fontSize: 10,
    placements: [placement, { ...placement, page: 1 }] }] };
template.fields.push({ ...template.fields[0], id: "signSecond", providerName: "Sign2", placements: [{ ...placement, page: 1, y: 0.5 }] });
const input = { sourceBytes, signaturePngBytes, receipt, template };
const signed = await engine.renderNativeSignedPdf(input);
assert.deepEqual(signed, await engine.renderNativeSignedPdf(input), "fixed receipt retries must produce byte-identical signed PDF");
const result = await PDFDocument.load(signed);
assert.equal(result.getPageCount(), 3);
for (const [pageIndex, page] of result.getPages().slice(0, 2).entries()) {
  assert.equal(page.node.Resources().lookup(require("pdf-lib").PDFName.of("XObject")).keys().length, pageIndex === 0 ? 1 : 2, "signature image must be embedded on each required page");
  const streams = page.node.Contents();
  const operators = streams.asArray().map(ref => Buffer.from(decodePDFRawStream(result.context.lookup(ref)).decode()).toString()).join("\n");
  assert.equal((operators.match(/ Do/g) ?? []).length, pageIndex === 0 ? 1 : 2, "every required signature field placement must be painted");
  assert.match(operators, /160 0 0 80/, "drawing must retain the 2:1 signature aspect ratio");
}
assert.deepEqual(signatureImagePlacement(600, 800, 120, 60, placement), { x: 100, y: 560, width: 160, height: 80 });
await engine.validateNativeSignerText("Åsa Östergård", receipt.consent);
await assert.rejects(engine.validateNativeSignerText("Name 😀", receipt.consent), /unsupported_glyph/);
const auditReceipt = { ...receipt, finalSha256: hash(signed) };
const audit = await engine.renderNativeAuditPdf(auditReceipt);
assert.deepEqual(audit, await engine.renderNativeAuditPdf(auditReceipt));
assert.equal((await PDFDocument.load(audit)).getPageCount(), 1);
assert.notEqual(hash(audit), hash(signed));
const auditPdf = await PDFDocument.load(audit);
const auditOperators = auditPdf.getPages().flatMap(page => page.node.Contents().asArray().map(ref => Buffer.from(decodePDFRawStream(auditPdf.context.lookup(ref)).decode()).toString())).join("\n");
assert.ok(auditOperators.includes(Buffer.from("Undertecknare: ", "latin1").toString("hex").toUpperCase()), "audit labels the actual human signer");
assert.ok(auditOperators.includes(Buffer.from("Avtalets mottagare: ", "latin1").toString("hex").toUpperCase()), "audit labels the frozen contractual recipient separately");
assert.notDeepEqual(audit, await engine.renderNativeAuditPdf({ ...auditReceipt, recipientName: "Annat Företag AB" }), "audit bytes bind frozen recipient identity");
await assert.rejects(engine.renderNativeSignedPdf({ ...input, receipt: { ...receipt, sourceSha256: "0".repeat(64) } }), /binding_invalid/);
await assert.rejects(engine.renderNativeSignedPdf({ ...input, template: { ...template, pageSizes: [{ width: 1, height: 2 }] } }), /snapshot_mismatch/);
await assert.rejects(engine.renderNativeSignedPdf({ ...input, template: { ...template, fields: [] } }), /fields_missing/);
await assert.rejects(engine.renderNativeAuditPdf({ ...receipt, signerName: "Name 😀" }), /unsupported_glyph/);
assert.throws(() => engine.inspectNativeSignaturePng(encodePng(new Uint8Array(120 * 60 * 4), 120, 60)), /empty_or_too_small/);
const corrupt = Uint8Array.from(signaturePngBytes); corrupt[corrupt.length - 1] ^= 1;
assert.throws(() => engine.inspectNativeSignaturePng(corrupt), /crc_invalid/);
const rotated = await PDFDocument.load(sourceBytes); rotated.getPage(0).setRotation(degrees(90));
const rotatedBytes = await rotated.save();
await assert.rejects(engine.renderNativeSignedPdf({ ...input, sourceBytes: rotatedBytes, receipt: { ...receipt, sourceSha256: hash(rotatedBytes) } }), /snapshot_mismatch/);
const helpers = await import(dataUrl(await readFile(new URL("../src/lib/signing/ported/docuseal-signature.ts", import.meta.url), "utf8")));
assert.equal(helpers.isValidSignatureCanvas([]), false);
assert.equal(helpers.isValidSignatureCanvas([{ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }] }]), false);
assert.equal(helpers.isValidSignatureCanvas([{ points: [{ x: 0, y: 0 }, { x: 10, y: 20 }, { x: 20, y: 0 }] }]), true);
console.log("Native signature engine: real PNG embedding across pages, DocuSeal geometry/helper ports, Swedish names, deterministic signed/audit PDFs, hashes and malformed inputs PASS");
