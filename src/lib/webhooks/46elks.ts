import { createAdminClient } from "@/lib/supabase/admin";
import { serverEnv } from "@/lib/env";
import { sha256 } from "@/lib/crypto";

export async function verify46ElksNetwork(request: Request) {
  const env = serverEnv();
  if (!env.ENFORCE_46ELKS_IP_ALLOWLIST) return true;
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const direct = request.headers.get("x-real-ip")?.trim();
  const ip = forwarded || direct;
  if (!ip) return false;
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("is_provider_ip_allowed", { p_provider: "46elks", p_ip: ip });
  return !error && data === true;
}

export async function authenticate46ElksNumber(toNumber: string, token: string) {
  const env = serverEnv();
  const admin = createAdminClient();
  const { data: number } = await admin
    .from("phone_numbers")
    .select("*")
    .eq("number_e164", toNumber)
    .eq("status", "active")
    .maybeSingle();
  if (!number || number.webhook_token_hash !== sha256(token + env.KUNDEXA_WEBHOOK_PEPPER)) return null;
  return number;
}

export function formToObject(form: FormData) {
  return Object.fromEntries(Array.from(form.entries()).map(([key, value]) => [key, String(value)]));
}
