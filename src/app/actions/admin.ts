"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getAppContext, isAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptJson, randomToken, sha256 } from "@/lib/crypto";
import { serverEnv } from "@/lib/env";
import { getScraperAdapter, identityFieldMapping, validateScraperFilter } from "../../../supabase/functions/_shared/providers";

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
  const context = await adminContext();
  const provider = value(form, "provider").toLowerCase();
  const name = value(form, "name");
  const endpointTemplate = value(form, "endpoint_template");
  const discoveryEndpoint = value(form, "discovery_endpoint_template");
  const method = (value(form, "method") || "GET").toUpperCase();
  const discoveryMethod = (value(form, "discovery_method") || "GET").toUpperCase();
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
    if (discoveryEndpoint) {
      publicHttpsUrl(discoveryEndpoint
        .replaceAll("{{page}}", "1").replaceAll("{{limit}}", "100").replaceAll("{{entity_type}}", "organization")
        .replace(/\{\{[a-zA-Z0-9_]+\}\}/g, "test"));
    }
  } catch (error) {
    redirect(`/app/data-sources?error=${encodeURIComponent(error instanceof Error ? error.message : "Ogiltig endpoint")}`);
  }
  const env = serverEnv();
  const credentialsCiphertext = apiKey ? encryptJson({ apiKey, apiKeyHeader }, env.KUNDEXA_ENCRYPTION_KEY) : "";
  const supabase = await createClient();
  const { data: configured, error } = await supabase.rpc("configure_generic_json_provider", {
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
  const ids = configured as { provider_id: string; account_id: string; permission_id: string } | null;
  if (!ids?.provider_id || !ids.account_id || !ids.permission_id) redirect("/app/data-sources?error=Leverantörskonfigurationen returnerade inga identifierare");

  const discoveryConfiguration = discoveryEndpoint ? {
    endpoint_template: discoveryEndpoint,
    method: discoveryMethod,
    format: value(form, "discovery_format") || "json",
    items_path: value(form, "items_path") || undefined,
    next_page_path: value(form, "next_page_path") || undefined,
    external_id_path: value(form, "external_id_path") || "id",
    source_timestamp_path: value(form, "source_timestamp_path") || undefined,
    page_parameter: value(form, "page_parameter") || undefined,
    page_start: Math.max(0, Number(value(form, "page_start") || 1)),
    page_size: Math.max(1, Math.min(Number(value(form, "page_size") || 100), 1000)),
    max_pages_per_run: Math.max(1, Math.min(Number(value(form, "max_pages_per_run") || 100), 1000)),
    field_mapping: fieldMapping,
    timeout_ms: Math.max(1000, Number(value(form, "timeout_ms") || 30000)),
  } : {};
  const sourceClass = value(form, "source_class") || "licensed_provider";
  const { error: providerUpdateError } = await supabase.from("data_providers").update({ source_class: sourceClass, discovery_configuration: discoveryConfiguration }).eq("tenant_id", context.tenantId).eq("id", ids.provider_id);
  if (providerUpdateError) redirect(`/app/data-sources?error=${encodeURIComponent(providerUpdateError.message)}`);

  for (const entityType of entityTypes) {
    const expectedFields = Object.keys(fieldMapping);
    const { data: activeParser } = await supabase.from("parser_versions").select("id,version").eq("tenant_id", context.tenantId).eq("data_provider_id", ids.provider_id).eq("entity_type", entityType).eq("status", "active").order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (activeParser) {
      const { error: parserError } = await supabase.from("parser_versions").update({ expected_fields: expectedFields, minimum_match_rate: Number(value(form, "minimum_match_rate") || 0.9), disappearance_threshold: Number(value(form, "disappearance_threshold") || 0.1) }).eq("id", activeParser.id);
      if (parserError) redirect(`/app/data-sources?error=${encodeURIComponent(parserError.message)}`);
    } else {
      const { error: parserError } = await supabase.from("parser_versions").insert({ tenant_id: context.tenantId, data_provider_id: ids.provider_id, entity_type: entityType, version: "1", expected_fields: expectedFields, minimum_match_rate: Number(value(form, "minimum_match_rate") || 0.9), disappearance_threshold: Number(value(form, "disappearance_threshold") || 0.1), status: "active", created_by: context.userId });
      if (parserError) redirect(`/app/data-sources?error=${encodeURIComponent(parserError.message)}`);
    }

    if (discoveryEndpoint) {
      const jobName = `${name} – ${entityType} – femdagarsinsamling`;
      const { data: existingJob } = await supabase.from("ingestion_jobs").select("id").eq("tenant_id", context.tenantId).eq("data_provider_id", ids.provider_id).eq("name", jobName).maybeSingle();
      const payload = {
        tenant_id: context.tenantId, data_provider_id: ids.provider_id, provider_account_id: ids.account_id, permission_id: ids.permission_id,
        name: jobName, entity_type: entityType, schedule_expression: "every 5 days", schedule_interval_seconds: Math.max(3600, Number(value(form, "schedule_interval_seconds") || 432000)),
        priority: 100, max_records: Math.max(1, Math.min(Number(value(form, "ingestion_max_records") || 5000), 5000)), quota_interpretation: value(form, "quota_interpretation") || "per_run",
        filter_definition: {}, status: "active", next_run_at: form.get("start_ingestion_now") === "on" ? new Date().toISOString() : new Date(Date.now() + 432000000).toISOString(),
        adapter_key: "generic_json", adapter_configuration: discoveryConfiguration, created_by: context.userId,
      };
      const jobQuery = existingJob ? supabase.from("ingestion_jobs").update(payload).eq("id", existingJob.id) : supabase.from("ingestion_jobs").insert(payload);
      const { error: jobError } = await jobQuery;
      if (jobError) redirect(`/app/data-sources?error=${encodeURIComponent(jobError.message)}`);
    }
  }
  revalidatePath("/app/data-sources");
  revalidatePath("/app/directory");
  redirect("/app/data-sources?message=Leverantör, parser, tillstånd och femdagarsinsamling är sparade atomiskt");
}

// Konfigurerar en tillåten skrapkälla (Allabolag/Merinfo) ovanpå samma kanoniska
// providerflöde som API-källor: konto, tillstånd, fältlicenser, kvoter, freshness,
// parserversioner och femdagarsinsamling. Alla gränser lagras i databasen och kan
// justeras utan koddeploy; adaptern i workern styr URL, parsning och normalisering.
export async function configureScraperProvider(form: FormData) {
  const context = await adminContext();
  const adapter = getScraperAdapter(value(form, "adapter_key"));
  if (!adapter) redirect("/app/data-sources?error=Okänd scraperadapter");
  const entityTypes = form.getAll("entity_types").map(String)
    .filter((entry): entry is "organization" | "person" => adapter.entityTypes.includes(entry as "organization" | "person"));
  if (!entityTypes.length) redirect("/app/data-sources?error=Minst en tillåten entitetstyp krävs");
  if (adapter.personDataRestricted && entityTypes.includes("person") && form.get("person_data_approved") !== "on") {
    redirect("/app/data-sources?error=Persondata kräver dokumenterat tillstånd och uttryckligt godkännande");
  }
  let filter;
  try {
    filter = validateScraperFilter({
      query: value(form, "filter_query"), companyName: value(form, "filter_company_name"),
      sniCode: value(form, "filter_sni_code"), legalForm: value(form, "filter_legal_form"),
      county: value(form, "filter_county"), municipality: value(form, "filter_municipality"),
      city: value(form, "filter_city"), postalCode: value(form, "filter_postal_code"),
      employeeMin: value(form, "filter_employee_min") || undefined, employeeMax: value(form, "filter_employee_max") || undefined,
      revenueMin: value(form, "filter_revenue_min") || undefined, revenueMax: value(form, "filter_revenue_max") || undefined,
      onlyActive: form.get("filter_only_active") === "on",
    });
  } catch (error) {
    redirect(`/app/data-sources?error=${encodeURIComponent(error instanceof Error ? error.message : "Ogiltigt filter")}`);
  }
  const fieldMapping = identityFieldMapping(adapter);
  const maxRecords = Math.max(1, Math.min(Number(value(form, "max_records") || adapter.defaults.maxRecordsPerRun), adapter.defaults.maxRecordsPerRun));
  const scheduleIntervalSeconds = Math.max(3600, Number(value(form, "schedule_interval_seconds") || adapter.defaults.scheduleIntervalSeconds));
  const quotaUnits = Math.max(1, Number(value(form, "quota_units") || adapter.defaults.quotaUnits));
  const quotaWindowSeconds = Math.max(1, Number(value(form, "quota_window_seconds") || adapter.defaults.quotaWindowSeconds));
  const minimumDelayMs = Math.max(adapter.defaults.minimumDelayMs, Number(value(form, "minimum_delay_ms") || adapter.defaults.minimumDelayMs));
  const timeoutMs = Math.max(1000, Math.min(Number(value(form, "timeout_ms") || adapter.defaults.timeoutMs), 120000));
  const maxRetries = Math.max(0, Math.min(Number(value(form, "max_retries") || adapter.defaults.maxRetries), 20));
  const ttlDays = Math.max(0, Math.min(Number(value(form, "ttl_days") || adapter.defaults.freshnessTtlDays), 3650));
  const supabase = await createClient();
  const { data: configured, error } = await supabase.rpc("configure_generic_json_provider", {
    p_provider: adapter.key,
    p_name: value(form, "name") || adapter.name,
    p_permission_name: value(form, "permission_name") || `${adapter.name} skraptillstånd`,
    p_endpoint_template: adapter.defaults.detailEndpointTemplate,
    p_method: "GET",
    p_credentials_ciphertext: "",
    p_field_mapping: fieldMapping,
    p_allowed_domains: adapter.defaults.allowedDomains,
    p_allowed_paths: adapter.defaults.allowedPaths,
    p_allowed_entity_types: entityTypes,
    p_allowed_purposes: csvValues(value(form, "allowed_purposes") || "prospecting,crm_refresh"),
    p_cache_scope: "tenant",
    p_raw_storage_allowed: form.get("raw_storage_allowed") === "on",
    p_tenant_display_allowed: true,
    p_cross_tenant_reuse_allowed: false,
    p_export_allowed: false,
    p_attribution_required: true,
    p_retention_days: value(form, "retention_days") ? Number(value(form, "retention_days")) : (form.get("raw_storage_allowed") === "on" ? 30 : null),
    p_written_approval_reference: value(form, "written_approval_reference"),
    p_quota_units: quotaUnits,
    p_quota_window_seconds: quotaWindowSeconds,
    p_max_concurrency: Math.max(1, Math.min(Number(value(form, "max_concurrency") || adapter.defaults.maxConcurrency), 4)),
    p_minimum_delay_ms: minimumDelayMs,
    p_timeout_ms: timeoutMs,
    p_max_retries: maxRetries,
    p_ttl_days: ttlDays,
    p_estimated_cost_per_call: 0,
  });
  if (error) redirect(`/app/data-sources?error=${encodeURIComponent(error.message)}`);
  const ids = configured as { provider_id: string; account_id: string; permission_id: string } | null;
  if (!ids?.provider_id || !ids.account_id || !ids.permission_id) redirect("/app/data-sources?error=Scraperkonfigurationen returnerade inga identifierare");

  const discoveryConfiguration = {
    endpoint_template: adapter.defaults.searchEndpointTemplate,
    format: "html_regex",
    page_parameter: adapter.defaults.pageParameter,
    page_start: adapter.defaults.pageStart,
    page_size: adapter.defaults.pageSize,
    max_pages_per_run: adapter.defaults.maxPagesPerRun,
    timeout_ms: timeoutMs,
    minimum_delay_ms: minimumDelayMs,
    max_retries: maxRetries,
  };
  const { error: providerUpdateError } = await supabase.from("data_providers")
    .update({ adapter_key: adapter.key, integration_type: "scrape_html", source_class: adapter.sourceClass, discovery_configuration: discoveryConfiguration })
    .eq("tenant_id", context.tenantId).eq("id", ids.provider_id);
  if (providerUpdateError) redirect(`/app/data-sources?error=${encodeURIComponent(providerUpdateError.message)}`);

  // Separat kvotnyckel för discovery-insamling: en enhet per externt anrop.
  const { error: rateError } = await supabase.from("provider_rate_limits").upsert({
    tenant_id: context.tenantId, provider_account_id: ids.account_id, quota_key: "ingestion",
    window_seconds: quotaWindowSeconds, max_units: quotaUnits, max_concurrency: 1,
    minimum_delay_ms: minimumDelayMs, timeout_ms: timeoutMs, max_retries: maxRetries,
  }, { onConflict: "provider_account_id,quota_key" });
  if (rateError) redirect(`/app/data-sources?error=${encodeURIComponent(rateError.message)}`);

  const coreExpectedFields = adapter.key === "allabolag" ? ["canonical_name", "organization_number"] : ["canonical_name"];
  for (const entityType of entityTypes) {
    const { data: activeParser } = await supabase.from("parser_versions").select("id").eq("tenant_id", context.tenantId).eq("data_provider_id", ids.provider_id).eq("entity_type", entityType).eq("status", "active").order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (activeParser) {
      const { error: parserError } = await supabase.from("parser_versions").update({ expected_fields: coreExpectedFields, minimum_match_rate: 0.9, disappearance_threshold: 0.2 }).eq("id", activeParser.id);
      if (parserError) redirect(`/app/data-sources?error=${encodeURIComponent(parserError.message)}`);
    } else {
      const { error: parserError } = await supabase.from("parser_versions").insert({ tenant_id: context.tenantId, data_provider_id: ids.provider_id, entity_type: entityType, version: "1", expected_fields: coreExpectedFields, minimum_match_rate: 0.9, disappearance_threshold: 0.2, status: "active", created_by: context.userId });
      if (parserError) redirect(`/app/data-sources?error=${encodeURIComponent(parserError.message)}`);
    }
    const jobName = `${adapter.name} – ${entityType} – femdagarsinsamling`;
    const { data: existingJob } = await supabase.from("ingestion_jobs").select("id").eq("tenant_id", context.tenantId).eq("data_provider_id", ids.provider_id).eq("name", jobName).maybeSingle();
    const payload = {
      tenant_id: context.tenantId, data_provider_id: ids.provider_id, provider_account_id: ids.account_id, permission_id: ids.permission_id,
      name: jobName, entity_type: entityType, schedule_expression: "every 5 days", schedule_interval_seconds: scheduleIntervalSeconds,
      priority: 100, max_records: maxRecords, quota_interpretation: "per_run",
      filter_definition: filter as Record<string, unknown>, status: "active",
      next_run_at: form.get("start_ingestion_now") === "on" ? new Date().toISOString() : new Date(Date.now() + scheduleIntervalSeconds * 1000).toISOString(),
      adapter_key: adapter.key, adapter_configuration: discoveryConfiguration, created_by: context.userId,
    };
    const jobQuery = existingJob ? supabase.from("ingestion_jobs").update(payload).eq("id", existingJob.id) : supabase.from("ingestion_jobs").insert(payload);
    const { error: jobError } = await jobQuery;
    if (jobError) redirect(`/app/data-sources?error=${encodeURIComponent(jobError.message)}`);
  }
  revalidatePath("/app/data-sources");
  revalidatePath("/app/directory");
  redirect(`/app/data-sources?message=${encodeURIComponent(`${adapter.name} är konfigurerad med tillstånd, kvoter, parser och femdagarsinsamling`)}`);
}

// Administrativ jobbkontroll: pausa, återuppta (inklusive dead letter med bevarad
// checkpoint) eller avbryt en ingestionkörning. Behörighet verifieras i databasen.
export async function controlIngestionRun(form: FormData) {
  await adminContext();
  const runId = value(form, "run_id");
  const action = value(form, "action");
  if (!runId || !["pause", "resume", "cancel"].includes(action)) return;
  const supabase = await createClient();
  const { error } = await supabase.rpc("control_ingestion_run", { p_run_id: runId, p_action: action });
  if (error) redirect(`/app/data-sources?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/app/data-sources");
  redirect(`/app/data-sources?message=${encodeURIComponent(`Körningen är uppdaterad (${action})`)}`);
}

export async function setProviderStatus(form: FormData) {
  const context = await adminContext();
  const providerId = value(form, "provider_id");
  const status = value(form, "status");
  if (!providerId || !["active", "paused"].includes(status)) return;
  const supabase = await createClient();
  const { error } = await supabase.from("data_providers").update({ status, paused_reason: status === "paused" ? value(form, "reason") || "Manuellt pausad" : null }).eq("tenant_id", context.tenantId).eq("id", providerId);
  if (error) redirect(`/app/data-sources?error=${encodeURIComponent(error.message)}`);
  await supabase.from("provider_accounts").update({ status: status === "active" ? "active" : "paused" }).eq("tenant_id", context.tenantId).eq("data_provider_id", providerId);
  revalidatePath("/app/data-sources");
}

export async function runIngestionNow(form: FormData) {
  const context = await adminContext();
  const jobId = value(form, "ingestion_job_id");
  if (!jobId) return;
  const supabase = await createClient();
  const { error } = await supabase.from("ingestion_jobs").update({ next_run_at: new Date().toISOString(), status: "active" }).eq("tenant_id", context.tenantId).eq("id", jobId);
  if (error) redirect(`/app/data-sources?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/app/data-sources");
  redirect("/app/data-sources?message=Insamlingen är köad för nästa worker-körning");
}

export async function approveParserObservation(form: FormData) {
  const context = await adminContext();
  const observationId = value(form, "observation_id");
  const parserId = value(form, "parser_version_id");
  if (!observationId || !parserId) return;
  const supabase = await createClient();
  const { data: observation, error } = await supabase.from("parser_observations").update({ status: "approved", reviewed_by: context.userId, reviewed_at: new Date().toISOString() }).eq("tenant_id", context.tenantId).eq("id", observationId).select("page_fingerprint").single();
  if (error) redirect(`/app/data-sources?error=${encodeURIComponent(error.message)}`);
  const { error: parserError } = await supabase.from("parser_versions").update({ status: "active", page_fingerprint: observation.page_fingerprint }).eq("tenant_id", context.tenantId).eq("id", parserId);
  if (parserError) redirect(`/app/data-sources?error=${encodeURIComponent(parserError.message)}`);
  revalidatePath("/app/data-sources");
}

function parseJsonObject(raw: string, label: string) {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`${label} måste vara ett giltigt JSON-objekt`);
  }
}

