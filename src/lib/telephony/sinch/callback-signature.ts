import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifierar att en webhook verkligen kommer från Sinch.
 *
 * Signaturen är en HMAC-SHA256 över fem rader, sammanfogade med radbryt:
 *
 *   POST
 *   Base64(MD5(body))
 *   content-type
 *   x-timestamp:<värdet>
 *   <sökvägen>
 *
 * signerad med den base64-avkodade applikationshemligheten, och skickad som
 * `Authorization: application <nyckel>:<signatur>`.
 *
 * Hämtat från developers.sinch.com/docs/voice/api-reference/authentication/
 * callback-signed-request.md 2026-09-17.
 *
 * Utan den här kontrollen kan vem som helst som känner till adressen posta en
 * `dice` och stänga ett pågående samtal, eller en `ace` och få Kundexa att tro
 * att ett samtal besvarades. Det är inte en teoretisk risk: adressen står i
 * klartext i Sinch-dashboarden och i vår egen dokumentation.
 *
 * Modulen är avsiktligt utan `server-only` — den tar hemligheten som argument,
 * läser varken miljön eller förfrågan, och är därmed testbar.
 */

export type SinchCallbackVerification =
  | { valid: true; applicationKey: string }
  | { valid: false; reason: string };

/**
 * Hur gammal en signerad förfrågan får vara.
 *
 * Signaturen i sig hindrar inte att någon spelar upp en fångad förfrågan igen.
 * Fem minuter är rymligt nog för klockglapp och omförsök, och kort nog att ett
 * avlyssnat anrop inte går att återanvända i morgon.
 */
export const SINCH_CALLBACK_MAX_AGE_SECONDS = 300;

export function sinchCallbackStringToSign(input: {
  method: string;
  body: string;
  contentType: string;
  timestamp: string;
  path: string;
}): string {
  const contentMd5 = createHash("md5").update(input.body, "utf8").digest("base64");
  return [
    input.method.toUpperCase(),
    contentMd5,
    input.contentType,
    `x-timestamp:${input.timestamp}`,
    input.path,
  ].join("\n");
}

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  // Längdskillnaden läcker redan genom, men innehållet ska inte gå att gissa
  // tecken för tecken genom att mäta svarstiden.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function verifySinchCallback(input: {
  applicationKey: string;
  applicationSecret: string;
  authorization: string | null;
  timestamp: string | null;
  contentType: string | null;
  method: string;
  path: string;
  body: string;
  now?: Date;
}): SinchCallbackVerification {
  if (!input.authorization) return { valid: false, reason: "authorization_missing" };
  if (!input.timestamp) return { valid: false, reason: "timestamp_missing" };

  const [scheme, credentials] = input.authorization.split(" ");
  if (scheme !== "application" || !credentials) return { valid: false, reason: "authorization_malformed" };

  const separator = credentials.lastIndexOf(":");
  if (separator <= 0) return { valid: false, reason: "authorization_malformed" };
  const key = credentials.slice(0, separator);
  const signature = credentials.slice(separator + 1);

  if (!equal(key, input.applicationKey)) return { valid: false, reason: "application_key_mismatch" };

  const sentAt = Date.parse(input.timestamp);
  if (Number.isNaN(sentAt)) return { valid: false, reason: "timestamp_invalid" };
  const ageSeconds = Math.abs(((input.now ?? new Date()).getTime() - sentAt) / 1000);
  if (ageSeconds > SINCH_CALLBACK_MAX_AGE_SECONDS) return { valid: false, reason: "timestamp_stale" };

  const expected = createHmac("sha256", Buffer.from(input.applicationSecret, "base64"))
    .update(
      sinchCallbackStringToSign({
        method: input.method,
        body: input.body,
        contentType: input.contentType ?? "",
        timestamp: input.timestamp,
        path: input.path,
      }),
      "utf8",
    )
    .digest("base64");

  if (!equal(signature, expected)) return { valid: false, reason: "signature_mismatch" };
  return { valid: true, applicationKey: key };
}
