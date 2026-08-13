import assert from "node:assert/strict";
import { buildIlikeOrFilter, sanitizeFilterTerm } from "../src/lib/postgrest-filter";
import {
  classifyWebhookTargetResponse,
  probeWebhookDeliveryTarget,
  webhookTargetProbeUrl,
} from "../src/lib/integrations/rinkel/webhook-target";

function response(status: number, location?: string) {
  return { status, headers: { get: (name: string) => (name.toLowerCase() === "location" && location ? location : null) } };
}

async function main() {
// Reserved PostgREST grammar characters must never survive into an `or=(...)` value.
for (const reserved of ["(", ")", ",", ".", ":", "*", "\\", '"', "'", "%", "_"]) {
  const sanitized = sanitizeFilterTerm(`Nordic${reserved}AB`);
  assert.ok(!sanitized.includes(reserved), `Reserved character ${reserved} survived sanitisation`);
}

// The concrete break-out attempt: closing the group and appending a foreign condition.
const injected = sanitizeFilterTerm("x),assigned_user_id.not.is.null,phone_e164.ilike.%");
assert.ok(!/[(),.%]/.test(injected), `Filter injection survived: ${injected}`);

// Ordinary Swedish company names must stay searchable and intact.
assert.equal(sanitizeFilterTerm("Åkerbergs Åkeri & Söner"), "Åkerbergs Åkeri & Söner");
assert.equal(sanitizeFilterTerm("  Nordic   Steel  "), "Nordic Steel");

// Wildcards are stripped rather than escaped, so a caller cannot widen an ilike to match all.
assert.equal(sanitizeFilterTerm("%"), "");
assert.equal(sanitizeFilterTerm("_"), "");

// Overlong terms are bounded so a caller cannot push a huge pattern into the planner.
assert.equal(sanitizeFilterTerm("a".repeat(500)).length, 120);

// A term with nothing searchable left yields no filter at all, rather than match-everything.
assert.equal(buildIlikeOrFilter(["display_name"], "%%%"), null);
assert.equal(buildIlikeOrFilter(["display_name"], "   "), null);

// The happy path builds one ilike branch per column.
assert.equal(
  buildIlikeOrFilter(["display_name", "organization_number", "phone_e164"], "Nordic"),
  "display_name.ilike.%Nordic%,organization_number.ilike.%Nordic%,phone_e164.ilike.%Nordic%",
);

// A webhook base URL that answers 200 is the only accepted delivery target.
assert.equal(webhookTargetProbeUrl("https://www.kundexa.se/"), "https://www.kundexa.se/api/health");
assert.deepEqual(classifyWebhookTargetResponse("https://www.kundexa.se", response(200)), { ok: true, status: 200 });

// The production failure mode: the apex domain 308-redirects to the www host, so
// a provider POST that does not follow redirects never reaches the route.
const redirected = classifyWebhookTargetResponse("https://kundexa.se", response(308, "https://www.kundexa.se/api/health"));
assert.equal(redirected.ok, false);
assert.equal(redirected.ok === false && redirected.code, "RINKEL_WEBHOOK_TARGET_REDIRECT");
assert.equal(redirected.ok === false && redirected.location, "https://www.kundexa.se");

// A relative Location header still resolves to the origin that would receive the POST.
const relative = classifyWebhookTargetResponse("https://kundexa.se", response(301, "/api/health"));
assert.equal(relative.ok === false && relative.location, "https://kundexa.se");

// Anything else that is not 200 is a deployment mismatch, not a healthy target.
const notDeployed = classifyWebhookTargetResponse("https://old.kundexa.se", response(404));
assert.equal(notDeployed.ok === false && notDeployed.code, "RINKEL_WEBHOOK_TARGET_UNEXPECTED_RESPONSE");

// A host that cannot be reached at all fails closed instead of registering.
const unreachable = await probeWebhookDeliveryTarget("https://missing.kundexa.se", {
  timeoutMs: 50,
  fetchImpl: (() => Promise.reject(new Error("getaddrinfo ENOTFOUND"))) as unknown as typeof fetch,
});
assert.equal(unreachable.ok === false && unreachable.code, "RINKEL_WEBHOOK_TARGET_UNREACHABLE");

// No probe result may leak the webhook secret; the probe never touches the secret path.
assert.ok(!JSON.stringify([redirected, notDeployed, unreachable]).includes("webhooks/rinkel"));

console.log("API core tests passed: PostgREST filter sanitisation, wildcard stripping, length bounds, empty-term handling and Rinkel webhook target probing.");
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
