export type AcceptanceDecision = "accepted" | "declined" | "manual_review";

export function normalizeAcceptanceText(value: string) {
  return value.trim().toLocaleUpperCase("sv-SE").replace(/[.,!?:;]+$/g, "").replace(/\s+/g, " ");
}

export function decideAcceptance(
  input: string,
  code: string,
  allowCodeLess = false,
  allowedPhrases: string[] = ["JA", "OK", "GODKÄNNER", "ACCEPTERAR"],
  declinePhrases: string[] = ["NEJ", "AVSTÅR"],
): AcceptanceDecision {
  const normalized = normalizeAcceptanceText(input);
  const normalizedCode = normalizeAcceptanceText(code);
  const accepts = allowedPhrases.map(normalizeAcceptanceText);
  const declines = declinePhrases.map(normalizeAcceptanceText);

  if (normalizedCode) {
    if (accepts.some((phrase) => normalized === `${phrase} ${normalizedCode}`)) return "accepted";
    if (declines.some((phrase) => normalized === `${phrase} ${normalizedCode}`)) return "declined";
  }
  if (allowCodeLess && accepts.includes(normalized)) return "accepted";
  if (allowCodeLess && declines.includes(normalized)) return "declined";
  return "manual_review";
}
