import "server-only";
import { sinchWebphoneProvider } from "./sinch";
import type { WebphoneProvider, WebphoneProvisionInput, WebphoneProvisionResult } from "./provider";

export type { WebphoneCredentials, WebphoneProvisionResult } from "./provider";

const providers = new Map<string, WebphoneProvider>([
  [sinchWebphoneProvider.key, sinchWebphoneProvider],
]);

/**
 * Ingen adapter för leverantören är inte ett undantag att kasta — det är ett
 * svar att visa. Säljaren ska få veta att webbtelefonen inte är uppsatt, inte
 * mötas av "något gick fel".
 */
export async function provisionWebphone(
  provider: string,
  input: WebphoneProvisionInput,
): Promise<WebphoneProvisionResult> {
  const adapter = providers.get(provider);
  if (!adapter) {
    return {
      available: false,
      code: "webphone_provider_unknown",
      message: "Webbtelefonen är inte uppsatt för den här telefonitjänsten.",
    };
  }
  return adapter.provision(input);
}

export function webphoneProviderKeys() {
  return [...providers.keys()];
}

/**
 * Vilken telefonitjänst Kundexa kör mot.
 *
 * Kundexa har en central telefonitjänst, inte en per företag, så nyckeln är
 * densamma för alla. Den läses ändå härifrån och skrivs på sessionsraden,
 * eftersom hela webbtelefonen är byggd för att kunna byta leverantör utan att
 * gammal historik blir tvetydig -- och för att namnet ska stå på ett ställe.
 */
export function telephonyProviderKey() {
  const configured = process.env.TELEPHONY_PROVIDER?.trim();
  if (configured && providers.has(configured)) return configured;
  const [first] = providers.keys();
  return first;
}

/**
 * Går webbtelefonen att registrera alls?
 *
 * Frågan avgörs av adaptern, inte av namnen på serverns miljövariabler. Den
 * gamla versionen läste SINCH_* direkt i beredskapskontrollen, vilket betydde
 * att ett leverantörsbyte tystade den kontrollen i stället för att flytta den.
 */
export function telephonyConfigured() {
  return providers.get(telephonyProviderKey())?.isConfigured() === true;
}

/** Ord som aldrig ska nå en säljare, därför att de namnger vem vi köper av. */
export function redactProviderNames(message: string) {
  let redacted = message;
  for (const key of providers.keys()) {
    redacted = redacted.replace(new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "telefonitjänsten");
  }
  return redacted.replace(/provider/gi, "telefonitjänsten").replace(/leverantör/gi, "telefonitjänst");
}
