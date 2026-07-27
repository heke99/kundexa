import { escapeHtml, renderEmailLayout } from "@/lib/email/render-email-layout";

export function renderContractExpiredEmail(input: {
  legalName: string;
  customerName: string;
  contractNumber: string;
  expiredAt: string;
  contact?: string | null;
  logoUrl?: string | null;
}) {
  const bodyHtml = `<p style="font-size:16px;line-height:1.65">Hej ${escapeHtml(input.customerName)},</p><p style="font-size:15px;line-height:1.65">Svarstiden för avtal <strong>${escapeHtml(input.contractNumber)}</strong> löpte ut ${escapeHtml(input.expiredAt)}. Den tidigare personliga länken kan därför inte längre användas.</p><p style="font-size:15px;line-height:1.65">Kontakta ${escapeHtml(input.legalName)} om du vill få en ny avtalsbegäran.</p>`;
  return {
    subject: `Svarstiden för avtal ${input.contractNumber} har löpt ut`,
    html: renderEmailLayout({ preheader: `Avtal ${input.contractNumber} har löpt ut`, heading: "Svarstiden har löpt ut", bodyHtml, legalName: input.legalName, contact: input.contact, logoUrl: input.logoUrl }),
    text: `Hej ${input.customerName},\n\nSvarstiden för avtal ${input.contractNumber} löpte ut ${input.expiredAt}. Den tidigare personliga länken kan inte längre användas. Kontakta ${input.legalName} om du behöver en ny avtalsbegäran.`,
  };
}
