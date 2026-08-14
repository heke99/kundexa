import assert from "node:assert/strict";
import { buildIlikeOrFilter, sanitizeFilterTerm } from "../src/lib/postgrest-filter";
import { publicHostAlignment, resolveRinkelWebhookBaseUrl } from "../src/lib/env";

function withEnv(values: Record<string, string | undefined>, run: () => void) {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function main() {
// The webhook target inherits the app host when it is not set explicitly. Deriving
// the two independently is what let production serve links for www.kundexa.se while
// all five Rinkel subscriptions pointed at the redirecting apex.
withEnv({ RINKEL_WEBHOOK_PUBLIC_BASE_URL: undefined, NEXT_PUBLIC_APP_URL: "https://kundexa.se" }, () => {
  assert.equal(resolveRinkelWebhookBaseUrl(), "https://kundexa.se");
  assert.equal(publicHostAlignment().aligned, true);
});

// A trailing slash on the app URL must not produce a double slash in webhook paths.
withEnv({ RINKEL_WEBHOOK_PUBLIC_BASE_URL: undefined, NEXT_PUBLIC_APP_URL: "https://kundexa.se/" }, () => {
  assert.equal(resolveRinkelWebhookBaseUrl(), "https://kundexa.se");
});

// An explicit override still wins, because the webhook host may legitimately differ.
withEnv({ RINKEL_WEBHOOK_PUBLIC_BASE_URL: "https://hooks.kundexa.se", NEXT_PUBLIC_APP_URL: "https://kundexa.se" }, () => {
  assert.equal(resolveRinkelWebhookBaseUrl(), "https://hooks.kundexa.se");
  assert.equal(publicHostAlignment().aligned, false);
});

// The live production mismatch is reported rather than silently accepted.
withEnv({ RINKEL_WEBHOOK_PUBLIC_BASE_URL: "https://kundexa.se", NEXT_PUBLIC_APP_URL: "https://www.kundexa.se" }, () => {
  const alignment = publicHostAlignment();
  assert.equal(alignment.appHost, "www.kundexa.se");
  assert.equal(alignment.webhookHost, "kundexa.se");
  assert.equal(alignment.aligned, false);
});

// An unusable app URL must not silently become the webhook target.
withEnv({ RINKEL_WEBHOOK_PUBLIC_BASE_URL: undefined, NEXT_PUBLIC_APP_URL: "http://localhost:3000", VERCEL_ENV: "production" }, () => {
  assert.equal(resolveRinkelWebhookBaseUrl(), "https://kundexa.se");
});

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

console.log("API core tests passed: PostgREST filter sanitisation, wildcard stripping, length bounds and empty-term handling.");
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
