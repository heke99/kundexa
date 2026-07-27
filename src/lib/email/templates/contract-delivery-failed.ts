import { escapeHtml, renderEmailLayout } from "@/lib/email/render-email-layout";

export function renderContractDeliveryFailedEmail(input: {
  legalName: string;
  contractNumber: string;
  recipient: string;
  channel: "email" | "sms";
  reason: string;
  reference?: string | null;
  contact?: string | null;
  logoUrl?: string | null;
}) {
  const bodyHtml = `<p style="font-size:15px;line-height:1.65">Leveransen av avtal <strong>${escapeHtml(input.contractNumber)}</strong> till ${escapeHtml(input.recipient)} kunde inte slutföras via ${input.channel === "email" ? "e-post" : "SMS"}.</p><p style="font-size:15px;line-height:1.65"><strong>Orsak:</strong> ${escapeHtml(input.reason)}</p>${input.reference ? `<p style="font-size:13px;color:#5f6d6a">Referens: ${escapeHtml(input.reference)}</p>` : ""}<p style="font-size:15px;line-height:1.65">Kontrollera mottagaruppgifterna och leverantörsintegrationen innan ett nytt försök görs.</p>`;
  return {
    subject: `Leveransfel för avtal ${input.contractNumber}`,
    html: renderEmailLayout({ preheader: `Leveransfel för ${input.contractNumber}`, heading: "Avtalet kunde inte levereras", bodyHtml, legalName: input.legalName, contact: input.contact, logoUrl: input.logoUrl }),
    text: `Leveransen av avtal ${input.contractNumber} till ${input.recipient} misslyckades via ${input.channel}. Orsak: ${input.reason}${input.reference ? ` Referens: ${input.reference}` : ""}.`,
  };
}
