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

const ipAllowlistSchema = z.string().default("82.199.77.220,188.122.73.177").transform((value, context) => {
  const addresses = [...new Set(value.split(",").map((entry) => entry.trim()).filter(Boolean))];
  const invalid = addresses.find((entry) => !isValidIpAddress(entry));
  if (invalid) {
    context.addIssue({ code: "custom", message: `Ogiltig IP-adress i RINKEL_WEBHOOK_ALLOWED_IPS: ${invalid}` });
    return z.NEVER;
  }
  return addresses;
});

const publicSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
});

export function publicEnv() {
  return publicSchema.parse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
  });
}

const serverSchema = publicSchema.extend({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  KUNDEXA_ENCRYPTION_KEY: z.string().min(20),
  KUNDEXA_WEBHOOK_PEPPER: z.string().min(20),
  ENFORCE_46ELKS_IP_ALLOWLIST: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  CRON_SECRET: z.string().min(20).optional(),
  RESEND_API_KEY: z.string().min(1).optional(),
  DEFAULT_EMAIL_FROM_NAME: z.string().trim().min(1).max(100).optional(),
  DEFAULT_EMAIL_FROM_ADDRESS: z.string().email().optional(),
  RESEND_WEBHOOK_SECRET: z.string().min(1).optional(),
  RINKEL_API_KEY: z.string().min(1).optional(),
  RINKEL_API_BASE_URL: z.string().url().default("https://api.rinkel.com/v1"),
  RINKEL_WEBHOOK_PUBLIC_BASE_URL: z.string().url().default("https://app.kundexa.se"),
  RINKEL_WEBHOOK_SECRET: z.string().min(40).max(128).optional(),
  RINKEL_WEBHOOK_ALLOWED_IPS: ipAllowlistSchema,
  RINKEL_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(15000),
  RINKEL_ENFORCE_WEBHOOK_IP_ALLOWLIST: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
  RINKEL_TRUST_X_REAL_IP: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  RINKEL_RECONCILIATION_ENABLED: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
}).superRefine((env, context) => {
  if (env.RESEND_API_KEY && !env.DEFAULT_EMAIL_FROM_ADDRESS) {
    context.addIssue({ code: "custom", path: ["DEFAULT_EMAIL_FROM_ADDRESS"], message: "Plattformshanterad Resend kräver en verifierad avsändaradress." });
  }
  if (env.RESEND_API_KEY && !env.DEFAULT_EMAIL_FROM_NAME) {
    context.addIssue({ code: "custom", path: ["DEFAULT_EMAIL_FROM_NAME"], message: "Plattformshanterad Resend kräver ett avsändarnamn." });
  }
  const deployment = process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development";
  if (["production", "preview", "staging"].includes(deployment)) {
    const webhookUrl = new URL(env.RINKEL_WEBHOOK_PUBLIC_BASE_URL);
    if (webhookUrl.protocol !== "https:" || isUnsafePublicHostname(webhookUrl.hostname)) {
      context.addIssue({
        code: "custom",
        path: ["RINKEL_WEBHOOK_PUBLIC_BASE_URL"],
        message: "RINKEL_WEBHOOK_PUBLIC_BASE_URL måste vara en publik HTTPS-adress i staging/production.",
      });
    }
    const apiUrl = new URL(env.RINKEL_API_BASE_URL);
    if (apiUrl.protocol !== "https:" || isUnsafePublicHostname(apiUrl.hostname)) {
      context.addIssue({
        code: "custom",
        path: ["RINKEL_API_BASE_URL"],
        message: "RINKEL_API_BASE_URL måste vara en publik HTTPS-adress i staging/production.",
      });
    }
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
    ENFORCE_46ELKS_IP_ALLOWLIST: process.env.ENFORCE_46ELKS_IP_ALLOWLIST ?? "false",
    CRON_SECRET: process.env.CRON_SECRET,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    DEFAULT_EMAIL_FROM_NAME: process.env.DEFAULT_EMAIL_FROM_NAME,
    DEFAULT_EMAIL_FROM_ADDRESS: process.env.DEFAULT_EMAIL_FROM_ADDRESS,
    RESEND_WEBHOOK_SECRET: process.env.RESEND_WEBHOOK_SECRET,
    RINKEL_API_KEY: process.env.RINKEL_API_KEY,
    RINKEL_API_BASE_URL: process.env.RINKEL_API_BASE_URL ?? "https://api.rinkel.com/v1",
    RINKEL_WEBHOOK_PUBLIC_BASE_URL: process.env.RINKEL_WEBHOOK_PUBLIC_BASE_URL ?? "https://app.kundexa.se",
    RINKEL_WEBHOOK_SECRET: process.env.RINKEL_WEBHOOK_SECRET,
    RINKEL_WEBHOOK_ALLOWED_IPS: process.env.RINKEL_WEBHOOK_ALLOWED_IPS ?? "82.199.77.220,188.122.73.177",
    RINKEL_REQUEST_TIMEOUT_MS: process.env.RINKEL_REQUEST_TIMEOUT_MS ?? "15000",
    RINKEL_ENFORCE_WEBHOOK_IP_ALLOWLIST: process.env.RINKEL_ENFORCE_WEBHOOK_IP_ALLOWLIST ?? "true",
    RINKEL_TRUST_X_REAL_IP: process.env.RINKEL_TRUST_X_REAL_IP ?? "false",
    RINKEL_RECONCILIATION_ENABLED: process.env.RINKEL_RECONCILIATION_ENABLED ?? "true",
  });
}
