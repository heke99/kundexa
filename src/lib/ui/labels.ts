/**
 * Databasvärden på svenska.
 *
 * Säljaren såg `unanswered`, `not_interested`, `outbound` och `prospect` rakt av
 * på kundkortet, i samtalslistan och på listorna. Allt som visas för en
 * människa går genom de här funktionerna; ett okänt värde visas som det är
 * hellre än att döljas.
 */
const callStatus: Record<string, string> = {
  queued: "Köat", requested: "Begärt", initiating: "Kopplas", dial_requested: "Kopplas", initiated: "Kopplas",
  awaiting_provider_event: "Kopplas", provider_outcome_unknown: "Oklart utfall", reconciliation_required: "Stäms av",
  ringing: "Ringer", answered: "Pågår", in_progress: "Pågår", completed: "Besvarat",
  unanswered: "Inget svar", no_answer: "Inget svar", busy: "Upptaget", voicemail: "Telefonsvarare",
  failed: "Kopplades inte", blocked: "Spärrat", outside_business_hours: "Utanför ringtid", cancelled: "Avbrutet",
};

const disposition: Record<string, string> = {
  interested: "Intresserad", not_interested: "Inte intresserad", callback: "Återkomst", no_answer: "Inget svar",
  busy: "Upptaget", voicemail: "Telefonsvarare", wrong_number: "Fel nummer", do_not_call: "Ring inte igen",
  nix_listed: "NIX-registrerad", order: "Order", contract: "Avtal", contract_requested: "Vill ha avtal",
  sale: "Försäljning", sold: "Sålt",
};

const lifecycle: Record<string, string> = {
  prospect: "Prospekt", lead: "Lead", customer: "Kund", former_customer: "Tidigare kund",
};

const memberState: Record<string, string> = {
  pending: "Väntar", claimed: "Låst", dialing: "Ringer", after_call: "Efterarbete", retry: "Nytt försök",
  callback: "Återkomst", completed: "Klar", blocked: "Spärrad", skipped: "Hoppades över",
};

const noteType: Record<string, string> = {
  general: "Anteckning", call: "Samtal", callback: "Återkomst", order: "Order", internal: "Intern",
};

const visibility: Record<string, string> = { private: "Privat", team: "Team", tenant: "Hela företaget" };

const pick = (map: Record<string, string>) => (value: string | null | undefined) => value ? map[value] ?? value : "—";

export const callStatusLabel = pick(callStatus);
export const dispositionLabel = pick(disposition);
export const lifecycleLabel = pick(lifecycle);
export const memberStateLabel = pick(memberState);
export const noteTypeLabel = pick(noteType);
export const visibilityLabel = pick(visibility);

export function callDirectionLabel(direction: string | null | undefined) {
  return direction === "inbound" ? "Inkommande" : direction === "outbound" ? "Utgående" : "—";
}
