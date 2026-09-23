/// <reference lib="deno.ns" />

import { createHash, createHmac } from "node:crypto";
import assert from "node:assert/strict";
import {
  sinchCallbackStringToSign,
  verifySinchCallback,
  SINCH_CALLBACK_MAX_AGE_SECONDS,
} from "../src/lib/telephony/sinch/callback-signature.ts";
import {
  mintSinchRegistrationToken,
  sinchKeyDate,
  sinchSigningKey,
  SINCH_MIN_TOKEN_TTL_SECONDS,
} from "../src/lib/telephony/sinch/registration-token.ts";
import { sinchSvamlFor } from "../src/lib/telephony/sinch/svaml.ts";

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

// Webhookens signatur. Utan den kan vem som helst som känner till adressen posta
// en `dice` och stänga ett pågående samtal, eller en `ace` och få Kundexa att
// tro att ett samtal besvarades. Adressen står i klartext i Sinch-dashboarden.
const cbSecret = Buffer.from("kundexa-callback-secret-abcdefgh").toString("base64");
const cbKey = "669E367E-6BBA-48AB-AF15-266871C28135";
const cbPath = "/api/webhooks/sinch";
const cbBody = JSON.stringify({ event: "ace", callid: "abc123", custom: "attempt-1" });
const cbAt = new Date("2026-09-17T13:40:00.000Z");
const cbStamp = cbAt.toISOString();

const sign = (body: string, timestamp: string, secret = cbSecret) =>
  createHmac("sha256", Buffer.from(secret, "base64"))
    .update(sinchCallbackStringToSign({
      method: "POST", body, contentType: "application/json", timestamp, path: cbPath,
    }), "utf8")
    .digest("base64");

const verify = (over: Record<string, unknown> = {}) => verifySinchCallback({
  applicationKey: cbKey,
  applicationSecret: cbSecret,
  authorization: `application ${cbKey}:${sign(cbBody, cbStamp)}`,
  timestamp: cbStamp,
  contentType: "application/json",
  method: "POST",
  path: cbPath,
  body: cbBody,
  now: cbAt,
  ...over,
});

Deno.test("a correctly signed callback is accepted", () => {
  const result = verify();
  assert.equal(result.valid, true, `a valid signature was rejected: ${JSON.stringify(result)}`);
});

Deno.test("the string to sign has the five documented lines in order", () => {
  const lines = sinchCallbackStringToSign({
    method: "post", body: cbBody, contentType: "application/json",
    timestamp: cbStamp, path: cbPath,
  }).split("\n");
  assert.equal(lines.length, 5);
  assert.equal(lines[0], "POST");
  assert.equal(lines[1], createHash("md5").update(cbBody, "utf8").digest("base64"));
  assert.equal(lines[2], "application/json");
  assert.equal(lines[3], `x-timestamp:${cbStamp}`);
  assert.equal(lines[4], cbPath);
});

Deno.test("a forged or replayed callback is refused", () => {
  // A body changed after signing -- the whole point of the check.
  const tampered = verify({ body: JSON.stringify({ event: "dice", callid: "abc123" }) });
  assert.equal(tampered.valid, false);
  assert.equal((tampered as { reason: string }).reason, "signature_mismatch");

  // Signed with a different secret.
  const otherSecret = Buffer.from("not-the-kundexa-callback-secret!").toString("base64");
  const wrongKey = verifySinchCallback({
    applicationKey: cbKey, applicationSecret: cbSecret,
    authorization: `application ${cbKey}:${sign(cbBody, cbStamp, otherSecret)}`,
    timestamp: cbStamp, contentType: "application/json",
    method: "POST", path: cbPath, body: cbBody, now: cbAt,
  });
  assert.equal(wrongKey.valid, false);

  // Posted to a different path with a signature made for ours.
  const wrongPath = verify({ path: "/api/webhooks/annan-leverantor" });
  assert.equal(wrongPath.valid, false);

  // Captured and replayed tomorrow. The signature is still valid; the age is not.
  const replayed = verify({ now: new Date(cbAt.getTime() + (SINCH_CALLBACK_MAX_AGE_SECONDS + 1) * 1000) });
  assert.equal(replayed.valid, false);
  assert.equal((replayed as { reason: string }).reason, "timestamp_stale");

  // And the same request just inside the window still passes, so the check above
  // is measuring staleness and not simply refusing everything.
  const fresh = verify({ now: new Date(cbAt.getTime() + (SINCH_CALLBACK_MAX_AGE_SECONDS - 1) * 1000) });
  assert.equal(fresh.valid, true);

  for (const [label, over] of [
    ["no authorization header", { authorization: null }],
    ["no timestamp header", { timestamp: null }],
    ["a bearer token instead of the application scheme", { authorization: `Bearer ${sign(cbBody, cbStamp)}` }],
    ["another application's key", { authorization: `application other-key:${sign(cbBody, cbStamp)}` }],
  ] as const) {
    assert.equal(verify(over).valid, false, `accepted a callback with ${label}`);
  }
});

console.log("Verified the Sinch registration token: UTC key date, the key derived from the base64-decoded secret and not the other way round, documented header and claims, base64url output, and no silent widening of a too-short lifetime.");

// ICE och ACE kräver SVAML med en `action`; utan den bryter Sinch samtalet.

Deno.test("ICE from the webphone to a phone number connects to that number with the client's CLI", () => {
  const svaml = sinchSvamlFor("ice", {
    event: "ice", callid: "x", originationType: "mxp", domain: "pstn", cli: "+46701234567",
    to: { type: "number", endpoint: "+46709876543" },
  });
  assert.equal(svaml?.action.name, "connectPstn");
  assert.equal(svaml?.action.cli, "+46701234567");
  // Numret utelämnas: Sinch kopplar då det nummer klienten ringde.
  assert.equal("number" in (svaml?.action ?? {}), false);
});

Deno.test("ICE for an inbound PSTN call is hung up, never looped back to the called number", () => {
  const svaml = sinchSvamlFor("ice", {
    event: "ice", originationType: "pstn", domain: "pstn", cli: "+46701234567",
    to: { type: "did", endpoint: "+46812345678" },
  });
  assert.equal(svaml?.action.name, "hangup");
});

Deno.test("ICE with an invalid CLI still connects, without overriding the caller ID", () => {
  const svaml = sinchSvamlFor("ice", {
    event: "ice", originationType: "mxp", cli: "private", to: { type: "Number", endpoint: "+46709876543" },
  });
  assert.equal(svaml?.action.name, "connectPstn");
  assert.equal("cli" in (svaml?.action ?? {}), false);
});

Deno.test("ACE continues; DiCE and notify take no SVAML", () => {
  assert.equal(sinchSvamlFor("ace", {})?.action.name, "continue");
  assert.equal(sinchSvamlFor("dice", {}), null);
  assert.equal(sinchSvamlFor("notify", {}), null);
});
