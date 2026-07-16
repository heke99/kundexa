import { z } from "zod";

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
  });
}
