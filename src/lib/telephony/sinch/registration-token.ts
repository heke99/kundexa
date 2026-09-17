import { createHmac, randomUUID } from "node:crypto";

/**
 * Registreringstoken för Sinch In-App Calling.
 *
 * Webbläsarklienten anropar `onCredentialsRequired` och förväntar sig en JWT.
 * Sinch signerar den inte med applikationshemligheten direkt, utan med en nyckel
 * som härleds ur den en gång per dygn:
 *
 *   signingKey = HMAC256(BASE64-DECODE(applicationSecret), UTF8-ENCODE("YYYYMMDD"))
 *
 * Två fel är lätta att göra här och båda ger en token som ser riktig ut och
 * avvisas: att använda hemligheten som den är i stället för base64-avkodad, och
 * att byta plats på nyckel och meddelande i HMAC:en. Därför ligger härledningen
 * i en egen exporterad funktion med egna tester, och inte inlindad i signeringen.
 *
 * Hämtat från developers.sinch.com/docs/in-app-calling/js/application-authentication
 * 2026-09-17. Fälten nedan är dokumenterade, inte gissade.
 *
 * Modulen är avsiktligt utan `server-only`. Den läser varken miljön eller
 * förfrågan — allt kommer in som argument — och kan därför inte läcka en
 * hemlighet den aldrig håller. Vakten sitter i stället på `webphone/sinch.ts`,
 * som är den enda anroparen och den som faktiskt läser hemligheten ur miljön.
 * Att ha den här också hade bara gjort härledningen otestbar, och det är just
 * den delen som inte går att felsöka från ett avslag i produktion.
 */

export type SinchRegistrationTokenInput = {
  applicationKey: string;
  applicationSecret: string;
  userId: string;
  /** Livslängd i sekunder. Sinch kräver minst en minut. */
  ttlSeconds: number;
  now?: Date;
  nonce?: string;
};

/** Sinch kräver minst en minut. Kortare token avvisas vid registrering. */
export const SINCH_MIN_TOKEN_TTL_SECONDS = 60;

/**
 * En token som lever länge är en token som hinner läcka. Timmen är vald för att
 * vara kortare än en arbetsdag men lång nog att inte avbryta ett pågående pass,
 * och klienten hämtar en ny när den går ut.
 */
export const SINCH_DEFAULT_TOKEN_TTL_SECONDS = 3600;

export function sinchKeyDate(now: Date): string {
  // UTC, inte lokal tid. En svensk sommarnatt strax efter midnatt ligger
  // fortfarande på gårdagens UTC-datum, och en `kid` som inte stämmer med
  // signeringsnyckelns datum ger ett avslag som är obegripligt att felsöka.
  return [
    now.getUTCFullYear().toString().padStart(4, "0"),
    (now.getUTCMonth() + 1).toString().padStart(2, "0"),
    now.getUTCDate().toString().padStart(2, "0"),
  ].join("");
}

export function sinchSigningKey(applicationSecret: string, now: Date): Buffer {
  return createHmac("sha256", Buffer.from(applicationSecret, "base64"))
    .update(sinchKeyDate(now), "utf8")
    .digest();
}

function base64Url(value: Buffer | string): string {
  return (typeof value === "string" ? Buffer.from(value, "utf8") : value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function mintSinchRegistrationToken(input: SinchRegistrationTokenInput): {
  token: string;
  expiresAt: string;
} {
  if (!input.applicationKey.trim()) throw new Error("sinch_application_key_missing");
  if (!input.applicationSecret.trim()) throw new Error("sinch_application_secret_missing");
  if (!input.userId.trim()) throw new Error("sinch_user_id_missing");
  if (input.ttlSeconds < SINCH_MIN_TOKEN_TTL_SECONDS) {
    // Att tyst höja en för kort livslängd hade dolt ett konfigurationsfel bakom
    // en token som fungerar. Säg ifrån i stället.
    throw new Error("sinch_token_ttl_too_short");
  }

  const now = input.now ?? new Date();
  const issuedAt = Math.floor(now.getTime() / 1000);
  const expiresAt = issuedAt + input.ttlSeconds;

  const header = { alg: "HS256", kid: `hkdfv1-${sinchKeyDate(now)}` };
  const payload = {
    iss: `//rtc.sinch.com/applications/${input.applicationKey}`,
    sub: `//rtc.sinch.com/applications/${input.applicationKey}/users/${input.userId}`,
    iat: issuedAt,
    exp: expiresAt,
    nonce: input.nonce ?? randomUUID(),
  };

  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signature = createHmac("sha256", sinchSigningKey(input.applicationSecret, now))
    .update(signingInput, "utf8")
    .digest();

  return {
    token: `${signingInput}.${base64Url(signature)}`,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
  };
}
