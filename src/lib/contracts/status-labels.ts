/**
 * Avtalets status och händelser på svenska, på ett ställe.
 *
 * Varje sida hade sin egen karta, och de gick isär: kundkortet och startsidan
 * visade det råa engelska värdet, startsidan färgade bara `signed` grönt fast
 * ett godkännande via länken blir `accepted`, och händelselistan visade
 * `contract.sent` och `acceptance.opened` rakt av.
 */
export const contractStatusLabels: Record<string, string> = {
  draft: "Utkast",
  ready: "Redo",
  sent: "Skickat",
  delivered: "Levererat",
  opened: "Öppnat av kunden",
  signing: "Delvis godkänt",
  accepted: "Godkänt",
  declined: "Avböjt",
  expired: "Utgånget",
  signed: "Signerat",
  active: "Aktivt",
  cancelled: "Avbrutet",
  terminated: "Avslutat",
  superseded: "Ersatt",
};

const deliveryLabels: Record<string, string> = {
  draft: "Utkast", queued: "Köad", submitting: "Skickas", created: "Skapad", sent: "Skickat",
  delayed: "Fördröjt", delivered: "Levererat", opened: "Öppnat", clicked: "Länk klickad",
  failed: "Misslyckades", bounced: "Studsade", complained: "Markerat som skräp", suppressed: "Spärrad adress",
  cancelled: "Avbrutet", dead_letter: "Kräver åtgärd", pending: "Väntar",
  accepted_via_web: "Godkänt via länk", accepted_via_sms: "Godkänt via SMS",
  manual_review_required: "Oklart svar", expired: "Utgånget", superseded: "Ersatt",
};

const eventLabels: Record<string, string> = {
  "contract.created": "Avtalet skapades",
  "contract.sent": "Avtalet skickades",
  "contract.accepted_via_web": "Kunden godkände via länken",
  "contract.accepted_via_sms": "Kunden godkände via SMS",
  "contract.declined": "Kunden avböjde",
  "contract.expired": "Svarstiden gick ut",
  "contract.cancelled": "Avtalet avbröts",
  "acceptance.opened": "Kunden öppnade avtalet",
  "email.sent": "E-post skickad",
  "email.delivered": "E-post levererad",
  "email.opened": "E-post öppnad",
  "email.clicked": "Länken i e-posten klickades",
  "email.bounced": "E-posten studsade",
  "email.complained": "E-posten markerades som skräp",
  "email.delivery_delayed": "E-posten försenad",
  "sms.delivered": "SMS levererat",
  "sms.failed": "SMS kunde inte levereras",
  "contract.reply_needs_review": "Kunden svarade något oklart – kontakta kunden",
  "contract.acceptance_manual_review": "Svaret behöver granskas",
  "contract.acceptance_recorded": "Kundens besked registrerades",
  "contract.accepted": "Kunden godkände",
  "contract.signed": "Avtalet är fullständigt signerat",
  "contract.activated": "Avtalet aktiverades",
  "contract.commercial_terms_bound": "Villkor och ägare sparades",
  "contract.template_bound": "Avtalstexten valdes",
  "contract.source_call_linked": "Källsamtalet kopplades",
  "source_call.linked": "Källsamtalet kopplades",
  "contract.expiry_extended": "Sista svarsdag förlängdes",
  "contract.api_expiry_extended": "Sista svarsdag förlängdes via API",
  "contract.api_created": "Avtalet skapades via API",
  "contract.api_sent": "Avtalet skickades via API",
  "contract.reminder_scheduled": "Påminnelse schemalades",
  "contract.api_reminder_scheduled": "Påminnelse schemalades via API",
  "contract.reminder_queued": "Påminnelse köades",
  "contract.reminders_cancelled": "Påminnelser stoppades",
  "contract.confirmation_queued": "Bekräftelse till kunden köades",
  "document.canonical_generated": "Avtalets PDF skapades",
  "document.uploaded": "Dokument laddades upp",
  "evidence.completed": "Bevispaketet är klart",
};

export function contractStatusLabel(status: string | null | undefined) {
  return status ? contractStatusLabels[status] ?? status : "—";
}

export function deliveryStatusLabel(status: string | null | undefined) {
  return status ? deliveryLabels[status] ?? contractStatusLabels[status] ?? status : "—";
}

export function contractEventLabel(eventType: string) {
  return eventLabels[eventType] ?? eventType;
}

/** Grönt för ja, rött för nej, gult för det som kräver åtgärd, blått för väntan. */
export function contractStatusTone(status: string | null | undefined) {
  if (!status) return "";
  if (["accepted", "signed", "active"].includes(status)) return "badge-success";
  if (["declined"].includes(status)) return "badge-danger";
  if (["expired", "cancelled"].includes(status)) return "badge-warning";
  return "badge-info";
}

/** Avtal där kunden har svarat ja, nej eller låtit tiden gå ut. */
export const CONTRACT_ANSWER_EVENTS = ["contract.accepted_via_web", "contract.accepted_via_sms", "contract.declined", "contract.expired"] as const;
