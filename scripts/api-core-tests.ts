import assert from "node:assert/strict";
import { z } from "zod";
import { buildIlikeOrFilter, sanitizeFilterTerm } from "../src/lib/postgrest-filter";
import { expectedWebhookUrl } from "../src/lib/env";
import { isoToZonedDateOnly, isoToZonedLocalDateTime, zonedLocalDateTimeToIso } from "../src/lib/domain/time";
import { acceptanceCode } from "../src/lib/crypto";
import { ok, SupabaseReadError } from "../src/lib/supabase/read";
import { callbackPresets, groupOutcomes, manualOutcomeOptions, toLocalDateTimeInput } from "../src/lib/dialer/outcomes";

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
// Callback-URL:en härleds ur app-URL:en och ingenting annat. Att räkna fram de
// två oberoende av varandra var det som lät produktionen servera länkar för
// www.kundexa.se medan varje webhook-prenumeration pekade på den omdirigerande
// apexdomänen -- och händelserna föll bort utan att någon sa till.
withEnv({ NEXT_PUBLIC_APP_URL: "https://kundexa.se" }, () => {
  assert.equal(expectedWebhookUrl(), "https://kundexa.se/api/webhooks/sinch");
});

// Ett avslutande snedstreck i app-URL:en får inte bli ett dubbelt i sökvägen.
withEnv({ NEXT_PUBLIC_APP_URL: "https://kundexa.se/" }, () => {
  assert.equal(expectedWebhookUrl(), "https://kundexa.se/api/webhooks/sinch");
});

// Värdnamnet bärs med. En prenumeration mot fel värd tas emot av ingen.
withEnv({ NEXT_PUBLIC_APP_URL: "https://www.kundexa.se" }, () => {
  assert.equal(expectedWebhookUrl(), "https://www.kundexa.se/api/webhooks/sinch");
});

// I produktion får en app-URL som inte går att nå utifrån inte tyst bli
// webhookmål. Att registrera localhost hos leverantören ger en prenumeration som
// aldrig levererar -- och inget samtal får någonsin sitt utfall.
for (const unusable of ["http://localhost:3000", "http://127.0.0.1:3000", "https://kundexa.local"]) {
  withEnv({ NEXT_PUBLIC_APP_URL: unusable, VERCEL_ENV: "production" }, () => {
    assert.equal(expectedWebhookUrl(), "https://kundexa.se/api/webhooks/sinch");
  });
}

// En trasig URL faller tillbaka oavsett körmiljö: den går inte att tolka alls.
withEnv({ NEXT_PUBLIC_APP_URL: "inte-en-url" }, () => {
  assert.equal(expectedWebhookUrl(), "https://kundexa.se/api/webhooks/sinch");
});

// Lokalt är localhost rätt svar. En utvecklingsmiljö som pekar på produktionen
// hade skickat testsamtalens händelser till riktiga kunder.
withEnv({ NEXT_PUBLIC_APP_URL: "http://localhost:3000", VERCEL_ENV: undefined }, () => {
  assert.equal(expectedWebhookUrl(), "http://localhost:3000/api/webhooks/sinch");
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

// `ok()` is what stops a failed read from rendering as an empty table. Its two
// halves both matter: it has to raise a genuine failure, and it has to stay out
// of the way of `.single()` reporting "no row", which pages answer with
// notFound(). Getting the second half wrong would turn "kunden finns inte" into
// "något gick fel" — a behaviour change dressed up as a fix.
async function testOk() {
  const failure = { data: null, error: { message: "relation does not exist", code: "42P01", details: "", hint: "", name: "PostgrestError" } };
  await assert.rejects(() => ok(Promise.resolve(failure) as never), (thrown: unknown) => {
    assert.ok(thrown instanceof SupabaseReadError, "a failed read raises SupabaseReadError");
    assert.equal((thrown as SupabaseReadError).code, "42P01");
    assert.ok(!(thrown as Error).message.includes("undefined"));
    return true;
  }, "a genuine read failure must not be rendered as emptiness");

  const noRows = { data: null, error: { message: "no rows", code: "PGRST116", details: "", hint: "", name: "PostgrestError" } };
  const passedThrough = await ok(Promise.resolve(noRows) as never) as unknown as typeof noRows;
  assert.equal(passedThrough.data, null, "`.single()` finding no row stays a null row, not a crash");

  // `count` is why ok() returns the whole result rather than just `{ data }`:
  // the paginated customer list reads it.
  const counted = await ok(Promise.resolve({ data: [1, 2], count: 97, error: null }) as never) as unknown as { data: number[]; count: number };
  assert.equal(counted.count, 97, "ok() must not strip fields the page reads");
  assert.deepEqual(counted.data, [1, 2]);

  const clean = await ok(Promise.resolve({ data: { id: "x" }, error: null }) as never) as unknown as { data: { id: string } };
  assert.deepEqual(clean.data, { id: "x" });
}

void testOk().then(() => console.log("ok() raises real read failures and passes a missing row through."));

// Efterarbetet som knappar: fast gruppordning, siffertangent 1–9 i visningsordning,
// okända grupper hamnar sist i stället för att försvinna.
{
  const groups = groupOutcomes([
    ...manualOutcomeOptions,
    { key: "custom_outcome", label: "Eget utfall", outcomeGroup: "something_new" },
  ]);
  assert.deepEqual(groups.map((group) => group.key), ["positive", "neutral", "negative", "unreachable", "blocked", "other"]);
  const flat = groups.flatMap((group) => group.options);
  assert.equal(flat.length, manualOutcomeOptions.length + 1, "inget utfall får tappas");
  assert.deepEqual(flat.slice(0, 9).map((option) => option.shortcut), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(flat[9].shortcut, null, "tangent finns bara för de nio första");
  assert.equal(groupOutcomes([{ key: "a", label: "A", outcomeGroup: "negative" }]).length, 1, "tomma grupper visas inte");

  // Onsdag 2026-09-23 10:07 lokal tid.
  const wednesday = new Date(2026, 8, 23, 10, 7);
  const presets = callbackPresets(wednesday);
  assert.deepEqual(presets.map((preset) => preset.value), ["2026-09-23T11:15", "2026-09-23T15:00", "2026-09-24T09:00", "2026-09-30T09:00"]);
  // Fredag kväll: ingen eftermiddag kvar, nästa vardag är måndag.
  const fridayEvening = new Date(2026, 8, 25, 18, 50);
  const friday = callbackPresets(fridayEvening).map((preset) => preset.value);
  assert.deepEqual(friday, ["2026-09-25T20:00", "2026-09-28T09:00", "2026-10-02T09:00"]);
  assert.equal(toLocalDateTimeInput(new Date(2026, 0, 5, 7, 3)), "2026-01-05T07:03");
  console.log("Utfallsgrupper och återkomstsnabbval stämmer.");
}
