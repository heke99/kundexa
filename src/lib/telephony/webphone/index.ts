import "server-only";
import { rinkelWebphoneProvider } from "./rinkel";
import { sinchWebphoneProvider } from "./sinch";
import type { WebphoneProvider, WebphoneProvisionInput, WebphoneProvisionResult } from "./provider";

export type { WebphoneCredentials, WebphoneProvisionResult } from "./provider";

const providers = new Map<string, WebphoneProvider>([
  [rinkelWebphoneProvider.key, rinkelWebphoneProvider],
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
