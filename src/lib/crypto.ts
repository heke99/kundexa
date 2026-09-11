import crypto from "node:crypto";

function keyFromSecret(secret: string) {
  return crypto.createHash("sha256").update(secret).digest();
}

export function encryptJson(value: unknown, secret: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyFromSecret(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString("base64url");
}

export function decryptJson<T>(payload: string, secret: string): T {
  const buffer = Buffer.from(payload, "base64url");
  const iv = buffer.subarray(0, 12);
  const tag = buffer.subarray(12, 28);
  const ciphertext = buffer.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", keyFromSecret(secret), iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8")) as T;
}

export function sha256(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function sha256Bytes(value: Uint8Array) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

// The code is read off a phone screen and typed back, or quoted in an SMS reply,
// so the characters people confuse have to go. Confusion is between pairs: I
// with 1, O with 0. Dropping 0 and 1 breaks both pairs, which leaves L and the
// rest of the letters intact and the alphabet at a clean 32 symbols.
const ACCEPTANCE_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/**
 * The second factor on a legally binding acceptance.
 *
 * The previous code was `randomToken(4).slice(0, 4).toUpperCase()`. Four base64
 * characters are 24 uniform bits, but upper-casing folds the 26 lowercase
 * letters onto their uppercase twins, so letters end up twice as likely as
 * digits and the real strength is 5.19 bits per character — 20.75 bits, and
 * badly skewed: 44% of the probability mass sits in the 457k all-letter codes.
 *
 * The public acceptance page allows 10 attempts per minute per request, so a
 * link live for its default seven days admits ~100k guesses. Against that
 * distribution, guessing letter-first, forging a signature succeeded roughly one
 * time in ten — for someone who already had the link but not the code, which is
 * exactly who the code exists to stop.
 *
 * Six characters over a uniform 32-symbol alphabet is 30 bits with no skew:
 * about one in ten thousand over the same week. Rejection sampling keeps it
 * uniform; `% 32` on a byte would not, though with 256 being a multiple of 32 it
 * happens to here — the loop is there so the alphabet can change without
 * quietly reintroducing bias.
 */
export function acceptanceCode(length = 6) {
  const limit = 256 - (256 % ACCEPTANCE_CODE_ALPHABET.length);
  let code = "";
  while (code.length < length) {
    for (const byte of crypto.randomBytes(length * 2)) {
      if (byte >= limit) continue;
      code += ACCEPTANCE_CODE_ALPHABET[byte % ACCEPTANCE_CODE_ALPHABET.length];
      if (code.length === length) break;
    }
  }
  return code;
}
