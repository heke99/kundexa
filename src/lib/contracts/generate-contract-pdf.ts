import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { CanonicalContractSnapshot } from "@/lib/contracts/canonical-contract-snapshot";

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 54;
const BODY_SIZE = 10.5;
const LINE_HEIGHT = 15;

function text(value: unknown) {
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

function wrap(value: string, font: PDFFont, size: number, width: number) {
  const lines: string[] = [];
  for (const paragraph of value.replace(/\r/g, "").split("\n")) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean).flatMap(word => {
      if (font.widthOfTextAtSize(word, size) <= width) return [word];
      const pieces: string[] = []; let piece = "";
      for (const character of word) {
        if (piece && font.widthOfTextAtSize(piece + character, size) > width) { pieces.push(piece); piece = ""; }
        piece += character;
      }
      if (piece) pieces.push(piece);
      return pieces;
    });
    if (!words.length) { lines.push(""); continue; }
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) > width && line) {
        lines.push(line);
        line = word;
      } else line = candidate;
    }
    if (line) lines.push(line);
  }
  return lines;
}

export async function generateContractPdf(snapshot: CanonicalContractSnapshot, snapshotHash: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${snapshot.contract.number} – ${snapshot.contract.title}`);
  pdf.setAuthor(text(snapshot.seller.legal_name ?? "Kundexa"));
  pdf.setSubject("Kanonisk avtalsversion");
  pdf.setKeywords(["Kundexa", "avtal", snapshot.contract.number]);
  pdf.setCreationDate(new Date(snapshot.generated_at));
  pdf.setModificationDate(new Date(snapshot.generated_at));

  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let page: PDFPage;
  let y: number;

  const newPage = () => {
    page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    y = PAGE_HEIGHT - MARGIN;
    page.drawText(snapshot.contract.number, { x: MARGIN, y: 26, size: 8, font: regular, color: rgb(0.35, 0.4, 0.42) });
    page.drawText(`Version ${snapshot.version.number}`, { x: PAGE_WIDTH - MARGIN - 58, y: 26, size: 8, font: regular, color: rgb(0.35, 0.4, 0.42) });
  };
  newPage();

  const ensure = (height: number) => { if (y - height < 48) newPage(); };
  const drawLines = (value: string, options?: { size?: number; font?: PDFFont; gapAfter?: number; color?: ReturnType<typeof rgb> }) => {
    const size = options?.size ?? BODY_SIZE;
    const font = options?.font ?? regular;
    const lines = wrap(value, font, size, PAGE_WIDTH - MARGIN * 2);
    ensure(LINE_HEIGHT);
    for (const line of lines) {
      ensure(LINE_HEIGHT);
      page.drawText(line || " ", { x: MARGIN, y, size, font, color: options?.color ?? rgb(0.08, 0.12, 0.14) });
      y -= LINE_HEIGHT;
    }
    y -= options?.gapAfter ?? 0;
  };
  const heading = (value: string) => { ensure(28); y -= 3; drawLines(value, { size: 13, font: bold, gapAfter: 6, color: rgb(0.04, 0.35, 0.28) }); };
  const row = (label: string, value: unknown) => {
    const labels = wrap(label, bold, 9, 130);
    const lines = wrap(text(value), regular, 9, PAGE_WIDTH - MARGIN * 2 - 145);
    for (let index = 0; index < Math.max(labels.length, lines.length); index++) {
      ensure(16);
      if (labels[index]) page.drawText(labels[index], { x: MARGIN, y, size: 9, font: bold, color: rgb(0.25, 0.3, 0.32) });
      if (lines[index]) page.drawText(lines[index], { x: MARGIN + 145, y, size: 9, font: regular });
      y -= 13;
    }
    y -= 3;
  };

  drawLines(text(snapshot.seller.legal_name ?? "Avtal"), { size: 10, font: bold, color: rgb(0.04, 0.35, 0.28) });
  drawLines(snapshot.contract.title, { size: 22, font: bold, gapAfter: 4 });
  drawLines(`Avtal ${snapshot.contract.number} · Version ${snapshot.version.number}`, { size: 10, gapAfter: 14, color: rgb(0.35, 0.4, 0.42) });

  heading("Avtalsparter");
  row("Juridisk avsändare", snapshot.seller.legal_name);
  row("Organisationsnummer", snapshot.seller.organization_number);
  row("Adress", [snapshot.seller.address_line1, snapshot.seller.postal_code, snapshot.seller.city].filter(Boolean).join(", "));
  row("Kontakt", [snapshot.seller.email, snapshot.seller.phone_e164].filter(Boolean).join(" · "));
  row("Kund", snapshot.counterparty.display_name ?? snapshot.counterparty.company_name);
  row("Kund-ID", snapshot.counterparty.organization_number ?? snapshot.counterparty.personal_identity_number);
  row("Kundadress", [snapshot.counterparty.address_line1, snapshot.counterparty.postal_code, snapshot.counterparty.city].filter(Boolean).join(", "));
  row("Kundkontakt", [snapshot.counterparty.email, snapshot.counterparty.phone_e164].filter(Boolean).join(" · "));

  heading("Kommersiella villkor");
  row("Produkt", snapshot.version.commercial_terms.product_name);
  row("Avtalsvärde", `${snapshot.contract.value.toLocaleString("sv-SE")} ${snapshot.contract.currency}`);
  row("Startdatum", snapshot.contract.starts_on);
  row("Slutdatum", snapshot.contract.ends_on);
  row("Bindningstid", snapshot.contract.binding_months === null ? "Ingen angiven" : `${snapshot.contract.binding_months} månader`);
  row("Uppsägningstid", snapshot.contract.notice_months === null ? "Ej angiven" : `${snapshot.contract.notice_months} månader`);
  row("Betalningsvillkor", snapshot.version.commercial_terms.payment_terms_days != null ? `${snapshot.version.commercial_terms.payment_terms_days} dagar` : "Ej angivet");
  row("Uppläggningsavgift", `${text(snapshot.version.commercial_terms.setup_fee)} ${snapshot.contract.currency}`);
  row("Återkommande avgift", `${text(snapshot.version.commercial_terms.recurring_fee)} ${snapshot.contract.currency}`);
  row("Rörlig avgift", `${text(snapshot.version.commercial_terms.variable_fee)} ${snapshot.contract.currency}`);

  const customFields = snapshot.version.commercial_terms.custom_fields as { definitions?: Array<{ id: string; label: string }>; values?: Record<string, unknown> } | null;
  if (customFields?.definitions?.length) {
    heading("Kundens avtalsuppgifter");
    for (const field of customFields.definitions) row(field.label, customFields.values?.[field.id]);
  }
  heading("Avtalstext");
  drawLines(snapshot.version.body, { gapAfter: 8 });
  heading("Villkor");
  drawLines(snapshot.version.terms || "Inga ytterligare villkor.", { gapAfter: 8 });

  heading("Spårbar dokumentreferens");
  row("Snapshot SHA-256", snapshotHash);
  row("Dokumentreferens", `${snapshot.contract.id}/${snapshot.version.id}`);
  row("Källsamtal", `${snapshot.source_call.id} · avslutat ${snapshot.source_call.ended_at}`);
  drawLines("PDF-filens SHA-256 beräknas över de slutliga PDF-bytesen och registreras separat i Kundexas privata dokumentregister. Den kan inte skrivas in i samma PDF utan att ändra PDF-bytesen.", { size: 8.5, color: rgb(0.35, 0.4, 0.42) });

  return pdf.save({ useObjectStreams: false, addDefaultPage: false });
}
