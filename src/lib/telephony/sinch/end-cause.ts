/**
 * Hur ett avslutat webbläsarsamtal ska rapporteras.
 *
 * Klienten rapporterade `ended` för varje avslut, också när Sinch själv bröt
 * samtalet (GENERALERROR). Servern gjorde det till `unanswered`, och den
 * automatiska listdialern bokförde "inget svar" och ringde nästa prospekt --
 * med ett trasigt konto rusade den igenom hela listan och förbrukade varje
 * prospekts försök. Ett tekniskt fel är `failed`: då stannar dialern.
 *
 * Numren är `CallEndCause` i `sinch-rtc` 2.48.11.
 */
export const SINCH_END_CAUSES = ["None", "Timeout", "Denied", "NoAnswer", "Failure", "HungUp", "Canceled", "OtherDeviceAnswered", "Inactive"];

const FAILED_CAUSES = new Set(["Failure", "Denied"]);

export function sinchEndCauseName(cause: unknown): string {
  return typeof cause === "number" ? SINCH_END_CAUSES[cause] ?? `cause_${cause}` : "unknown";
}

export function legEventForSinchEnd(cause: unknown): "ended" | "failed" {
  return FAILED_CAUSES.has(sinchEndCauseName(cause)) ? "failed" : "ended";
}