export async function configureNixProvider(form: FormData) {
  const context = await adminContext();
  const name = value(form, "name");
  const endpointTemplate = value(form, "endpoint_template");
  const method = (value(form, "method") || "GET").toUpperCase();
  const allowedDomains = csvValues(value(form, "allowed_domains")).map((domain) => domain.toLowerCase());
  const allowedPaths = csvValues(value(form, "allowed_paths"));
  const apiKey = value(form, "api_key");
  const apiKeyHeader = value(form, "api_key_header") || "Authorization";
  if (!name || !endpointTemplate || !allowedDomains.length || !["GET", "POST"].includes(method)) {
    redirect("/app/compliance?error=Namn, HTTPS-endpoint, metod och minst en tillåten domän krävs");
  }
  try {
    publicHttpsUrl(endpointTemplate.replaceAll("{{phone_e164}}", "%2B46700000000").replaceAll("{{phone}}", "46700000000").replaceAll("{{customer_id}}", crypto.randomUUID()));
  } catch (error) {
    redirect(`/app/compliance?error=${encodeURIComponent(error instanceof Error ? error.message : "Ogiltig NIX-endpoint")}`);
  }
  let resultMapping: Record<string, unknown>;
  let requestHeaders: Record<string, unknown>;
  let requestQuery: Record<string, unknown>;
  let requestBody: Record<string, unknown>;
  try {
    resultMapping = parseJsonObject(value(form, "result_mapping") || '{"listed":"listed","not_listed":"not_listed","unknown":"unknown"}', "Resultatmappningen");
    requestHeaders = parseJsonObject(value(form, "request_headers"), "Request headers");
    requestQuery = parseJsonObject(value(form, "request_query"), "Query-parametrarna");
    requestBody = parseJsonObject(value(form, "request_body"), "Request body");
  } catch (error) {
    redirect(`/app/compliance?error=${encodeURIComponent(error instanceof Error ? error.message : "Ogiltig JSON-konfiguration")}`);
  }
  const env = serverEnv();
  const credentialsCiphertext = apiKey
    ? encryptJson({ apiKey, apiKeyHeader }, env.KUNDEXA_ENCRYPTION_KEY)
    : null;
  const admin = createAdminClient();
  const { error } = await admin.from("nix_provider_configurations").upsert({
    tenant_id: context.tenantId,
    name,
    status: "active",
    endpoint_template: endpointTemplate,
    method,
    allowed_domains: allowedDomains,
    allowed_paths: allowedPaths,
    credentials_ciphertext: credentialsCiphertext,
    request_configuration: {
      headers: requestHeaders,
      query: requestQuery,
      body: requestBody,
      source_version_path: value(form, "source_version_path") || undefined,
    },
    result_path: value(form, "result_path") || "result",
    result_mapping: resultMapping,
    validity_days: Math.max(1, Math.min(Number(value(form, "validity_days") || 60), 365)),
    timeout_ms: Math.max(1000, Math.min(Number(value(form, "timeout_ms") || 15000), 120000)),
    max_retries: Math.max(0, Math.min(Number(value(form, "max_retries") || 5), 20)),
    created_by: context.userId,
  }, { onConflict: "tenant_id,name" });
  if (error) redirect(`/app/compliance?error=${encodeURIComponent(error.message)}`);
  await admin.from("audit_logs").insert({
    tenant_id: context.tenantId,
    actor_user_id: context.userId,
    action: "nix_provider.configured",
    entity_type: "nix_provider_configuration",
    after_data: { name, method, allowedDomains, allowedPaths },
  });
  revalidatePath("/app/compliance");
  redirect("/app/compliance?message=NIX-leverantören är sparad och aktiverad");
}

