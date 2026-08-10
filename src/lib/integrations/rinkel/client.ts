import { serverEnv } from "@/lib/env";
import { RinkelClient, RinkelError, RINKEL_DEFAULT_BASE_URL, staleRinkelDeviceIds } from "../../../../supabase/functions/_shared/rinkel";

export { RinkelClient, RINKEL_DEFAULT_BASE_URL, staleRinkelDeviceIds };

export function isPlatformRinkelRuntimeConfigured() {
  const env = serverEnv();
  return Boolean(env.RINKEL_API_KEY?.trim());
}

export function createPlatformRinkelClient(requestId?: string) {
  const env = serverEnv();
  if (!env.RINKEL_API_KEY) {
    throw new RinkelError(
      "RINKEL_AUTHENTICATION_ERROR",
      "Kundexas centrala Rinkel-integration är inte konfigurerad.",
    );
  }
  return new RinkelClient({
    apiKey: env.RINKEL_API_KEY,
    baseUrl: env.RINKEL_API_BASE_URL,
    timeoutMs: env.RINKEL_REQUEST_TIMEOUT_MS,
    requestId,
  });
}
