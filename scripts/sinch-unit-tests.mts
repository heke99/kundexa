/// <reference lib="deno.ns" />

import { createHmac } from "node:crypto";
import assert from "node:assert/strict";
import {
  mintSinchRegistrationToken,
  sinchKeyDate,
  sinchSigningKey,
  SINCH_MIN_TOKEN_TTL_SECONDS,
} from "../src/lib/telephony/sinch/registration-token.ts";

// Sinch signerar inte registreringstoken med applikationshemligheten direkt,
// utan med en nyckel som härleds ur den en gång per dygn. Två fel är lätta att
// göra och båda ger en token som ser giltig ut men avvisas vid registrering:
// att använda hemligheten oavkodad, och att byta plats på nyckel och meddelande
// i HMAC:en. Ingetdera går att felsöka från ett avslag, så de testas här.

const secret = Buffer.from("kundexa-verify-secret-0123456789").toString("base64");
const applicationKey = "app-key-abc";
const userId = "0f3d7a5e-1111-4222-8333-444455556666";
const at = new Date("2026-09-17T09:30:00.000Z");

const decode = (part: string) =>
  JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));

// Datumet är UTC. En svensk sommarnatt strax efter midnatt ligger fortfarande på
// gårdagens UTC-datum, och en kid som inte matchar signeringsnyckelns datum ger
// ett avslag utan ledtråd.
//
// Testet måste köras utanför UTC för att kunna se skillnaden. På en UTC-maskin
// ger lokal tid och UTC samma svar, så påståendena nedan passerar även om koden
// använder fel -- vilket de gjorde när de skrevs, och bara upptäcktes för att
// buggen återställdes. Körs de i UTC mäter de ingenting, så då ska de säga det
// i stället för att låtsas.
Deno.test("the key date is UTC, not the machine's local day", () => {
assert.notEqual(
  Intl.DateTimeFormat().resolvedOptions().timeZone,
  "UTC",
  "these tests must run outside UTC or the local-time bug they exist to catch is invisible; run with TZ=Europe/Stockholm",
);
assert.equal(sinchKeyDate(new Date("2026-07-01T23:30:00.000Z")), "20260701");
assert.equal(sinchKeyDate(new Date("2026-07-01T00:30:00.000Z")), "20260701");
});

// Nyckeln är HMAC(base64-avkodad hemlighet, datumsträng) -- inte tvärtom, och
// inte med hemligheten som den står.
const expectedKey = createHmac("sha256", Buffer.from(secret, "base64")).update("20260917", "utf8").digest();

Deno.test("the signing key is derived from the base64-decoded secret, keyed on the secret", () => {
assert.deepEqual(sinchSigningKey(secret, at), expectedKey);

const wrongWayRound = createHmac("sha256", "20260917").update(Buffer.from(secret, "base64")).digest();
assert.notDeepEqual(sinchSigningKey(secret, at), wrongWayRound, "key and message are swapped");

const rawSecretKey = createHmac("sha256", secret).update("20260917", "utf8").digest();
assert.notDeepEqual(sinchSigningKey(secret, at), rawSecretKey, "the secret was not base64-decoded");
});

const minted = mintSinchRegistrationToken({
  applicationKey,
  applicationSecret: secret,
  userId,
  ttlSeconds: 3600,
  now: at,
  nonce: "fixed-nonce",
});

const [rawHeader, rawPayload, rawSignature] = minted.token.split(".");

Deno.test("the token carries the documented header, claims and signature", () => {
assert.equal(minted.token.split(".").length, 3);

const header = decode(rawHeader);
assert.equal(header.alg, "HS256");
assert.equal(header.kid, "hkdfv1-20260917");

const payload = decode(rawPayload);
assert.equal(payload.iss, `//rtc.sinch.com/applications/${applicationKey}`);
assert.equal(payload.sub, `//rtc.sinch.com/applications/${applicationKey}/users/${userId}`);
assert.equal(payload.iat, Math.floor(at.getTime() / 1000));
assert.equal(payload.exp, Math.floor(at.getTime() / 1000) + 3600);
assert.equal(payload.nonce, "fixed-nonce");
assert.equal(minted.expiresAt, new Date((Math.floor(at.getTime() / 1000) + 3600) * 1000).toISOString());

// Signaturen är över header och payload med den härledda nyckeln, och den är
// base64url utan utfyllnad. En signatur med '+' eller '=' i sig avvisas av
// mottagaren utan att någonting i övrigt ser fel ut.
const expectedSignature = createHmac("sha256", expectedKey)
  .update(`${rawHeader}.${rawPayload}`, "utf8")
  .digest()
  .toString("base64")
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/, "");
assert.equal(rawSignature, expectedSignature);
assert.ok(!/[+/=]/.test(minted.token), "the token is not base64url");

// Hemligheten får inte finnas i det som lämnar servern.
assert.ok(!minted.token.includes(secret));
});

// En för kort livslängd höjs inte tyst. Att göra det hade dolt ett
// konfigurationsfel bakom en token som fungerar.
Deno.test("a too-short lifetime and a blank credential are refused, not widened", () => {
assert.throws(
  () => mintSinchRegistrationToken({
    applicationKey, applicationSecret: secret, userId,
    ttlSeconds: SINCH_MIN_TOKEN_TTL_SECONDS - 1, now: at,
  }),
  /sinch_token_ttl_too_short/,
);

for (const [field, input] of [
  ["applicationKey", { applicationKey: "  ", applicationSecret: secret, userId }],
  ["applicationSecret", { applicationKey, applicationSecret: "  ", userId }],
  ["userId", { applicationKey, applicationSecret: secret, userId: "  " }],
] as const) {
  assert.throws(
    () => mintSinchRegistrationToken({ ...input, ttlSeconds: 3600, now: at }),
    /missing/,
    `a blank ${field} was accepted`,
  );
}
});

Deno.test("two tokens minted in the same second differ", () => {
// Två token i följd delar inte nonce, annars vore de utbytbara.
const a = mintSinchRegistrationToken({ applicationKey, applicationSecret: secret, userId, ttlSeconds: 3600, now: at });
const b = mintSinchRegistrationToken({ applicationKey, applicationSecret: secret, userId, ttlSeconds: 3600, now: at });
assert.notEqual(a.token, b.token, "two tokens minted in the same second are identical");
});

console.log("Verified the Sinch registration token: UTC key date, the key derived from the base64-decoded secret and not the other way round, documented header and claims, base64url output, and no silent widening of a too-short lifetime.");