export async function setNixProviderStatus(form: FormData) {
  const context = await adminContext();
  const id = value(form, "id");
  const status = value(form, "status");
  if (!id || !["active", "paused", "inactive"].includes(status)) return;
  const admin = createAdminClient();
  const { error } = await admin.from("nix_provider_configurations").update({ status }).eq("tenant_id", context.tenantId).eq("id", id);
  if (error) redirect(`/app/compliance?error=${encodeURIComponent(error.message)}`);
  await admin.from("audit_logs").insert({
    tenant_id: context.tenantId,
    actor_user_id: context.userId,
    action: "nix_provider.status_changed",
    entity_type: "nix_provider_configuration",
    entity_id: id,
    after_data: { status },
  });
  revalidatePath("/app/compliance");
}

export async function queueCustomerNixCheck(form: FormData) {
  const context = await adminContext();
  const customerId = value(form, "customer_id");
  if (!customerId) redirect("/app/compliance?error=Kund-ID krävs");
  const admin = createAdminClient();
  const { error } = await admin.rpc("queue_nix_check_for_customer", {
    p_tenant_id: context.tenantId,
    p_customer_id: customerId,
    p_requested_by: context.userId,
    p_force: form.get("force") === "on",
  });
  if (error) redirect(`/app/compliance?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/app/compliance");
  redirect("/app/compliance?message=NIX-kontrollen har lagts i kön");
}

export async function createDataSubjectRequest(form: FormData) {
  const context = await adminContext();
  const customerId = value(form, "customer_id");
  const requestType = value(form, "request_type");
  const subjectReference = value(form, "subject_reference");
  if (!customerId || !subjectReference || !["access", "rectification", "erasure", "portability", "restriction", "objection"].includes(requestType)) {
    redirect("/app/compliance?error=Kund, referens och giltig begärantyp krävs");
  }
  const admin = createAdminClient();
  const { data: customer } = await admin.from("customers").select("id").eq("tenant_id", context.tenantId).eq("id", customerId).is("deleted_at", null).maybeSingle();
  if (!customer) redirect("/app/compliance?error=Kunden hittades inte i denna tenant");
  const dueAt = value(form, "due_at") || new Date(Date.now() + 30 * 86400000).toISOString();
  const { data: request, error } = await admin.from("data_subject_requests").insert({
    tenant_id: context.tenantId,
    customer_id: customerId,
    request_type: requestType,
    subject_reference: subjectReference,
    status: "identity_verification",
    due_at: dueAt,
    evidence: {},
    created_by: context.userId,
  }).select("id").single();
  if (error || !request) redirect(`/app/compliance?error=${encodeURIComponent(error?.message ?? "Begäran kunde inte skapas")}`);
  await admin.from("data_subject_request_events").insert({ tenant_id: context.tenantId, request_id: request.id, event_type: "request_received", actor_user_id: context.userId, details: { requestType } });
  revalidatePath("/app/compliance");
  redirect("/app/compliance?message=Integritetsbegäran skapad och väntar på identitetskontroll");
}

export async function verifyDataSubjectIdentity(form: FormData) {
  const context = await adminContext();
  const requestId = value(form, "request_id");
  if (!requestId) return;
  const admin = createAdminClient();
  const { error } = await admin.from("data_subject_requests").update({
    status: "processing",
    identity_verified_at: new Date().toISOString(),
    handled_by: context.userId,
    evidence: { verificationMethod: value(form, "verification_method") || "manual_admin_verification" },
  }).eq("tenant_id", context.tenantId).eq("id", requestId).eq("status", "identity_verification");
  if (error) redirect(`/app/compliance?error=${encodeURIComponent(error.message)}`);
  await admin.from("data_subject_request_events").insert({ tenant_id: context.tenantId, request_id: requestId, event_type: "identity_verified", actor_user_id: context.userId, details: { method: value(form, "verification_method") || "manual_admin_verification" } });
  revalidatePath("/app/compliance");
}

export async function exportDataSubjectRequest(form: FormData) {
  const context = await adminContext();
  const requestId = value(form, "request_id");
  if (!requestId) return;
  const admin = createAdminClient();
  const { data: request } = await admin.from("data_subject_requests").select("id,request_type,status,identity_verified_at").eq("tenant_id", context.tenantId).eq("id", requestId).single();
  if (!request?.identity_verified_at || !["access", "portability"].includes(request.request_type)) redirect("/app/compliance?error=Identiteten måste vara verifierad och typen måste vara registerutdrag eller dataportabilitet");
  const { data, error } = await admin.rpc("data_subject_export_for_request", { p_request_id: requestId });
  if (error) redirect(`/app/compliance?error=${encodeURIComponent(error.message)}`);
  const serialized = JSON.stringify(data, null, 2);
  const path = `${context.tenantId}/dsar/${requestId}/${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const { error: uploadError } = await admin.storage.from("compliance-exports").upload(path, Buffer.from(serialized, "utf8"), { contentType: "application/json", upsert: false });
  if (uploadError) redirect(`/app/compliance?error=${encodeURIComponent(uploadError.message)}`);
  const resultHash = sha256(serialized);
  await admin.from("data_subject_requests").update({ status: "completed", completed_at: new Date().toISOString(), handled_by: context.userId, result_storage_path: path, result_hash: resultHash }).eq("tenant_id", context.tenantId).eq("id", requestId);
  await admin.from("data_subject_request_events").insert({ tenant_id: context.tenantId, request_id: requestId, event_type: "export_generated", actor_user_id: context.userId, details: { path, sha256: resultHash } });
  revalidatePath("/app/compliance");
  redirect("/app/compliance?message=Integritetsexport skapad i privat lagring");
}

export async function executeDataSubjectErasure(form: FormData) {
  const context = await adminContext();
  const requestId = value(form, "request_id");
  if (!requestId) return;
  const admin = createAdminClient();
  const { error } = await admin.rpc("execute_data_subject_erasure", { p_request_id: requestId, p_actor: context.userId });
  if (error) redirect(`/app/compliance?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/app/compliance");
  redirect("/app/compliance?message=Raderingsbegäran har genomförts med juridisk retention och minimal spärrpost");
}

export async function executeDataSubjectRestriction(form: FormData) {
  const context = await adminContext();
  const requestId = value(form, "request_id");
  if (!requestId) return;
  const admin = createAdminClient();
  const { data: request } = await admin.from("data_subject_requests").select("id,customer_id,request_type,identity_verified_at").eq("tenant_id", context.tenantId).eq("id", requestId).single();
  if (!request?.customer_id || !request.identity_verified_at || !["restriction", "objection"].includes(request.request_type)) redirect("/app/compliance?error=Begäran är inte verifierad eller saknar kund");
  const reason = request.request_type === "objection" ? "Invändning mot direktmarknadsföring" : "Behandlingsbegränsning";
  const { data: customer } = await admin.from("customers").select("phone_e164,email").eq("tenant_id", context.tenantId).eq("id", request.customer_id).single();
  await admin.from("customers").update({ marketing_allowed: false, do_not_call: true, do_not_sms: true, do_not_email: true, lifecycle: "blocked", blocked_reason: reason }).eq("tenant_id", context.tenantId).eq("id", request.customer_id);
  await admin.from("compliance_blocks").insert({ tenant_id: context.tenantId, customer_id: request.customer_id, phone_e164: customer?.phone_e164, email: customer?.email, channels: ["call", "sms", "email"], reason, source: "data_subject_request", active: true, created_by: context.userId });
  await admin.from("data_subject_requests").update({ status: "completed", completed_at: new Date().toISOString(), handled_by: context.userId, processing_notes: reason }).eq("tenant_id", context.tenantId).eq("id", requestId);
  await admin.from("data_subject_request_events").insert({ tenant_id: context.tenantId, request_id: requestId, event_type: request.request_type === "objection" ? "objection_applied" : "restriction_applied", actor_user_id: context.userId, details: { reason } });
  revalidatePath("/app/compliance");
}

export async function createLegalHold(form: FormData) {
  const context = await adminContext();
  const customerId = value(form, "customer_id");
  const reason = value(form, "reason");
  if (!customerId || !reason) redirect("/app/compliance?error=Kund och skäl krävs för juridisk spärr");
  const admin = createAdminClient();
  const { error } = await admin.from("legal_holds").insert({ tenant_id: context.tenantId, customer_id: customerId, reason, scope: csvValues(value(form, "scope") || "all"), active: true, created_by: context.userId });
  if (error) redirect(`/app/compliance?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/app/compliance");
}

export async function releaseLegalHold(form: FormData) {
  const context = await adminContext();
  const id = value(form, "id");
  if (!id) return;
  const admin = createAdminClient();
  const { error } = await admin.from("legal_holds").update({ active: false, released_by: context.userId, released_at: new Date().toISOString() }).eq("tenant_id", context.tenantId).eq("id", id);
  if (error) redirect(`/app/compliance?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/app/compliance");
}
