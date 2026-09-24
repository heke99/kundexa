/**
 * Efterarbetet som knappar i stället för en rullista.
 *
 * Säljaren öppnade en rullista med tio utfall efter varje samtal. Utfallen
 * grupperas nu efter vad de betyder (affär, återkomst, nej, nåddes inte,
 * spärr) och väljs med ett klick eller en siffertangent. Grupperingen följer
 * listans egen `outcome_group`, så en lista med egna utfall behåller dem.
 */

export type OutcomeGroupKey = "positive" | "neutral" | "negative" | "unreachable" | "blocked";

export type OutcomeOption = {
  key: string;
  label: string;
  outcomeGroup: string;
  requiresNote?: boolean;
  requiresCallback?: boolean;
  requiresOrder?: boolean;
  contractEligible?: boolean;
};

export type OutcomeGroup = {
  key: string;
  label: string;
  tone: "success" | "info" | "neutral" | "muted" | "danger";
  options: Array<OutcomeOption & { shortcut: number | null }>;
};

const groupOrder: Array<{ key: OutcomeGroupKey; label: string; tone: OutcomeGroup["tone"] }> = [
  { key: "positive", label: "Affär", tone: "success" },
  { key: "neutral", label: "Följ upp", tone: "info" },
  { key: "negative", label: "Nej", tone: "neutral" },
  { key: "unreachable", label: "Nåddes inte", tone: "muted" },
  { key: "blocked", label: "Spärra", tone: "danger" },
];

/** Grupperar utfallen i fast ordning. Siffertangent 1–9 följer visningsordningen. */
export function groupOutcomes(options: OutcomeOption[]): OutcomeGroup[] {
  const known = new Set<string>(groupOrder.map((group) => group.key));
  const groups: OutcomeGroup[] = groupOrder.map((group) => ({
    ...group,
    options: options.filter((option) => option.outcomeGroup === group.key).map((option) => ({ ...option, shortcut: null })),
  }));
  const other = options.filter((option) => !known.has(option.outcomeGroup));
  if (other.length) groups.push({ key: "other", label: "Övrigt", tone: "neutral", options: other.map((option) => ({ ...option, shortcut: null })) });
  let next = 1;
  for (const group of groups) {
    for (const option of group.options) {
      if (next <= 9) option.shortcut = next++;
    }
  }
  return groups.filter((group) => group.options.length > 0);
}

/** Utfallen i det fristående efterarbetet (kundkortet och dialersidan). Samma nycklar som `complete_manual_call_work_v2`. */
export const manualOutcomeOptions: OutcomeOption[] = [
  { key: "interested", label: "Intresserad", outcomeGroup: "positive" },
  { key: "callback", label: "Återkomst", outcomeGroup: "neutral", requiresCallback: true },
  { key: "not_interested", label: "Inte intresserad", outcomeGroup: "negative" },
  { key: "wrong_number", label: "Fel nummer", outcomeGroup: "negative" },
  { key: "no_answer", label: "Inget svar", outcomeGroup: "unreachable" },
  { key: "busy", label: "Upptaget", outcomeGroup: "unreachable" },
  { key: "voicemail", label: "Telefonsvarare", outcomeGroup: "unreachable" },
  { key: "do_not_call", label: "Ring inte igen", outcomeGroup: "blocked" },
  { key: "nix_listed", label: "NIX-registrerad", outcomeGroup: "blocked" },
];

function pad(value: number) { return String(value).padStart(2, "0"); }

/** `YYYY-MM-DDTHH:mm` i webbläsarens lokala tid, samma format som `datetime-local`. */
export function toLocalDateTimeInput(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function nextWeekday(date: Date) {
  const result = new Date(date);
  while (result.getDay() === 0 || result.getDay() === 6) result.setDate(result.getDate() + 1);
  return result;
}

/**
 * Snabbval för återkomst. "I morgon" och "Om en vecka" hoppar över helgen;
 * "Om en timme" avrundas till närmaste kvart framåt så att tiden går att läsa.
 */
export function callbackPresets(now: Date): Array<{ label: string; value: string }> {
  const inHour = new Date(now.getTime() + 60 * 60_000);
  inHour.setSeconds(0, 0);
  inHour.setMinutes(Math.ceil(inHour.getMinutes() / 15) * 15);
  const afternoon = new Date(now);
  afternoon.setHours(15, 0, 0, 0);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  const nextWeek = new Date(now);
  nextWeek.setDate(nextWeek.getDate() + 7);
  nextWeek.setHours(9, 0, 0, 0);
  const presets = [{ label: "Om en timme", value: toLocalDateTimeInput(inHour) }];
  if (afternoon.getTime() - now.getTime() > 30 * 60_000) presets.push({ label: "I eftermiddag 15:00", value: toLocalDateTimeInput(afternoon) });
  presets.push({ label: "Nästa vardag 09:00", value: toLocalDateTimeInput(nextWeekday(tomorrow)) });
  presets.push({ label: "Om en vecka", value: toLocalDateTimeInput(nextWeekday(nextWeek)) });
  return presets;
}
