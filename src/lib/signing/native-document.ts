import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import UPNG from "@pdf-lib/upng";
import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";
import type { PdfFieldTemplate } from "../contracts/pdf-field-template";
import { signatureImagePlacement } from "./ported/docuseal-geometry";

export type NativeSigningReceipt = {
  receiptId: string; envelopeId: string; tenantId: string; contractId: string; contractVersionId: string;
  generation: number; sourceSha256: string; signatureSha256: string; signerName: string; acceptedAt: string;
  consent: string; requestKey: string; requestHash: string; finalSha256?: string;
};
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const pngCodec = (UPNG as unknown as { default?: typeof UPNG }).default ?? UPNG;
const PNG_MAGIC = [137, 80, 78, 71, 13, 10, 26, 10];
function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Validate bounded PNG input before the image decoder allocates its buffers. */
export function inspectNativeSignaturePng(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length < 45 || bytes.length > 1024 * 1024 || !PNG_MAGIC.every((byte, i) => bytes[i] === byte)) throw new Error("native_signature_png_invalid");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16), height = view.getUint32(20);
  if (width < 20 || height < 20 || width > 2048 || height > 1024 || width * height > 2_000_000) throw new Error("native_signature_dimensions_invalid");
  let offset = 8;
  let ended = false;
  const compressed: Uint8Array[] = [];
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw new Error("native_signature_png_invalid");
    const length = view.getUint32(offset);
    if (length > bytes.length - offset - 12) throw new Error("native_signature_png_invalid");
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== view.getUint32(offset + 8 + length)) throw new Error("native_signature_png_crc_invalid");
    if ((offset === 8 && (type !== "IHDR" || length !== 13)) || (offset !== 8 && type === "IHDR")) throw new Error("native_signature_png_invalid");
    if (type === "acTL" || type === "fcTL" || type === "fdAT") throw new Error("native_signature_animation_unsupported");
    if (type === "IDAT") compressed.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
    if (type === "IEND") { if (length !== 0 || offset !== bytes.length) throw new Error("native_signature_png_invalid"); ended = true; break; }
  }
  if (!ended || !compressed.length || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] !== 0) throw new Error("native_signature_png_invalid");
  // Supports browser canvas PNG variants (including palettes), bounded before UPNG/pako decode.
  try { inflateSync(Buffer.concat(compressed), { maxOutputLength: width * height * 8 + height + 1024 }); }
  catch { throw new Error("native_signature_png_inflate_invalid"); }
  let rgba: Uint8Array;
  try {
    const decoded = pngCodec.decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    const frames = pngCodec.toRGBA8(decoded);
    if (frames.length !== 1) throw new Error("animated");
    rgba = new Uint8Array(frames[0]);
  } catch { throw new Error("native_signature_png_decode_invalid"); }
  let left = width, top = height, right = -1, bottom = -1, ink = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    if (rgba[i + 3] > 32 && Math.min(rgba[i], rgba[i + 1], rgba[i + 2]) < 220) {
      ink++; left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
  }
  if (ink < 40 || right - left + 1 < 20 || bottom - top + 1 < 20) throw new Error("native_signature_empty_or_too_small");
  return { width, height };
}

