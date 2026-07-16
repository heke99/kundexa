"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getAppContext, isAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptJson, randomToken, sha256 } from "@/lib/crypto";
import { serverEnv } from "@/lib/env";

const value = (form: FormData, key: string) => String(form.get(key) ?? "").trim();

async function adminContext() {
  const context = await getAppContext();
  if (!isAdmin(context.role)) throw new Error("Adminbehörighet krävs");
  return context;
}

function publicHttpsUrl(raw: string) {
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error("Webhook-URL måste använda HTTPS");
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".local") ||
    /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) throw new Error("Privata eller lokala webhook-adresser är inte tillåtna");
  return url.toString();
}

export async function createTeam(form: FormData) {
  const context = await adminContext();
  const name = value(form, "name");
  if (!name) return;
  const supabase = await createClient();
  const { error } = await supabase.from("teams").insert({
    tenant_id: context.tenantId,
    name,
    description: value(form, "description") || null,
    department: value(form, "department") || null,
    office: value(form, "office") || null,
  });
  if (error) throw error;
  revalidatePath("/app/teams");
}

export async function inviteUser(form: FormData) {
  const context = await adminContext();
  const email = value(form, "email");
  const role = value(form, "role") || "sales";
  if (!email) redirect("/app/users?error=E-post krävs");
  const admin = createAdminClient();
  const env = serverEnv();
  const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
    redirectTo: `${env.NEXT_PUBLIC_APP_URL}/auth/callback`,
    data: { invited_tenant_id: context.tenantId },
  });
  if (error) redirect(`/app/users?error=${encodeURIComponent(error.message)}`);
  if (data.user) {
    const { error: membershipError } = await admin.from("tenant_memberships").upsert({
      tenant_id: context.tenantId,
      user_id: data.user.id,
      role,
      status: "invited",
      invited_by: context.userId,
      invited_at: new Date().toISOString(),
    });
    if (membershipError) throw membershipError;
  }
  revalidatePath("/app/users");
  redirect("/app/users");
}

export async function save46ElksIntegration(form: FormData) {
  const context = await adminContext();
  const username = value(form, "username");
  const password = value(form, "password");
  if (!username || !password) redirect("/app/integrations?error=Användarnamn och lösenord krävs");
  const env = serverEnv();
  const admin = createAdminClient();
  const cipher = encryptJson({ username, password }, env.KUNDEXA_ENCRYPTION_KEY);
  const { error } = await admin.from("tenant_integrations").upsert({
    tenant_id: context.tenantId,
    provider_type: "telephony",
    provider: "46elks",
    name: "46elks",
    credentials_ciphertext: cipher,
    status: "active",
    configuration: { account_mode: value(form, "account_mode") || "tenant_owned" },
    created_by: context.userId,
  }, { onConflict: "tenant_id,provider_type,provider,name" });
  if (error) throw error;
  revalidatePath("/app/integrations");
  redirect("/app/integrations?message=46elks är sparat krypterat");
}

export async function saveEmailIntegration(form: FormData) {
  const context = await adminContext();
  const apiKey = value(form, "api_key");
  const from = value(form, "from_address").toLowerCase();
  if (!apiKey || !/^\S+@\S+\.\S+$/.test(from)) redirect("/app/integrations?error=Giltig API-nyckel och avsändaradress krävs");
  const env = serverEnv();
  const admin = createAdminClient();
  const { error } = await admin.from("tenant_integrations").upsert({
    tenant_id: context.tenantId,
    provider_type: "email",
    provider: "resend",
    name: "Resend",
    credentials_ciphertext: encryptJson({ apiKey, from }, env.KUNDEXA_ENCRYPTION_KEY),
    configuration: { from },
    status: "active",
    created_by: context.userId,
  }, { onConflict: "tenant_id,provider_type,provider,name" });
  if (error) throw error;
  revalidatePath("/app/integrations");
  redirect("/app/integrations?message=E-postleverantören är sparad krypterat");
}

