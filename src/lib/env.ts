import { z } from "zod";
function isValidIpAddress(value: string) {
  const parts = value.split(".");
  if (parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return true;
  return /^[0-9a-f:]+$/i.test(value) && value.includes(":") && value.length <= 45;
}


function isUnsafePublicHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/%[0-9a-z_.-]+$/i, "");
  if (["localhost", "0.0.0.0", "::", "::1"].includes(normalized)) return true;
  if (normalized.endsWith(".local") || normalized.endsWith(".internal") || normalized.endsWith(".localhost")) return true;
  if (/^(0|10|127)\./.test(normalized) || /^192\.168\./.test(normalized) || /^169\.254\./.test(normalized)) return true;
  const private172 = /^172\.(\d{1,3})\./.exec(normalized);
  if (private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31) return true;
  const sharedCarrier = /^100\.(\d{1,3})\./.exec(normalized);
  if (sharedCarrier && Number(sharedCarrier[1]) >= 64 && Number(sharedCarrier[1]) <= 127) return true;
  if (/^(fc|fd)[0-9a-f]{2}:/i.test(normalized) || /^fe[89ab][0-9a-f]:/i.test(normalized)) return true;
  if (/^::ffff:(127\.|10\.|192\.168\.|169\.254\.)/i.test(normalized)) return true;
  return false;
}

// stun:/turns:-adresser, kommaseparerade. Tom lista är giltigt: den betyder att
// webbtelefonen inte är uppsatt än, och det ska sägas som ett nej i gränssnittet
// och inte som ett startfel i hela appen.
const urlListSchema = z.string().default("").transform((value, context) => {
  const urls = [...new Set(value.split(",").map((entry) => entry.trim()).filter(Boolean))];
  const invalid = urls.find((entry) => !/^(stun|stuns|turn|turns):/i.test(entry));
  if (invalid) {
    context.addIssue({ code: "custom", message: `Ogiltig STUN/TURN-adress: ${invalid}` });
    return z.NEVER;
  }
  return urls;
});

function isDeployedRuntime() {
  // VERCEL_ENV/NODE_ENV are server-only, so this is false in the browser and the
  // deployment guards below apply exactly where the value is actually used to
  // build outbound links.
  const deployment = process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development";
  return ["production", "preview", "staging"].includes(deployment);
}

const publicObject = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
});

const publicSchema = publicObject;

/**
 * True when NEXT_PUBLIC_APP_URL is usable as the public base for links that leave
 * the system. In a deployed runtime that means a public HTTPS host; locally any
 * parseable URL is fine.
 */
export function isUsablePublicAppUrl(value: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (!isDeployedRuntime()) return true;
  return parsed.protocol === "https:" && !isUnsafePublicHostname(parsed.hostname);
}

/**
 * The base URL customers actually receive: acceptance/signing links, the Resend
 * webhook address and provider callbacks. An unset NEXT_PUBLIC_APP_URL falls back
 * to http://localhost:3000, so in a deployed runtime a misconfiguration would
 * otherwise produce links that silently go nowhere.
 *
 * This throws rather than returning a broken base, but only on the paths that
 * build an outbound artefact -- reading it must never take down request handling
 * that has nothing to do with links.
 */
export function canonicalAppBaseUrl() {
  const value = publicEnv().NEXT_PUBLIC_APP_URL;
  if (!isUsablePublicAppUrl(value)) {
    throw new Error(
      "NEXT_PUBLIC_APP_URL måste vara en publik HTTPS-adress i staging/production (t.ex. https://kundexa.se).",
    );
  }
  return value.replace(/\/$/, "");
}

/**
 * The URL the telephony provider is expected to POST call events to.
 *
 * It is not derived from anything the provider tells us -- the callback address
 * is typed into the Sinch dashboard by a human, and nothing here can read it
 * back. What this gives is the address it ought to be, so the two can be
 * compared by someone looking at both.
 *
 * That comparison is the whole point. The previous provider had five
 * subscriptions pointing at a host the application did not serve, and nothing in
 * the system noticed until the events had been missing for weeks.
 */
