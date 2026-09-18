import "server-only";
import { serverEnv } from "@/lib/env";
import {
  NumberProviderError,
  type AvailableNumber,
  type NumberCapability,
  type NumberProvider,
  type NumberSearchQuery,
  type RentedNumber,
} from "./provider";

/**
 * Sinch Numbers API.
 *
 * Hela leverantörens vokabulär slutar här: OAuth2-token, projektets id,
 * `availableNumbers`, `:rent`. Utåt finns bara "sök" och "hyr".
 *
 * Numren konfigureras mot vårt SMS-service-plan och vår röstapplikation redan
 * vid hyrningen. Ett nummer som hyrs utan den kopplingen ligger och kostar utan
 * att kunna ta emot något, och den som upptäcker det gör det först när en kund
 * ringer tillbaka och ingenting händer.
 */

const NUMBERS_BASE = "https://numbers.api.sinch.com/v1";
const TOKEN_URL = "https://auth.sinch.com/oauth2/token";

type TokenCache = { token: string; expiresAt: number };
let cachedToken: TokenCache | null = null;

function credentials() {
  const env = serverEnv();
  return {
    projectId: env.SINCH_PROJECT_ID?.trim() ?? "",
    keyId: env.SINCH_KEY_ID?.trim() ?? "",
    keySecret: env.SINCH_KEY_SECRET?.trim() ?? "",
    servicePlanId: process.env.SMS_SERVICE_PLAN_ID?.trim() ?? "",
    voiceApplicationKey: env.SINCH_APPLICATION_KEY?.trim() ?? "",
  };
}

/**
 * Åtkomsttoken, återanvänd tills den nästan gått ut.
 *
 * Marginalen på sextio sekunder finns för att ett anrop som startar med en
 * token som går ut under resan misslyckas med 401, och det felet ser ut som en
 * felaktig nyckel för den som läser loggen.
 */
async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;
  const { keyId, keySecret } = credentials();
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
  });
  if (!response.ok) {
    throw new NumberProviderError("number_provider_auth_failed",
      "Kundexa kunde inte logga in mot nummerleverantören. Kontrollera nyckel-id och hemlighet.");
  }
  const payload = await response.json() as { access_token?: string; expires_in?: number };
  if (!payload.access_token) {
    throw new NumberProviderError("number_provider_auth_failed", "Nummerleverantören svarade utan åtkomsttoken.");
  }
  cachedToken = {
    token: payload.access_token,
    expiresAt: Date.now() + Math.max(60, Number(payload.expires_in ?? 3600)) * 1000,
  };
  return cachedToken.token;
}