export async function addPhoneNumber(form: FormData) {
  const context = await adminContext();
  const number = value(form, "number_e164");
  if (!/^\+[1-9]\d{7,14}$/.test(number)) redirect("/app/integrations?error=Ett giltigt E.164-nummer krävs");
  const env = serverEnv();
  const token = randomToken();
  const admin = createAdminClient();
  const { data: integration } = await admin.from("tenant_integrations").select("id")
    .eq("tenant_id", context.tenantId).eq("provider", "46elks").eq("status", "active").limit(1).maybeSingle();
  const { error } = await admin.from("phone_numbers").insert({
    tenant_id: context.tenantId,
    integration_id: integration?.id,
    number_e164: number,
    supports_voice: form.get("voice") === "on",
    supports_sms: form.get("sms") === "on",
    webhook_token_hash: sha256(token + env.KUNDEXA_WEBHOOK_PEPPER),
    webhook_token_ciphertext: encryptJson({ token }, env.KUNDEXA_ENCRYPTION_KEY),
  });
  if (error) throw error;
  revalidatePath("/app/integrations");
  redirect(`/app/integrations?webhookToken=${encodeURIComponent(token)}`);
}

export async function createAutomation(form: FormData) {
  const context = await adminContext();
  const name = value(form, "name");
  const trigger = value(form, "trigger_key");
  if (!name || !trigger) return;
  const supabase = await createClient();
  const actionType = value(form, "action_type") || "create_activity";
  const action: Record<string, unknown> = { type: actionType };
  if (value(form, "action_title")) action.title = value(form, "action_title");
  if (value(form, "action_body")) action.body = value(form, "action_body");
  if (value(form, "action_subject")) action.subject = value(form, "action_subject");
  const delayMinutes = Math.max(0, Number(value(form, "delay_minutes") || 0));
  const { data: rule, error: ruleError } = await supabase.from("automation_rules").insert({
    tenant_id: context.tenantId,
    name,
    trigger_key: trigger,
    status: "draft",
    created_by: context.userId,
  }).select("id").single();
  if (ruleError || !rule) throw ruleError ?? new Error("Automation kunde inte skapas");
  const { error: versionError } = await supabase.from("automation_versions").insert({
    tenant_id: context.tenantId,
    automation_id: rule.id,
    version: 1,
    conditions: [],
    delay_config: { minutes: delayMinutes },
    actions: [action],
    limits: { max_executions_per_entity: 1, max_actions_per_run: 10, max_sms_per_run: 1, max_email_per_run: 1 },
    test_mode: true,
    created_by: context.userId,
  });
  if (versionError) throw versionError;
  revalidatePath("/app/automations");
}

export async function activateAutomation(form: FormData) {
  const context = await adminContext();
  const automationId = value(form, "automation_id");
  if (!automationId) return;
  const supabase = await createClient();
  const { error } = await supabase.rpc("activate_automation", { p_automation_id: automationId });
  if (error) throw error;
  await supabase.from("audit_logs").insert({
    tenant_id: context.tenantId,
    actor_user_id: context.userId,
    action: "automation.activated",
    entity_type: "automation",
    entity_id: automationId,
  });
  revalidatePath("/app/automations");
}

export async function pauseAutomation(form: FormData) {
  const context = await adminContext();
  const automationId = value(form, "automation_id");
  if (!automationId) return;
  const supabase = await createClient();
  const { error } = await supabase.from("automation_rules").update({ status: "paused" })
    .eq("tenant_id", context.tenantId).eq("id", automationId);
  if (error) throw error;
  revalidatePath("/app/automations");
}

