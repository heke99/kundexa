/**
 * TypeScript port of DocuSeal's normalized image fitting/centering formula:
 * lib/submissions/generate_result_attachments.rb, lines 490-515 at
 * 3c65b0e4ba872fe71d5566c0d09c3ace59a7fb8a. Copyright DocuSeal contributors.
 * AGPL-3.0 and UI attribution: third_party/docuseal/LICENSE{,_ADDITIONAL_TERMS}.
 * Original HexaPDF canvas calls replaced with a pure pdf-lib geometry result.
 */
export function signatureImagePlacement(pageWidth: number, pageHeight: number, imageWidth: number, imageHeight: number,
  area: { x: number; y: number; width: number; height: number }) {
  const scale = Math.min(area.width * pageWidth / imageWidth, area.height * pageHeight / imageHeight);
  return {
    x: area.x * pageWidth + area.width * pageWidth / 2 - imageWidth * scale / 2,
    y: pageHeight - area.y * pageHeight - imageHeight * scale / 2 - area.height * pageHeight / 2,
    width: imageWidth * scale,
    height: imageHeight * scale,
  };
}
