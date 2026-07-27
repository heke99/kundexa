import { escapeHtml, renderEmailLayout } from "@/lib/email/render-email-layout";

export function renderContractDeliveryEmail(input: {
  legalName: string; customerName: string; contractNumber: string; contractTitle: string;
  acceptUrl: string; expiresAt: string; introduction?: string | null; contact?: string | null; logoUrl?: string | null;
}) {
  const bodyHtml = `<p style="font-size:16px;line-height:1.65">Hej ${escapeHtml(input.customerName)},</p>${input.introduction ? `<p style="font-size:15px;line-height:1.65">${escapeHtml(input.introduction)}</p>` : ""}<p style="font-size:15px;line-height:1.65">Du har fått avtalet <strong>${escapeHtml(input.contractNumber)}</strong> – ${escapeHtml(input.contractTitle)}. Den exakta avtalsversionen finns även bifogad som PDF.</p><p style="margin:28px 0"><a href="${escapeHtml(input.acceptUrl)}" style="display:inline-block;background:#0d7d65;color:#fff;text-decoration:none;padding:13px 20px;border-radius:9px;font-weight:bold">Granska och acceptera avtalet</a></p><p style="font-size:13px;line-height:1.6;color:#5f6d6a">Sista svarsdatum: ${escapeHtml(input.expiresAt)}. Länken är personlig och ska inte vidarebefordras.</p><p style="font-size:12px;word-break:break-all;color:#71807c">Reservlänk: ${escapeHtml(input.acceptUrl)}</p>`;
  const text = `Hej ${input.customerName},\n\nDu har fått avtalet ${input.contractNumber} – ${input.contractTitle}.\n\nGranska och lämna ditt besked: ${input.acceptUrl}\n\nSista svarsdatum: ${input.expiresAt}. Länken är personlig.\n\n${input.legalName}`;
  return { subject: `Avtal ${input.contractNumber} från ${input.legalName}`, html: renderEmailLayout({ preheader: `Granska avtal ${input.contractNumber}`, heading: "Ett avtal väntar på ditt besked", bodyHtml, legalName: input.legalName, contact: input.contact, logoUrl: input.logoUrl }), text };
}
