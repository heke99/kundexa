import "server-only";
import { sinchNumberProvider } from "./sinch";
import { NumberProviderError, type NumberProvider } from "./provider";

export type { AvailableNumber, NumberProvider, NumberSearchQuery, RentedNumber } from "./provider";
export { NumberProviderError } from "./provider";

/**
 * Registret. Den enda filen utanför adaptern som får nämna leverantören.
 *
 * Utan det här steget importerade serveråtgärden adaptern direkt, och då stod
 * leverantörens namn i affärslogiken igen -- precis den bindning hela
 * omskrivningen tog bort.
 */
const REGISTRY: Record<string, NumberProvider> = { sinch: sinchNumberProvider };

export function numberProvider(): NumberProvider {
  const id = process.env.TELEPHONY_PROVIDER?.trim() || sinchNumberProvider.id;
  const provider = REGISTRY[id];
  // Ett okänt namn är en felkonfiguration. En tyst fallback hade hyrt numret hos
  // fel leverantör, vilket är en faktura som inte går att ångra.
  if (!provider) throw new NumberProviderError("number_provider_unknown", `Okänd nummerleverantör: ${id}`);
  return provider;
}
