import assert from "node:assert/strict";
import { z } from "zod";
import { buildIlikeOrFilter, sanitizeFilterTerm } from "../src/lib/postgrest-filter";
import { publicHostAlignment, resolveRinkelWebhookBaseUrl } from "../src/lib/env";
import { isoToZonedDateOnly, isoToZonedLocalDateTime, zonedLocalDateTimeToIso } from "../src/lib/domain/time";
import { acceptanceCode } from "../src/lib/crypto";

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

// A choice the user made must not have a fallback. `sendContract` used to parse
// the channel with zod's `.catch("both")`, so a missing or malformed value became
// "send by both" — a paid SMS the seller never asked for, carrying a second
// legally valid way to sign the same contract. The form always sends a value, so
// strict parsing costs nothing and guessing costs real money.
{
  const channel = z.enum(["sms", "email", "both"]);
  for (const good of ["sms", "email", "both"]) {
    assert.equal(channel.safeParse(good).success, true, `${good} must be accepted`);
  }
  for (const bad of ["", "BOTH", "epost", "sms,email", " sms"]) {
    assert.equal(channel.safeParse(bad).success, false, `"${bad}" must be refused rather than defaulted`);
  }
  // The shape that caused it, kept as the thing we must not go back to.
  assert.equal(channel.catch("both").parse("epost"), "both",
    "zod .catch turns a bad value into a silent default — this is why sendContract no longer uses it");
}
console.log("Contract channel tests passed: every valid channel is accepted, an empty or malformed one is refused instead of silently becoming \"both\".");

console.log("API core tests passed: PostgREST filter sanitisation, wildcard stripping, length bounds and empty-term handling.");
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });

// A datetime-local field is pre-filled by a page and parsed back by an action.
// They have to mean the same clock. The pages used to pre-fill from the server's
// clock — `getTimezoneOffset()` is 0 on Vercel — while every action parses with
// `zonedLocalDateTimeToIso(value, ctx.tenantTimezone)`. A field shown as 12:00
// was therefore recorded as 12:00 Stockholm for an instant that was 14:00 there,
// and the response deadline on a binding contract landed the whole UTC offset
// early.
{
  const stockholm = "Europe/Stockholm";
  // Summer: UTC+2.
  const summer = "2026-07-15T12:00:00.000Z";
  assert.equal(isoToZonedLocalDateTime(summer, stockholm), "2026-07-15T14:00");
  assert.equal(zonedLocalDateTimeToIso(isoToZonedLocalDateTime(summer, stockholm), stockholm), summer);
  // Winter: UTC+1.
  const winter = "2026-01-15T12:00:00.000Z";
  assert.equal(isoToZonedLocalDateTime(winter, stockholm), "2026-01-15T13:00");
  assert.equal(zonedLocalDateTimeToIso(isoToZonedLocalDateTime(winter, stockholm), stockholm), winter);

  // The old helper, reproduced. On a UTC server it returns the UTC wall clock,
  // which is two hours off in summer — that difference is the defect.
  const serverClock = (value: string) => {
    const date = new Date(value);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  };
  if (new Date(summer).getTimezoneOffset() === 0) {
    assert.equal(serverClock(summer), "2026-07-15T12:00");
    assert.notEqual(serverClock(summer), isoToZonedLocalDateTime(summer, stockholm));
  }

  // A date-only field is the tenant's date, not the UTC one. Half past midnight
  // in Stockholm is still the previous day in UTC; a contract start date must not
  // default to yesterday.
  assert.equal(isoToZonedDateOnly("2026-07-15T22:30:00.000Z", stockholm), "2026-07-16");
  assert.equal("2026-07-15T22:30:00.000Z".slice(0, 10), "2026-07-15");
  assert.notEqual(
    isoToZonedDateOnly("2026-07-15T22:30:00.000Z", stockholm),
    "2026-07-15T22:30:00.000Z".slice(0, 10),
  );
  // And a plain midday instant is the same date either way, so the helper is not
  // simply shifting everything forward.
  assert.equal(isoToZonedDateOnly("2026-07-15T10:00:00.000Z", stockholm), "2026-07-15");
}
console.log("Contract date fields are pre-filled in the tenant's timezone, round-trip through the action's parser unchanged, and a date-only default does not roll back a day.");

// The acceptance code is the second factor on a legally binding signature, for
// someone who has the link but not the message. The old generator upper-cased
// four base64 characters, which folds the lowercase letters onto their uppercase
// twins: 5.19 bits per character rather than 6, and 44% of the probability mass
// in the all-letter codes. At the page's 10 attempts per minute, a link live for
// its default week admitted about 100k guesses against that.
{
  const samples = Array.from({ length: 4000 }, () => acceptanceCode());
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  for (const code of samples) {
    assert.equal(code.length, 6, `Unexpected length: ${code}`);
    for (const character of code) {
      assert.ok(alphabet.includes(character), `Character outside the alphabet: ${character} in ${code}`);
    }
  }
  // Confusion is between *pairs*, so the alphabet only has to break each pair
  // rather than drop every character that has ever looked like another. I and 1
  // collide, O and 0 collide; dropping 0 and 1 settles both, which is why L and
  // the remaining letters can stay and the alphabet is a clean 32 symbols.
  for (const dropped of ["I", "O", "0", "1"]) {
    assert.ok(!samples.some((code) => code.includes(dropped)), `Ambiguous ${dropped} is reachable`);
  }
  assert.equal(alphabet.length, 32, "The alphabet is no longer a power of two, so the rejection bound needs rechecking");
  // Every symbol occurs, and no symbol dominates — the skew the old generator had
  // would show up here as letters appearing at roughly twice the rate of digits.
  const counts = new Map([...alphabet].map((character) => [character, 0]));
  for (const code of samples) for (const character of code) counts.set(character, (counts.get(character) ?? 0) + 1);
  const frequencies = [...counts.values()];
  assert.ok(Math.min(...frequencies) > 0, "Some symbol in the alphabet is unreachable");
  // 24000 draws over 32 symbols is 750 expected each; a 2x skew would break this
  // bound comfortably while ordinary sampling noise does not.
  assert.ok(Math.max(...frequencies) / Math.min(...frequencies) < 1.6,
    `Alphabet is skewed: min=${Math.min(...frequencies)} max=${Math.max(...frequencies)}`);
  // And distinct: a generator returning a constant would pass everything above.
  assert.ok(new Set(samples).size > samples.length * 0.99, "Codes repeat far more than chance allows");
}
console.log("The acceptance code is six characters drawn uniformly from a 32-symbol alphabet with no confusable characters.");
