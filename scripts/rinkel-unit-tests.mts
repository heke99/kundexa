/// <reference lib="deno.ns" />

import {
  RinkelClient,
  RinkelError,
  extractRinkelRecordingId,
  mapRinkelCause,
  normalizeRinkelNumber,
  normalizeRinkelUser,
  parseRinkelWebhookPayload,
  safeRinkelError,
} from "../supabase/functions/_shared/rinkel.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message: string) {
  if (!Object.is(actual, expected)) throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
}

Deno.test("normalizes Rinkel users and numbers", () => {
  const user = normalizeRinkelUser({ id: "user-1", fullName: "Ada Lovelace", email: "ada@example.test", deviceId: "device-1" });
  equal(user.deviceId, "device-1", "device");
  const number = normalizeRinkelNumber({ id: "number-1", number: "+46812345678", label: "Sales", status: "ACTIVE", recording: { enabled: true } });
  assert(number.active && number.recordingEnabled, "number capabilities");
});

Deno.test("maps every documented callEnd cause", () => {
  equal(mapRinkelCause("ANSWERED"), "answered", "answered");
  equal(mapRinkelCause("CALLCENTER"), "answering_service", "callcenter");
  equal(mapRinkelCause("UNANSWERED"), "no_answer", "unanswered");
  equal(mapRinkelCause("BLACKLISTED"), "blocked", "blacklisted");
  equal(mapRinkelCause("VOICEMAIL"), "voicemail", "voicemail");
  equal(mapRinkelCause("OUTSIDE_OPERATION_TIMES"), "outside_business_hours", "outside hours");
  equal(mapRinkelCause("NEW_PROVIDER_CAUSE"), "unknown", "unknown cause");
});

Deno.test("validates all webhook event payloads", () => {
  equal(parseRinkelWebhookPayload("incomingCall", { id: "c1", datetime: "2026-07-30T10:00:00Z", from: "+46701111111", to: "+46812345678" }).event, "incomingCall", "incoming");
  equal(parseRinkelWebhookPayload("outgoingCall", { id: "c2", datetime: "2026-07-30T10:00:00Z", from: "+46812345678", to: "+46701111111", userId: "u1" }).event, "outgoingCall", "outgoing");
  equal(parseRinkelWebhookPayload("callStart", { id: "c2", datetime: "2026-07-30T10:00:01Z", answeredBy: "person", choice: null, userId: "u1" }).event, "callStart", "start");
  equal(parseRinkelWebhookPayload("callEnd", { id: "c2", datetime: "2026-07-30T10:01:00Z", cause: "ANSWERED", callRecordingUrl: "https://api.rinkel.com/v1/call-recordings/rec_1/stream", voicemailUrl: null }).event, "callEnd", "end");
  const unknownEnd = parseRinkelWebhookPayload("callEnd", { id: "c3", datetime: "2026-07-30T10:02:00Z", cause: "PROVIDER_ADDED_CAUSE", callRecordingUrl: null, voicemailUrl: null });
  assert(unknownEnd.event === "callEnd" && !unknownEnd.knownCause, "unknown end cause must remain ingestible");
  equal(parseRinkelWebhookPayload("callInsights", { id: "c2", sentiment: "POSITIVE", topics: ["sales"], summary: "Good call" }).event, "callInsights", "insights");
});

Deno.test("rejects untrusted recording references", () => {
  equal(extractRinkelRecordingId("https://api.rinkel.com/v1/call-recordings/rec_1/stream"), "rec_1", "versioned recording id");
  equal(extractRinkelRecordingId("https://api.rinkel.com/call-recordings/rec_2/stream"), "rec_2", "webhook recording id");
  let rejected = false;
  try {
    extractRinkelRecordingId("https://evil.example/v1/call-recordings/rec_1/stream");
  } catch {
    rejected = true;
  }
  assert(rejected, "foreign host must be rejected");
});

Deno.test("does not retry POST dial after a network failure", async () => {
  let calls = 0;
  const client = new RinkelClient({
    apiKey: "test-key",
    timeoutMs: 1000,
    fetchImpl: (() => {
      calls += 1;
      throw new TypeError("network");
    }) as typeof fetch,
  });
  let caught: unknown;
  try {
    await client.dial({ deviceId: "device-1", numberId: "number-1", to: "+46701111111" });
  } catch (error) {
    caught = error;
  }
  equal(calls, 1, "dial requests");
  assert(caught instanceof RinkelError && caught.outcomeUnknown, "dial failure outcome must be unknown");
});

Deno.test("retries safe GET requests", async () => {
  let calls = 0;
  const client = new RinkelClient({
    apiKey: "test-key",
    fetchImpl: (() => {
      calls += 1;
      if (calls < 3) return Promise.resolve(new Response("temporary", { status: 503 }));
      return Promise.resolve(Response.json({ data: [{ id: "u1", fullName: "Ada", deviceId: "d1", email: null }] }));
    }) as typeof fetch,
  });
  const users = await client.listUsers();
  equal(calls, 3, "GET attempts");
  equal(users[0].id, "u1", "user id");
});