export async function createWebhookEndpoint(form: FormData) {
  const context = await adminContext();
  const name = value(form, "name");
  const rawUrl = value(form, "url");
  const events = form.getAll("events").map(String).filter(Boolean);
  if (!name || !rawUrl || !events.length) redirect("/app/webhooks?error=Namn, URL och minst ett event krävs");
  let url: string;
  try { url = publicHttpsUrl(rawUrl); } catch (error) {
    redirect(`/app/webhooks?error=${encodeURIComponent(error instanceof Error ? error.message : "Ogiltig URL")}`);
  }
  const secret = `whsec_${randomToken(32)}`;
  const env = serverEnv();
  const admin = createAdminClient();
  const { error } = await admin.from("webhook_endpoints").insert({
    tenant_id: context.tenantId,
    name,
    url,
    secret_ciphertext: encryptJson({ secret }, env.KUNDEXA_ENCRYPTION_KEY),
    subscribed_events: events,
    active: true,
    created_by: context.userId,
  });
  if (error) throw error;
  revalidatePath("/app/webhooks");
  redirect(`/app/webhooks?secret=${encodeURIComponent(secret)}`);
}

export async function addVoiceClient(form: FormData) {
  const context = await adminContext();
  const userId = value(form, "user_id");
  const clientNumber = value(form, "client_number_e164");
  const sipUsername = value(form, "sip_username");
  const sipPassword = value(form, "sip_password");
  if (!userId || !/^\+[1-9]\d{7,14}$/.test(clientNumber) || !sipUsername || !sipPassword) {
    redirect("/app/integrations?error=Alla WebRTC-fält krävs och klientnumret måste vara E.164");
  }
  const env = serverEnv();
  const admin = createAdminClient();
  const { data: integration } = await admin.from("tenant_integrations").select("id")
    .eq("tenant_id", context.tenantId).eq("provider", "46elks").eq("status", "active").limit(1).maybeSingle();
  const { error } = await admin.from("voice_clients").upsert({
    tenant_id: context.tenantId,
    assigned_user_id: userId,
    integration_id: integration?.id,
    client_number_e164: clientNumber,
    sip_username: sipUsername,
    sip_password_ciphertext: encryptJson({ password: sipPassword }, env.KUNDEXA_ENCRYPTION_KEY),
    status: "active",
  }, { onConflict: "tenant_id,assigned_user_id" });
  if (error) throw error;
  revalidatePath("/app/integrations");
  redirect("/app/integrations?message=WebRTC-klienten är tilldelad");
}

export async function toggleTenantFeature(form: FormData) {
  await adminContext();
  const featureKey = value(form, "feature_key");
  const enabled = value(form, "enabled") === "true";
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_tenant_feature", {
    p_feature_key: featureKey,
    p_enabled: enabled,
    p_configuration: {},
  });
  if (error) redirect(`/app/admin?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/app/admin");
  redirect("/app/admin");
}

export async function saveLegalEntity(form: FormData) {
  await adminContext();
  const supabase = await createClient();
  const { error } = await supabase.rpc("upsert_tenant_legal_entity", {
    p_id: value(form, "id") || null,
    p_legal_name: value(form, "legal_name"),
    p_organization_number: value(form, "organization_number"),
    p_address_line1: value(form, "address_line1"),
    p_postal_code: value(form, "postal_code"),
    p_city: value(form, "city"),
    p_country_code: value(form, "country_code") || "SE",
    p_email: value(form, "email"),
    p_phone_e164: value(form, "phone_e164"),
    p_website: value(form, "website"),
    p_is_default: form.get("is_default") === "on",
  });
  if (error) redirect(`/app/admin?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/app/admin");
  revalidatePath("/app/contracts");
  revalidatePath("/app/templates");
  redirect("/app/admin?message=Juridiskt avsändarbolag sparat");
}

function csvValues(raw: string) {
  return [...new Set(raw.split(",").map((entry) => entry.trim()).filter(Boolean))];
}

