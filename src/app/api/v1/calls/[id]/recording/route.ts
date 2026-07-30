import { NextResponse } from "next/server";
import { getAppContext } from "@/lib/auth";
import { assertPermission } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptJson } from "@/lib/crypto";
import { serverEnv } from "@/lib/env";
import { RinkelClient } from "@/lib/integrations/rinkel/client";
import { safeRinkelError } from "@/lib/integrations/rinkel/errors";

type Credentials = { apiKey: string };

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const app = await getAppContext();
  const { id: callId } = await context.params;
  const admin = createAdminClient();
  try {
    assertPermission(app.role, "recordings.read");
    const supabase = await createClient();
    const [{ data: call }, { data: policy }] = await Promise.all([
      supabase.from("calls").select("id,user_id,team_id,provider_connection_id").eq("id", callId).single(),
      supabase.from("telephony_policies").select("*").maybeSingle(),
    ]);
    if (!call || !policy) throw new Error("recording_not_found");
    const isAdmin = app.role === "owner" || app.role === "admin";
    const isTeamLead = app.role === "team_lead" && Boolean(call.team_id && app.teamIds.includes(call.team_id));
    const isSeller = call.user_id === app.userId;
    const allowed = (isAdmin && policy.allow_tenant_admin_playback)
      || (isTeamLead && policy.allow_team_leader_playback)
      || (isSeller && policy.allow_seller_playback)
      || app.role === "quality";
    if (!allowed) throw new Error("recording_permission_denied");

    const { data: recording } = await supabase.from("call_recordings").select("*")
      .eq("call_id", callId).is("deleted_at", null).maybeSingle();
    if (!recording) throw new Error("recording_not_found");
    let target: string;
    if (recording.status === "stored_privately" && recording.storage_path) {
      const { data, error } = await admin.storage.from("call-recordings").createSignedUrl(recording.storage_path, 60);
      if (error || !data?.signedUrl) throw new Error("recording_signed_url_failed");
      target = data.signedUrl;
    } else {
      if (!recording.provider_recording_id || !call.provider_connection_id) throw new Error("recording_provider_reference_missing");
      const env = serverEnv();
      const { data: connection } = await admin.from("tenant_integrations").select("credentials_ciphertext")
        .eq("tenant_id", app.tenantId).eq("id", call.provider_connection_id).eq("provider", "rinkel").single();
      if (!connection?.credentials_ciphertext) throw new Error("rinkel_connection_missing");
      const credentials = decryptJson<Credentials>(connection.credentials_ciphertext, env.KUNDEXA_ENCRYPTION_KEY);
      target = await new RinkelClient({
        apiKey: credentials.apiKey,
        baseUrl: env.RINKEL_API_BASE_URL,
        timeoutMs: env.RINKEL_REQUEST_TIMEOUT_MS,
      }).getRecordingUrl(recording.provider_recording_id);
    }
    await admin.from("recording_access_logs").insert({
      tenant_id: app.tenantId,
      recording_id: recording.id,
      user_id: app.userId,
      reason: "playback_allowed",
      ip_address: request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim()
        ?? request.headers.get("x-real-ip")
        ?? null,
    });
    return NextResponse.redirect(target, 307);
  } catch (error) {
    await admin.from("audit_logs").insert({
      tenant_id: app.tenantId,
      actor_user_id: app.userId,
      action: "recording.access_denied",
      entity_type: "call",
      entity_id: callId,
      after_data: { reason: error instanceof Error ? error.message.slice(0, 100) : "unknown" },
    });
    const safe = safeRinkelError(error);
    const message = error instanceof Error && error.message.startsWith("recording_")
      ? error.message
      : safe.message;
    const status = /permission|denied/.test(message) ? 403 : /not_found|missing/.test(message) ? 404 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