export async function validateNativeSignerText(name: string, consent: string): Promise<void> {
  if (typeof name !== "string" || !name.trim() || name.length > 200 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error("native_signing_signer_name_invalid");
  if (typeof consent !== "string" || !consent.trim() || consent.length > 3000) throw new Error("native_signing_consent_invalid");
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  try { wrap(name, font, 495, 10); wrap(consent, font, 495, 10); } catch { throw new Error("native_signing_unsupported_glyph"); }
}

function validateReceipt(receipt: NativeSigningReceipt) {
  if (!receipt || !receipt.receiptId || !receipt.envelopeId || !receipt.tenantId || !receipt.contractId || !receipt.contractVersionId
    || !Number.isInteger(receipt.generation) || receipt.generation < 1 || !receipt.requestKey
    || ![receipt.sourceSha256, receipt.signatureSha256, receipt.requestHash].every(value => /^[a-f0-9]{64}$/.test(value))
    || (receipt.finalSha256 !== undefined && !/^[a-f0-9]{64}$/.test(receipt.finalSha256))
    || !Number.isFinite(Date.parse(receipt.acceptedAt)) || !receipt.signerName?.trim() || receipt.signerName.length > 200
    || /[\u0000-\u001f\u007f]/.test(receipt.signerName) || !receipt.consent?.trim() || receipt.consent.length > 3000) throw new Error("native_signing_receipt_invalid");
}
function setMetadata(pdf: PDFDocument, receipt: NativeSigningReceipt, title: string) {
  const at = new Date(receipt.acceptedAt);
  pdf.setCreationDate(at); pdf.setModificationDate(at); pdf.setTitle(title);
  pdf.setProducer("Kundexa electronic drawn signature; DocuSeal geometry port");
  pdf.setCreator("Kundexa"); pdf.setAuthor(receipt.signerName);
}
function wrap(value: string, font: PDFFont, width: number, size: number): string[] {
  // encodeText rejects unsupported glyphs; never silently replace the signer's name.
  font.encodeText(value);
  const lines: string[] = [];
  for (const paragraph of value.replace(/\r/g, "").split("\n")) {
    let line = "";
    for (const char of paragraph) {
      if (line && font.widthOfTextAtSize(line + char, size) > width) { lines.push(line); line = ""; }
      line += char;
    }
    lines.push(line);
  }
  return lines;
}
async function appendReceipt(pdf: PDFDocument, receipt: NativeSigningReceipt, audit: boolean) {
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const title = audit ? "Underlag för elektronisk underskrift" : "Elektronisk underskrift";
  const at = new Date(receipt.acceptedAt).toISOString();
  const rows = [title, `Undertecknare: ${receipt.signerName}`, `Tidpunkt (UTC): ${at}`,
    "Ritad elektronisk namnunderskrift med låg identitetsnivå.",
    "Identiteten har inte verifierats med BankID eller kvalificerat certifikat.",
    `Samtycke: ${receipt.consent}`, `Kvitto: ${receipt.receiptId}`, `Avtal: ${receipt.contractId}`,
    `Avtalsversion: ${receipt.contractVersionId}`, `Signeringsgeneration: ${receipt.generation}`,
    `Signeringsbegäran: ${receipt.envelopeId}`, `Källdokument SHA-256: ${receipt.sourceSha256}`,
    `Underskriftsbild SHA-256: ${receipt.signatureSha256}`,
    ...(audit && receipt.finalSha256 ? [`Slutdokument SHA-256: ${receipt.finalSha256}`] : []),
    ...(audit ? [`Organisation: ${receipt.tenantId}`, `Begärans nyckel: ${receipt.requestKey}`, `Begärans SHA-256: ${receipt.requestHash}`] : []),
    "Underskriftsfältens bildpassning återanvänder DocuSeal-kod."];
  let page = pdf.addPage([595.28, 841.89]), y = 790;
  try {
    for (const row of rows) for (const line of wrap(row, font, 495, 10)) {
      if (y < 50) { page = pdf.addPage([595.28, 841.89]); y = 790; }
      page.drawText(line, { x: 50, y, size: 10, font, color: rgb(0, 0, 0) }); y -= 15;
    }
  } catch { throw new Error("native_signing_unsupported_glyph"); }
}

export async function renderNativeSignedPdf(input: {
  sourceBytes: Uint8Array; signaturePngBytes: Uint8Array; receipt: NativeSigningReceipt; template: PdfFieldTemplate;
}): Promise<Uint8Array> {
  const { sourceBytes, signaturePngBytes, receipt, template } = input;
  validateReceipt(receipt);
  if (sourceBytes.length > 30 * 1024 * 1024 || hash(sourceBytes) !== receipt.sourceSha256 || hash(signaturePngBytes) !== receipt.signatureSha256) throw new Error("native_signing_source_binding_invalid");
  inspectNativeSignaturePng(signaturePngBytes);
  const pdf = await PDFDocument.load(sourceBytes, { updateMetadata: false });
  if (pdf.getPageCount() !== template.pageSizes.length || pdf.getPageCount() > 100 || pdf.getForm().getFields().length) throw new Error("native_signing_snapshot_mismatch");
  for (const [index, page] of pdf.getPages().entries()) {
    const expected = template.pageSizes[index], crop = page.getCropBox(), media = page.getMediaBox();
    if (page.getRotation().angle % 360 || expected.width !== page.getWidth() || expected.height !== page.getHeight()
      || crop.x !== 0 || crop.y !== 0 || media.x !== 0 || media.y !== 0 || crop.width !== media.width || crop.height !== media.height) throw new Error("native_signing_snapshot_mismatch");
  }
  const fields = template.fields.filter(field => field.type === "signature");
  if (!fields.length || !fields.some(field => field.required) || new Set(fields.map(field => field.id)).size !== fields.length) throw new Error("native_signing_signature_fields_missing");
  const png = await pdf.embedPng(signaturePngBytes);
  for (const field of fields) {
    if (!field.placements.length || field.source !== "") throw new Error("native_signing_signature_field_invalid");
    for (const area of field.placements) {
      if (!Number.isInteger(area.page) || !template.pageSizes[area.page] || ![area.x, area.y, area.width, area.height].every(Number.isFinite)
        || area.x < 0 || area.y < 0 || area.width <= 0 || area.height <= 0 || area.x + area.width > 1.000001 || area.y + area.height > 1.000001) throw new Error("native_signing_signature_area_invalid");
      const page = pdf.getPage(area.page);
      page.drawImage(png, signatureImagePlacement(page.getWidth(), page.getHeight(), png.width, png.height, area));
    }
  }
  await appendReceipt(pdf, receipt, false);
  setMetadata(pdf, receipt, "Undertecknat avtal");
  return pdf.save({ useObjectStreams: false });
}

export async function renderNativeAuditPdf(receipt: NativeSigningReceipt): Promise<Uint8Array> {
  validateReceipt(receipt);
  const pdf = await PDFDocument.create({ updateMetadata: false });
  await appendReceipt(pdf, receipt, true);
  setMetadata(pdf, receipt, "Signeringsunderlag");
  return pdf.save({ useObjectStreams: false });
}