Deno.test("classifies authentication errors without leaking provider text", async () => {
  const client = new RinkelClient({
    apiKey: "test-key",
    fetchImpl: (() => Promise.resolve(new Response("secret-token-value-should-not-pass", { status: 401 }))) as typeof fetch,
  });
  let caught: unknown;
  try {
    await client.listUsers();
  } catch (error) {
    caught = error;
  }
  const safe = safeRinkelError(caught);
  equal(safe.code, "RINKEL_AUTHENTICATION_ERROR", "error code");
  assert(!safe.message.includes("secret-token"), "provider secret leaked");
});

Deno.test("treats transcription 204 as pending", async () => {
  const client = new RinkelClient({
    apiKey: "test-key",
    fetchImpl: (() => Promise.resolve(new Response(null, { status: 204 }))) as typeof fetch,
  });
  const result = await client.getTranscription("call-1");
  assert(!result.available && result.value === null, "204 must remain pending");
});

Deno.test("accepts direct directory payloads and normalizes active number variants", async () => {
  let call = 0;
  const client = new RinkelClient({
    apiKey: "test-key",
    fetchImpl: (() => {
      call += 1;
      if (call === 1) {
        return Promise.resolve(Response.json([
          { id: "u-direct", name: "Direct User", deviceId: "device-direct", active: true },
        ]));
      }
      return Promise.resolve(Response.json([
        { numberId: "n-direct", phoneNumber: "+46812345678", displayName: "Sales", status: "active" },
      ]));
    }) as typeof fetch,
  });
  const users = await client.listUsers();
  const numbers = await client.listNumbers();
  equal(users[0].id, "u-direct", "direct user payload");
  equal(numbers[0].id, "n-direct", "direct number payload");
  assert(numbers[0].active, "lowercase active status must be active");
});

Deno.test("sends the documented dial request once and accepts 204", async () => {
  let capturedUrl = "";
  let capturedMethod = "";
  let capturedHeader = "";
  let capturedBodyJson = "{}";
  let calls = 0;
  const client = new RinkelClient({
    apiKey: "test-key",
    fetchImpl: ((input, init) => {
      calls += 1;
      capturedUrl = String(input);
      capturedMethod = String(init?.method ?? "GET");
      capturedHeader = new Headers(init?.headers).get("x-rinkel-api-key") ?? "";
      capturedBodyJson = String(init?.body ?? "{}");
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as typeof fetch,
  });
  await client.dial({ deviceId: "device-1", numberId: "number-1", to: "+46701111111" });
  equal(calls, 1, "dial request count");
  assert(capturedUrl.endsWith("/v1/dial"), "dial endpoint");
  equal(capturedMethod, "POST", "dial method");
  equal(capturedHeader, "test-key", "dial auth header");
  const capturedBody = JSON.parse(capturedBodyJson) as {
    deviceId?: unknown;
    numberId?: unknown;
    to?: unknown;
    anonymous?: unknown;
  };
  equal(capturedBody.deviceId, "device-1", "dial deviceId");
  equal(capturedBody.numberId, "number-1", "dial numberId");
  equal(capturedBody.to, "+46701111111", "dial destination");
  equal(capturedBody.anonymous, false, "dial anonymous flag");
});

Deno.test("registers a Rinkel webhook with the documented provider contract", async () => {
  let capturedUrl = "";
  let capturedMethod = "";
  let capturedHeader = "";
  let capturedBodyJson = "{}";
  const client = new RinkelClient({
    apiKey: "test-key",
    fetchImpl: ((input, init) => {
      capturedUrl = String(input);
      capturedMethod = String(init?.method ?? "GET");
      capturedHeader = new Headers(init?.headers).get("x-rinkel-api-key") ?? "";
      capturedBodyJson = String(init?.body ?? "{}");
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as typeof fetch,
  });
  await client.subscribeWebhook("outgoingCall", {
    url: "https://app.example.test/api/webhooks/rinkel/redacted/outgoingCall",
    contentType: "application/json",
    active: true,
    description: "Kundexa central Rinkel webhook",
  });
  assert(capturedUrl.endsWith("/v1/webhooks/outgoingCall"), "webhook endpoint");
  equal(capturedMethod, "POST", "webhook method");
  equal(capturedHeader, "test-key", "webhook auth header");
  const body = JSON.parse(capturedBodyJson) as Record<string, unknown>;
  equal(body.url, "https://app.example.test/api/webhooks/rinkel/redacted/outgoingCall", "webhook URL");
  equal(body.contentType, "application/json", "webhook content type");
  equal(body.active, true, "webhook active");
  equal(body.description, "Kundexa central Rinkel webhook", "webhook description");
});

