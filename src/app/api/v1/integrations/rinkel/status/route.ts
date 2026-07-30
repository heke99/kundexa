import { NextResponse } from "next/server";
import { getAppContext } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export async function GET() {
  const context = await getAppContext();
  const supabase = await createClient();
  const { data: integration } = await supabase.from("tenant_integrations")
    .select("id,status,webhook_status,last_verified_at,last_successful_sync_at,last_error_code,last_error_message")
    .eq("provider", "rinkel")
    .is("disabled_at", null)
    .limit(1)
    .maybeSingle();
  if (!integration) {
    return NextResponse.json({ configured: false, ready: false, status: "not_configured" });
  }
  const [{ data: mapping }, { data: capabilities }] = await Promise.all([
    supabase.from("rinkel_user_mappings")
      .select("id,rinkel_users!inner(active,external_device_id),rinkel_numbers!inner(active)")
      .eq("connection_id", integration.id)
      .eq("kundexa_user_id", context.userId)
      .eq("active", true)
      .maybeSingle(),
    supabase.from("rinkel_capabilities").select("api_access,dial,webhooks,recordings,transcription,ai_insights")
      .eq("connection_id", integration.id).maybeSingle(),
  ]);
  const userValue = mapping?.rinkel_users as unknown as { active?: boolean; external_device_id?: string | null } | { active?: boolean; external_device_id?: string | null }[] | null;
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
}