async function call(path: string, init?: RequestInit) {
  const token = await accessToken();
  const response = await fetch(`${NUMBERS_BASE}${path}`, {
    ...init,
    headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
  const text = await response.text();
  if (!response.ok) {
    // Leverantörens felmeddelande loggas men lämnas inte ut. Det innehåller
    // projekt-id och ibland nyckelfragment.
    console.error("number_provider_request_failed", { path, status: response.status, body: text.slice(0, 500) });
    if (response.status === 401 || response.status === 403) {
      throw new NumberProviderError("number_provider_forbidden",
        "Nummerleverantören nekade begäran. Kontrollera att nyckeln har behörighet till nummer.");
    }
    if (response.status === 404) {
      throw new NumberProviderError("number_not_found", "Numret finns inte hos leverantören.");
    }
    if (response.status === 409) {
      throw new NumberProviderError("number_already_taken",
        "Numret hann bli upptaget. Sök igen och välj ett annat.");
    }
    throw new NumberProviderError("number_provider_failed",
      "Nummerleverantören kunde inte svara just nu. Försök igen om en stund.");
  }
  return text ? JSON.parse(text) as Record<string, unknown> : {};
}

/**
 * Fältnamnen nedan är avlästa ur leverantörens OpenAPI-spec, inte ur minnet.
 * Tre av dem var fel i första utkastet: söksidan heter `size` och inte
 * `pageSize`, priset heter `monthlyPrice` och inte `monthlyCost`, och
 * `voiceConfiguration` är en union som kräver sin `type`-diskriminator.
 */
function readCapabilities(value: unknown): NumberCapability[] {
  if (!Array.isArray(value)) return [];
  const capabilities: NumberCapability[] = [];
  for (const entry of value) {
    const name = String(entry).toUpperCase();
    if (name === "VOICE") capabilities.push("voice");
    if (name === "SMS") capabilities.push("sms");
  }
  return capabilities;
}

function readMoney(value: unknown): { amount: string; currency: string } | null {
  if (!value || typeof value !== "object") return null;
  const money = value as { amount?: unknown; currencyCode?: unknown };
  if (typeof money.amount !== "string" || typeof money.currencyCode !== "string") return null;
  return { amount: money.amount, currency: money.currencyCode };
}

export const sinchNumberProvider: NumberProvider = {
  id: "sinch",

  isConfigured() {
    const { projectId, keyId, keySecret } = credentials();
    return Boolean(projectId && keyId && keySecret);
  },

  async search(query: NumberSearchQuery): Promise<AvailableNumber[]> {
    const { projectId } = credentials();
    const url = new URLSearchParams({
      regionCode: query.regionCode,
      type: query.numberType,
      // `size`, inte `pageSize`: söket sidindelas inte, och parametern heter
      // olika på de två ändpunkterna. Ett tak sätts alltid -- en obegränsad
      // lista är en sida som aldrig laddar.
      size: String(Math.max(1, Math.min(query.limit ?? 20, 50))),
    });
    if (query.pattern) {
      url.set("numberPattern.pattern", query.pattern);
      url.set("numberPattern.searchPattern", "CONTAINS");
    }
    const payload = await call(`/projects/${encodeURIComponent(projectId)}/availableNumbers?${url}`);
    const numbers = Array.isArray(payload.availableNumbers) ? payload.availableNumbers : [];
    return numbers.map((entry) => {
      const number = entry as Record<string, unknown>;
      return {
        phoneNumber: String(number.phoneNumber ?? ""),
        regionCode: String(number.regionCode ?? query.regionCode),
        numberType: String(number.type ?? query.numberType),
        capabilities: readCapabilities(number.capability),
        monthlyPrice: readMoney(number.monthlyPrice),
        setupPrice: readMoney(number.setupPrice),
        documentationRequired: number.supportingDocumentationRequired === true,
      };
    }).filter((number) => number.phoneNumber);
  },

  async findActive(phoneNumber: string): Promise<RentedNumber | null> {
    const { projectId } = credentials();
    try {
      const payload = await call(
        `/projects/${encodeURIComponent(projectId)}/activeNumbers/${encodeURIComponent(phoneNumber)}`,
      );
      if (!payload.phoneNumber) return null;
      return { phoneNumber: String(payload.phoneNumber), capabilities: readCapabilities(payload.capability) };
    } catch (error) {
      // "Finns inte" är ett svar, inte ett fel: numret är helt enkelt inte vårt.
      if (error instanceof NumberProviderError && error.code === "number_not_found") return null;
      throw error;
    }
  },

  async rent(phoneNumber: string): Promise<RentedNumber> {
    const { projectId, servicePlanId, voiceApplicationKey } = credentials();
    const body: Record<string, unknown> = {};
    // Konfigurationen sätts vid hyrningen, inte efteråt. Ett andra anrop kan
    // misslyckas, och då står ett betalt nummer utan koppling till oss.
    //
    // Bara de block som faktiskt ska sättas skickas med: leverantören avvisar
    // ett tomt `voiceConfiguration` i stället för att ignorera det.
    if (servicePlanId) body.smsConfiguration = { servicePlanId };
    // `type` måste med. Fältet är unionens diskriminator, och utan den är det
    // inte definierat vilken av tre konfigurationer nyttolasten är.
    if (voiceApplicationKey) body.voiceConfiguration = { type: "RTC", appId: voiceApplicationKey };

    const payload = await call(
      `/projects/${encodeURIComponent(projectId)}/availableNumbers/${encodeURIComponent(phoneNumber)}:rent`,
      { method: "POST", body: JSON.stringify(body) },
    );
    const rented = String(payload.phoneNumber ?? phoneNumber);
    return { phoneNumber: rented, capabilities: readCapabilities(payload.capability) };
  },
};
