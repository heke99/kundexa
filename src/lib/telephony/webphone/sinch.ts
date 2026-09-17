import "server-only";
import { serverEnv } from "@/lib/env";
import {
  mintSinchRegistrationToken,
  SINCH_DEFAULT_TOKEN_TTL_SECONDS,
} from "@/lib/telephony/sinch/registration-token";
import type { WebphoneProvider, WebphoneProvisionResult } from "./provider";

/**
 * Sinch In-App Calling som webbtelefon.
 *
 * Säljaren behöver inget konto hos leverantören och
 * ingen registrerad enhet. Klienten identifierar sig med Kundexas eget
 * användar-ID, och servern intygar det med en kortlivad JWT. Ingen
 * provisionering, ingen enhetsmappning, ingen seat-policy.
 *
 * Applikationshemligheten lämnar aldrig servern. Sinch är själva tydliga med
 * det: "In production, generate this token on your backend; never embed the
 * secret in client-side code."
 */
export const sinchWebphoneProvider: WebphoneProvider = {
  key: "sinch",
  async provision(input): Promise<WebphoneProvisionResult> {
    const env = serverEnv();
    const applicationKey = env.SINCH_APPLICATION_KEY?.trim();
    const applicationSecret = env.SINCH_APPLICATION_SECRET?.trim();

    // Varje nej har sin egen kod och sin egen mening. "Något gick fel" lämnar
    // säljaren utan nästa steg och administratören utan felsökning.
    if (!applicationKey || !applicationSecret) {
      return {
        available: false,
        code: "webphone_provider_not_configured",
        message:
          "Webbtelefonen är inte konfigurerad ännu. Administratören behöver lägga in "
          + "Kundexas nycklar för telefonitjänsten innan samtal kan ringas härifrån.",
      };
    }

    // Sinch dokumenterar att ett utgående samtal utan CLI får ett samtals-ID i
    // svaret men aldrig når mottagaren. Att dela ut uppgifter ändå hade gett en
    // webbtelefon som ringer utan att ringa, och en säljare som väntar på svar
    // från ett samtal som aldrig lämnade oss.
    if (!input.callerIdentifier) {
      return {
        available: false,
        code: "webphone_caller_id_missing",
        message:
          "Företaget har inget telefonnummer att visa för mottagaren, och ett samtal utan "
          + "avsändarnummer kopplas aldrig fram. Administratören behöver beställa ett nummer "
          + "och välja det som företagets förvalda nummer.",
      };
    }

    let minted: { token: string; expiresAt: string };
    try {
      minted = mintSinchRegistrationToken({
        applicationKey,
        applicationSecret,
        // Kundexas användar-ID, inte ett konto hos leverantören. Det är det som
        // gör att en ny säljare kan ringa direkt utan att registreras någon
        // annanstans först.
        userId: input.sellerUserId,
        ttlSeconds: SINCH_DEFAULT_TOKEN_TTL_SECONDS,
      });
    } catch (error) {
      // Hemligheten får aldrig nå en logg. Bara felets namn skrivs.
      console.error("sinch_registration_token_failed", {
        reason: error instanceof Error ? error.message : "unknown",
      });
      return {
        available: false,
        code: "webphone_token_failed",
        message:
          "Webbtelefonens inloggningsuppgifter kunde inte skapas. Administratören behöver "
          + "kontrollera Kundexas nycklar för telefonitjänsten.",
      };
    }

    return {
      available: true,
      credentials: {
        kind: "sinch_rtc",
        provider: "sinch",
        applicationKey,
        userId: input.sellerUserId,
        environmentHost: env.SINCH_RTC_ENVIRONMENT_HOST,
        token: minted.token,
        callerIdentifier: input.callerIdentifier,
        expiresAt: minted.expiresAt,
      },
    };
  },
};
