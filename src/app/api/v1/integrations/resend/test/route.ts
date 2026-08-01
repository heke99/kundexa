import { authenticateRequest } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptJson } from "@/lib/crypto";
import { serverEnv } from "@/lib/env";
import { apiJson, getCorrelationId, withCorrelation } from "@/lib/api-correlation";
import { readJsonObject, toJson, toJsonObject } from "@/lib/supabase/json";

type ResendCredentials = { apiKey?: string; from?: string };

export async function POST(request: Request) {
  const correlationId = getCorrelationId(request);
  try {
    const identity = await authenticateRequest(request, "integrations:test");
    const env = serverEnv();
    const admin = createAdminClient();
    const [{ data: integration }, { data: tenant }] = await Promise.all([
      admin.from("tenant_integrations").select("id,credentials_ciphertext,configuration")
        .eq("tenant_id", identity.tenantId).eq("provider_type", "email").eq("provider", "resend").limit(1).maybeSingle(),
      admin.from("tenants").select("name,legal_name").eq("id", identity.tenantId).single(),
    ]);
    if (!integration?.credentials_ciphertext) return apiJson(correlationId, { error: "resend_configuration_required" }, { status: 409 });
    const credentials = decryptJson<ResendCredentials>(integration.credentials_ciphertext, env.KUNDEXA_ENCRYPTION_KEY);
    const configuration = readJsonObject(integration.configuration);
    const accountMode = String(configuration.account_mode ?? "tenant_owned");
    const apiKey = accountMode === "platform_managed" ? env.RESEND_API_KEY : credentials.apiKey;
    const fromAddress = String(configuration.from_address ?? credentials.from ?? "");
    const fromName = String(configuration.from_name ?? tenant?.legal_name ?? tenant?.name ?? "Kundexa").replace(/[<>\r\n]/g, " ");
    const testRecipient = String(configuration.test_recipient ?? "");
    if (!apiKey || !/^\S+@\S+\.\S+$/.test(fromAddress) || !/^\S+@\S+\.\S+$/.test(testRecipient)) {
      return apiJson(correlationId, { error: "resend_api_key_from_or_test_recipient_missing" }, { status: 409 });
    }
    const requestKey = request.headers.get("idempotency-key")?.slice(0, 200)
      || `kundexa-resend-test/${integration.id}/${new Date().toISOString().slice(0, 13)}`;
    let response: Response | null = null;
    let result: Record<string, unknown> = {};
    let safeError: string | null = null;
    try {
      response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json", "Idempotency-Key": requestKey },
        body: JSON.stringify({
          from: `${fromName} <${fromAddress}>`, to: [testRecipient],
          subject: "Kundexa – test av Resend-anslutning",
          text: `Resend-anslutningen för ${tenant?.legal_name ?? tenant?.name ?? "tenant"} fungerar.`,
          html: `<p>Resend-anslutningen fungerar.</p>`, tags: [{ name: "category", value: "integration_test" }],
        }),
      });
      result = await response.json() as Record<string, unknown>;
      if (!response.ok) safeError = `Resend ${response.status}: ${String(result.message ?? result.name ?? "test_failed").slice(0, 300)}`;
    } catch (error) {
      safeError = error instanceof Error ? error.message.slice(0, 300) : "resend_network_error";
    }
    const testedAt = new Date().toISOString();
    const providerMessageId = typeof result.id === "string" ? result.id : null;
    const success = Boolean(response?.ok && providerMessageId);
    await admin.from("tenant_integrations").update({
      status: success ? "active" : "error",
      last_verified_at: success ? testedAt : null,
      configuration: toJsonObject({ ...configuration, last_test_status: success ? "success" : "error", last_tested_at: testedAt, last_error: success ? null : safeError, last_test_provider_message_id: success ? providerMessageId : null }),
    }).eq("tenant_id", identity.tenantId).eq("id", integration.id);
    await admin.from("audit_logs").insert({
      tenant_id: identity.tenantId, actor_user_id: identity.userId,
      action: success ? "integration.resend_test_succeeded" : "integration.resend_test_failed",
      entity_type: "tenant_integration", entity_id: integration.id, request_id: requestKey,
      after_data: toJson({ tested_at: testedAt, provider_message_id: success ? providerMessageId : null, error: safeError }),
    });
    if (!success) return apiJson(correlationId, { error: safeError ?? "resend_test_failed" }, { status: 409 });
    return apiJson(correlationId, { data: { status: "active", tested_at: testedAt, provider_message_id: providerMessageId } });
  } catch (error) {
    if (error instanceof Response) return withCorrelation(error, correlationId);
    return apiJson(correlationId, { error: error instanceof Error ? error.message : "internal_error" }, { status: 500 });
  }
}
