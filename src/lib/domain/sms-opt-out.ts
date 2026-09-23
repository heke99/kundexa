/**
 * Är svaret en avregistrering?
 *
 * Ett SMS-svar "STOPP" lagrades som ett vanligt inkommande meddelande och
 * ingenting mer: nästa utskick gick till samma nummer. Marknadsföringslagen
 * kräver att en avregistrering respekteras, och det är just det här svaret
 * som mottagaren förväntar sig ska fungera.
 *
 * Bara hela svaret räknas, inte ett ord i en mening -- "stoppa inte avtalet"
 * är inte en avregistrering.
 */
const OPT_OUT_WORDS = new Set(["stop", "stopp", "stoppa", "avsluta", "avregistrera", "sluta", "unsubscribe"]);

export function isSmsOptOut(message: string): boolean {
  const normalized = message.trim().toLowerCase().replace(/[.!?\s]+$/g, "");
  return OPT_OUT_WORDS.has(normalized);
}