export function expectedWebhookUrl() {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  const base = appUrl && isUsablePublicAppUrl(appUrl) ? appUrl.replace(/\/$/, "") : "https://kundexa.se";
  return `${base}/api/webhooks/sinch`;
}

export function publicEnv() {
  return publicSchema.parse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
  });
}

const serverSchema = publicObject.extend({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  KUNDEXA_ENCRYPTION_KEY: z.string().min(20),
  KUNDEXA_WEBHOOK_PEPPER: z.string().min(20),
  ENFORCE_SMS_IP_ALLOWLIST: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  CRON_SECRET: z.string().min(20).optional(),
  RESEND_API_KEY: z.string().min(1).optional(),
  DEFAULT_EMAIL_FROM_NAME: z.string().trim().min(1).max(100).optional(),
  DEFAULT_EMAIL_FROM_ADDRESS: z.string().email().optional(),
  RESEND_WEBHOOK_SECRET: z.string().min(1).optional(),
  SINCH_APPLICATION_KEY: z.string().min(1).optional(),
  SINCH_APPLICATION_SECRET: z.string().min(1).optional(),
  SINCH_RTC_ENVIRONMENT_HOST: z.string().min(1).default("ocra.api.sinch.com"),
  // Webbtelefonen. STUN räcker för att hitta sin egen adress; TURN är det som
  // faktiskt bär ljudet igenom en företagsbrandvägg, och utan relä blir felet
  // "kunden hör mig inte" i stället för ett ärligt fel vid uppkoppling.
  WEBPHONE_STUN_URLS: urlListSchema,
  WEBPHONE_TURN_URLS: urlListSchema,
  // Den delade TURN-hemligheten lämnar aldrig servern; webbläsaren får bara en
  // tidsstämplad signatur räknad ur den.
  WEBPHONE_TURN_SECRET: z.string().min(20).optional(),
  WEBPHONE_CREDENTIAL_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(600),
}).superRefine((env, context) => {
  if (env.RESEND_API_KEY && !env.DEFAULT_EMAIL_FROM_ADDRESS) {
    context.addIssue({ code: "custom", path: ["DEFAULT_EMAIL_FROM_ADDRESS"], message: "Plattformshanterad Resend kräver en verifierad avsändaradress." });
  }
  if (env.RESEND_API_KEY && !env.DEFAULT_EMAIL_FROM_NAME) {
    context.addIssue({ code: "custom", path: ["DEFAULT_EMAIL_FROM_NAME"], message: "Plattformshanterad Resend kräver ett avsändarnamn." });
  }
});

export function serverEnv() {
  return serverSchema.parse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    KUNDEXA_ENCRYPTION_KEY: process.env.KUNDEXA_ENCRYPTION_KEY,
    KUNDEXA_WEBHOOK_PEPPER: process.env.KUNDEXA_WEBHOOK_PEPPER,
    ENFORCE_SMS_IP_ALLOWLIST: process.env.ENFORCE_SMS_IP_ALLOWLIST ?? "false",
    CRON_SECRET: process.env.CRON_SECRET,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    DEFAULT_EMAIL_FROM_NAME: process.env.DEFAULT_EMAIL_FROM_NAME,
    DEFAULT_EMAIL_FROM_ADDRESS: process.env.DEFAULT_EMAIL_FROM_ADDRESS,
    RESEND_WEBHOOK_SECRET: process.env.RESEND_WEBHOOK_SECRET,
    SINCH_APPLICATION_KEY: process.env.SINCH_APPLICATION_KEY,
    SINCH_APPLICATION_SECRET: process.env.SINCH_APPLICATION_SECRET,
    SINCH_RTC_ENVIRONMENT_HOST: process.env.SINCH_RTC_ENVIRONMENT_HOST ?? "ocra.api.sinch.com",
    WEBPHONE_STUN_URLS: process.env.WEBPHONE_STUN_URLS ?? "",
    WEBPHONE_TURN_URLS: process.env.WEBPHONE_TURN_URLS ?? "",
    WEBPHONE_TURN_SECRET: process.env.WEBPHONE_TURN_SECRET,
    WEBPHONE_CREDENTIAL_TTL_SECONDS: process.env.WEBPHONE_CREDENTIAL_TTL_SECONDS ?? "600",
  });
}
