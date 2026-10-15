import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { FrozenPdfTemplate } from "./pdf-field-template";

export async function inspectTemplatePdf(bytes: Uint8Array) {
  if (bytes.byteLength > 10 * 1024 * 1024 || Buffer.from(bytes.subarray(0, 5)).toString() !== "%PDF-") throw new Error("pdf_template_invalid_file");
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  if (!pdf.getPageCount() || pdf.getPageCount() > 100) throw new Error("pdf_template_page_limit");
  if (pdf.getForm().getFields().length) throw new Error("pdf_template_remove_interactive_fields");
  return pdf.getPages().map(page => {
    if (page.getRotation().angle % 360 !== 0) throw new Error("pdf_template_normalize_page_rotation");
    const crop = page.getCropBox(); const media = page.getMediaBox();
    if (media.x !== 0 || media.y !== 0 || crop.x !== 0 || crop.y !== 0 || crop.width !== media.width || crop.height !== media.height) throw new Error("pdf_template_normalize_page_crop");
    return { width: page.getWidth(), height: page.getHeight() };
  });
}

export async function renderPdfFields(bytes: Uint8Array, frozen: FrozenPdfTemplate): Promise<Uint8Array> {
  const sizes = await inspectTemplatePdf(bytes);
  if (JSON.stringify(sizes) !== JSON.stringify(frozen.template.pageSizes)) throw new Error("pdf_template_page_sizes_changed");
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const field of frozen.template.fields) {
    if (field.type === "signature") continue; // Left for the real signer; never auto-sign.
    const value = frozen.values[field.id];
    if (value === undefined || (field.required && !value)) throw new Error(`pdf_template_required_value:${field.label}`);
    for (const area of field.placements) {
      const page = pdf.getPage(area.page);
      const width = area.width * page.getWidth();
      const height = area.height * page.getHeight();
      // Reject overflow and unsupported glyphs, never silently clip customer data.
      const lines = value.replace(/\r/g, "").split("\n");
      const lineHeight = field.fontSize * 1.2;
      if (lines.length * lineHeight > height || lines.some(line => font.widthOfTextAtSize(line, field.fontSize) > width - 4)) throw new Error(`pdf_template_text_overflow:${field.label}`);
      for (const [index, line] of lines.entries()) page.drawText(line, { x: area.x * page.getWidth() + 2, y: page.getHeight() * (1 - area.y) - field.fontSize - index * lineHeight, size: field.fontSize, font, color: rgb(0, 0, 0) });
    }
  }
  pdf.setProducer("Kundexa PDF field rendering");
  return pdf.save({ useObjectStreams: false });
}