export async function configureGenericJsonProvider(form: FormData) {
  await adminContext();
  const provider = value(form, "provider").toLowerCase();
  const name = value(form, "name");
  const endpointTemplate = value(form, "endpoint_template");
  const method = (value(form, "method") || "GET").toUpperCase();
  const apiKey = value(form, "api_key");
  const apiKeyHeader = value(form, "api_key_header") || "Authorization";
  const allowedDomains = csvValues(value(form, "allowed_domains")).map((domain) => domain.toLowerCase());
  const allowedPaths = csvValues(value(form, "allowed_paths"));
  const allowedPurposes = csvValues(value(form, "allowed_purposes"));
  const entityTypes = form.getAll("entity_types").map(String).filter((entry) => ["organization", "establishment", "person"].includes(entry));
  let fieldMapping: Record<string, string>;
  try {
    const parsed = JSON.parse(value(form, "field_mapping"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Object.keys(parsed).length || Object.values(parsed).some((entry) => typeof entry !== "string")) {
      throw new Error("Fältmappningen måste vara ett JSON-objekt där varje värde är en sökväg");
    }
    fieldMapping = parsed as Record<string, string>;
  } catch (error) {
    redirect(`/app/data-sources?error=${encodeURIComponent(error instanceof Error ? error.message : "Ogiltig fältmappning")}`);
  }
  if (!provider || !name || !endpointTemplate || !allowedDomains.length || !entityTypes.length) {
    redirect("/app/data-sources?error=Leverantör, namn, endpoint, domän och entitetstyp krävs");
  }
  try {
    const testUrl = endpointTemplate
      .replaceAll("{{external_identifier}}", "5560000000")
      .replaceAll("{{organization_number}}", "5560000000")
      .replaceAll("{{purpose}}", "crm_refresh")
      .replaceAll("{{entity_type}}", "organization");
    publicHttpsUrl(testUrl);
  } catch (error) {
    redirect(`/app/data-sources?error=${encodeURIComponent(error instanceof Error ? error.message : "Ogiltig endpoint")}`);
  }
  const env = serverEnv();
  const credentialsCiphertext = apiKey
    ? encryptJson({ apiKey, apiKeyHeader }, env.KUNDEXA_ENCRYPTION_KEY)
    : "";
  const supabase = await createClient();
  const { error } = await supabase.rpc("configure_generic_json_provider", {
    p_provider: provider,
    p_name: name,
    p_permission_name: value(form, "permission_name") || `${name} produktionsrätt`,
    p_endpoint_template: endpointTemplate,
    p_method: method,
    p_credentials_ciphertext: credentialsCiphertext,
    p_field_mapping: fieldMapping,
    p_allowed_domains: allowedDomains,
    p_allowed_paths: allowedPaths,
    p_allowed_entity_types: entityTypes,
    p_allowed_purposes: allowedPurposes,
    p_cache_scope: value(form, "cache_scope") || "tenant",
    p_raw_storage_allowed: form.get("raw_storage_allowed") === "on",
    p_tenant_display_allowed: form.get("tenant_display_allowed") === "on",
    p_cross_tenant_reuse_allowed: form.get("cross_tenant_reuse_allowed") === "on",
    p_export_allowed: form.get("export_allowed") === "on",
    p_attribution_required: form.get("attribution_required") === "on",
    p_retention_days: value(form, "retention_days") ? Number(value(form, "retention_days")) : null,
    p_written_approval_reference: value(form, "written_approval_reference"),
    p_quota_units: Math.max(1, Number(value(form, "quota_units") || 5000)),
    p_quota_window_seconds: Math.max(1, Number(value(form, "quota_window_seconds") || 432000)),
    p_max_concurrency: Math.max(1, Number(value(form, "max_concurrency") || 1)),
    p_minimum_delay_ms: Math.max(0, Number(value(form, "minimum_delay_ms") || 250)),
    p_timeout_ms: Math.max(1000, Number(value(form, "timeout_ms") || 30000)),
    p_max_retries: Math.max(0, Number(value(form, "max_retries") || 5)),
    p_ttl_days: Math.max(0, Number(value(form, "ttl_days") || 20)),
    p_estimated_cost_per_call: Math.max(0, Number(value(form, "estimated_cost_per_call") || 0)),
  });
  if (error) redirect(`/app/data-sources?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/app/data-sources");
  redirect("/app/data-sources?message=Dataleverantören och dess tillstånd är sparade atomiskt");
}
