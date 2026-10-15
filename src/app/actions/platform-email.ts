"use server";
import { z } from "zod";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getAppContext, isPlatformAdmin } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { canonicalAppBaseUrl, serverEnv } from "@/lib/env";
import { decryptJson, encryptJson, randomToken, sha256 } from "@/lib/crypto";
import { readJsonObject, toJsonObject } from "@/lib/supabase/json";
import { resendWebhookAdmin } from "@/lib/email/resend-webhook-admin";

/** Explicit authenticated integration-operator action. No public endpoint, caller-supplied URL,
 * API key or signing secret. Provider secrets remain inside server execution. */
export async function registerPlatformResendWebhook(form: FormData) {
  const context = await getAppContext();
  const input = z.object({ tenantId: z.uuid(), integrationId: z.uuid(), requestId: z.uuid() }).parse({ tenantId: form.get("tenant_id"), integrationId: form.get("integration_id"), requestId: form.get("request_id") });
  if (!isPlatformAdmin(context.platformRole) && (context.tenantId !== input.tenantId || !["owner", "admin"].includes(context.role))) throw new Error("integration_operator_required");
  const env = serverEnv();
  if (!env.RESEND_API_KEY || !env.DEFAULT_EMAIL_FROM_ADDRESS) throw new Error("platform_email_not_configured");
  const provider = resendWebhookAdmin(env.RESEND_API_KEY);
  const domain = env.DEFAULT_EMAIL_FROM_ADDRESS.split("@")[1].toLowerCase();
  if (!await provider.inspectDomain(domain)) throw new Error("sending_domain_not_verified_in_runtime_account");
  const admin = createAdminClient();
  const { data: integration, error: readError } = await admin.from("tenant_integrations").select("id,credentials_ciphertext,configuration,webhook_status,tenants!inner(status)")
    .eq("tenant_id", input.tenantId).eq("id", input.integrationId).eq("provider_type", "email").eq("provider", "resend").eq("status", "active").in("tenants.status", ["active", "trial"]).single();
  if (readError || !integration) throw new Error("active_email_integration_required");
  const credentials = integration.credentials_ciphertext ? decryptJson<Record<string, unknown>>(integration.credentials_ciphertext, env.KUNDEXA_ENCRYPTION_KEY) : {};
  const config = readJsonObject(integration.configuration);
  const previous = config.webhook_registration as { request_id?: string; configuration_digest?: string; state?: string } | undefined;
  const digest = sha256(JSON.stringify([env.RESEND_API_KEY, env.DEFAULT_EMAIL_FROM_ADDRESS]));
  if (previous && (previous.request_id !== input.requestId || previous.configuration_digest !== digest)) throw new Error("webhook_registration_intent_conflict");
  const token = typeof credentials.webhookPathToken === "string" && credentials.webhookPathToken ? credentials.webhookPathToken : randomToken(32);
  const endpoint = `${canonicalAppBaseUrl()}/api/webhooks/resend/${token}`;
  const reservedCredentials = { ...credentials, webhookPathToken: token };
  let ciphertext = integration.credentials_ciphertext;
  if (!previous) {
    ciphertext = encryptJson(reservedCredentials, env.KUNDEXA_ENCRYPTION_KEY);
    let reserve = admin.from("tenant_integrations").update({ credentials_ciphertext: ciphertext, configuration: toJsonObject({ ...config, webhook_path_token_hash: sha256(token + env.KUNDEXA_WEBHOOK_PEPPER), webhook_registration: { request_id: input.requestId, configuration_digest: digest, state: "creating" } }) }).eq("tenant_id", input.tenantId).eq("id", integration.id);
    reserve = integration.credentials_ciphertext ? reserve.eq("credentials_ciphertext", integration.credentials_ciphertext) : reserve.is("credentials_ciphertext", null);
    const { data: claimed, error } = await reserve.select("id").maybeSingle();
    if (error || !claimed) throw new Error("webhook_registration_claim_conflict");
  }
  const { error: auditError } = await admin.from("audit_logs").insert({ tenant_id: input.tenantId, actor_user_id: context.userId, action: "integration.resend_webhook_registration_requested", entity_type: "tenant_integration", entity_id: integration.id, request_id: input.requestId, after_data: { initial: !previous, domain } });
  if (auditError) throw new Error("webhook_registration_audit_failed");
  const registered = await provider.ensureWebhook(endpoint, !previous);
  const { error: commitError, data: committed } = await admin.from("tenant_integrations").update({
    credentials_ciphertext: encryptJson({ ...reservedCredentials, webhookSigningSecret: registered.signingSecret }, env.KUNDEXA_ENCRYPTION_KEY),
    configuration: toJsonObject({ ...config, webhook_path_token_hash: sha256(token + env.KUNDEXA_WEBHOOK_PEPPER), webhook_registration: { request_id: input.requestId, configuration_digest: digest, state: "registered", provider_webhook_id: registered.id } }),
    webhook_status: credentials.webhookSigningSecret === registered.signingSecret && integration.webhook_status === "active" ? "active" : "pending",
  }).eq("tenant_id", input.tenantId).eq("id", integration.id).eq("credentials_ciphertext", ciphertext!).select("id").maybeSingle();
  if (commitError || !committed) throw new Error("webhook_registration_store_failed_reconcile_same_request");
  const { error: finishedAudit } = await admin.from("audit_logs").insert({ tenant_id: input.tenantId, actor_user_id: context.userId, action: "integration.resend_webhook_registered", entity_type: "tenant_integration", entity_id: integration.id, request_id: input.requestId, after_data: { provider_webhook_id: registered.id, domain, webhook_status: "pending" } });
  if (finishedAudit) throw new Error("webhook_registration_completion_audit_failed");
  return { integrationId: integration.id, webhookId: registered.id, domain, status: "pending" };
}


export async function registerPlatformResendWebhookForm(form: FormData) {
  let failed = false;
  try { await registerPlatformResendWebhook(form); } catch { failed = true; }
  revalidatePath("/app/integrations");
  redirect(`/app/integrations?${failed ? "error=Webhookregistreringen kunde inte bekräftas. Försök igen med samma registrering. Kontrollera kontots API-behörighet och verifierade domän." : "message=Webhooken är registrerad i samma Resend-konto som serverns nyckel. Leveransmottagningen bekräftas när en signerad händelse har kommit fram."}`);
}
