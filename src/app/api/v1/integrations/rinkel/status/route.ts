import { NextResponse } from "next/server";
import { getAppContext } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET() {
  try {
    const context = await getAppContext();
    const admin = createAdminClient();
    const { data: integration, error: integrationError } = await admin.from("tenant_integrations")
      .select("id,status,webhook_status,last_verified_at,last_successful_sync_at,last_error_code,last_error_message")
      .eq("tenant_id", context.tenantId)
      .eq("provider_type", "telephony")
      .eq("provider", "rinkel")
      .is("disabled_at", null)
      .limit(1)
      .maybeSingle();

    if (integrationError) {
      console.error("rinkel_status_integration_query_failed", {
        tenantId: context.tenantId,
        code: integrationError.code,
      });
      return NextResponse.json({
        configured: null,
        ready: false,
        automaticReady: false,
        errorCode: "RINKEL_STATUS_QUERY_FAILED",
        errorMessage: "Rinkel-status kunde inte läsas. Kontrollera databasmigrationen och serverkonfigurationen.",
      }, { status: 500 });
    }

    if (!integration) {
      return NextResponse.json({ configured: false, ready: false, automaticReady: false, status: "not_configured" });
    }

    const [{ data: mapping, error: mappingError }, { data: capabilities, error: capabilitiesError }] = await Promise.all([
      admin.from("rinkel_user_mappings")
        .select("id,rinkel_users!inner(active,external_device_id),rinkel_numbers!inner(active)")
        .eq("tenant_id", context.tenantId)
        .eq("connection_id", integration.id)
        .eq("kundexa_user_id", context.userId)
        .eq("active", true)
        .maybeSingle(),
      admin.from("rinkel_capabilities")
        .select("api_access,dial,webhooks,recordings,transcription,ai_insights")
        .eq("tenant_id", context.tenantId)
        .eq("connection_id", integration.id)
        .maybeSingle(),
    ]);

    if (mappingError || capabilitiesError) {
      const queryError = mappingError ?? capabilitiesError;
      console.error("rinkel_status_dependency_query_failed", {
        tenantId: context.tenantId,
        connectionId: integration.id,
        code: queryError?.code,
      });
      return NextResponse.json({
        configured: true,
        ready: false,
        automaticReady: false,
        status: integration.status,
        errorCode: "RINKEL_STATUS_DEPENDENCY_QUERY_FAILED",
        errorMessage: "Rinkel-mappning eller capability-status kunde inte läsas.",
      }, { status: 500 });
    }

    const userValue = mapping?.rinkel_users as unknown as
      | { active?: boolean; external_device_id?: string | null }
      | { active?: boolean; external_device_id?: string | null }[]
      | null;
    const numberValue = mapping?.rinkel_numbers as unknown as { active?: boolean } | { active?: boolean }[] | null;
    const user = Array.isArray(userValue) ? userValue[0] : userValue;
    const number = Array.isArray(numberValue) ? numberValue[0] : numberValue;
    const mappingReady = Boolean(mapping && user?.active && user.external_device_id && number?.active);
    const apiReady = ["connected", "degraded", "active"].includes(integration.status) && Boolean(capabilities?.dial);
    const webhookReady = integration.webhook_status === "active" && Boolean(capabilities?.webhooks);

    return NextResponse.json({
      configured: true,
      ready: apiReady && mappingReady,
      automaticReady: apiReady && mappingReady && webhookReady,
      status: integration.status,
      webhookStatus: integration.webhook_status,
      mappingReady,
      capabilities,
      lastVerifiedAt: integration.last_verified_at,
      lastSyncAt: integration.last_successful_sync_at,
      errorCode: integration.last_error_code,
      errorMessage: integration.last_error_message,
    });
  } catch (error) {
    console.error("rinkel_status_failed", error);
    return NextResponse.json({
      configured: null,
      ready: false,
      automaticReady: false,
      errorCode: "RINKEL_STATUS_FAILED",
      errorMessage: "Rinkel-status kunde inte hämtas.",
    }, { status: 500 });
  }
}
