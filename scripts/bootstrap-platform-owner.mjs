import process from "node:process";
import { createClient } from "@supabase/supabase-js";

for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(file);
  } catch {
    // Optional local env files. Explicit shell variables remain supported.
  }
}

function argument(name) {
  const prefix = `--${name}=`;
  const inline = process.argv.slice(2).find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length).trim();
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] ?? "").trim() : "";
}

const email = (argument("email") || process.env.KUNDEXA_PLATFORM_OWNER_EMAIL || "").toLowerCase();
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!email || !email.includes("@")) {
  console.error("Ange en giltig e-post: npm run platform:bootstrap-owner -- --email=namn@foretag.se");
  process.exit(1);
}
if (!supabaseUrl || !serviceRoleKey) {
  console.error("NEXT_PUBLIC_SUPABASE_URL och SUPABASE_SERVICE_ROLE_KEY måste finnas i miljön eller .env.local.");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { headers: { "x-kundexa-operation": "bootstrap-platform-owner" } },
});

let target = null;
for (let page = 1; page <= 100 && !target; page += 1) {
  const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
  if (error) {
    console.error(`Kunde inte läsa Supabase-användare: ${error.message}`);
    process.exit(1);
  }
  target = data.users.find((user) => user.email?.toLowerCase() === email) ?? null;
  if (data.users.length < 1000) break;
}

if (!target) {
  console.error(`Ingen bekräftad Supabase-användare hittades för ${email}. Registrera användaren i Kundexa först.`);
  process.exit(1);
}

const now = new Date().toISOString();
const { error: membershipError } = await supabase.from("platform_memberships").upsert({
  user_id: target.id,
  role: "platform_owner",
  status: "active",
  created_by: target.id,
  updated_at: now,
}, { onConflict: "user_id" });

if (membershipError) {
  console.error(`Kunde inte skapa plattformsägaren: ${membershipError.message}`);
  console.error("Kontrollera att migrationen 202607170001_platform_admin_and_idempotent_onboarding.sql är körd.");
  process.exit(1);
}

const { error: auditError } = await supabase.from("platform_audit_logs").insert({
  actor_user_id: target.id,
  action: "platform_owner.bootstrapped",
  entity_type: "platform_membership",
  entity_id: target.id,
  reason: "Initial plattformsägare skapad med repositoryts betrodda bootstrapkommando",
  metadata: { role: "platform_owner", source: "scripts/bootstrap-platform-owner.mjs" },
});

if (auditError) {
  console.error(`Plattformsrollen skapades, men auditloggen misslyckades: ${auditError.message}`);
  process.exit(1);
}

const { data: profile, error: profileError } = await supabase.from("profiles")
  .select("active_tenant_id")
  .eq("id", target.id)
  .maybeSingle();

console.log(`Plattformsägare aktiverad: ${email} (${target.id})`);
if (profileError || !profile?.active_tenant_id) {
  console.warn("Användaren saknar active_tenant_id. Slutför tenant-onboarding innan /app/platform/telephony öppnas.");
} else {
  console.log("Logga ut och in igen och öppna /app/platform/telephony.");
}
