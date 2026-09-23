import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { authenticateSmsNumber, smsWebhookAdapter, verifySmsCallbackNetwork } from "@/lib/messaging/provider";

export async function POST(request: Request) {
  const adapter = smsWebhookAdapter();
  if (!await verifySmsCallbackNetwork(request, adapter.id)) return new NextResponse(null, { status: 403 });
  const url = new URL(request.url);
  const token = url.searchParams.get("token") ?? "";
  const messageId = url.searchParams.get("message_id");
  const fromNumber = url.searchParams.get("from_number");
  // Callback-URL:en är utfärdad per avsändarnummer och token hör till just det
  // numret. Att låta nyttolasten peka ut numret hade låtit en läckt URL
  // rapportera leverans för en annan tenants meddelande.
  const number = fromNumber ? await authenticateSmsNumber(fromNumber, token) : null;
  if (!number) return new NextResponse(null, { status: 403 });

  const report = await adapter.parseDeliveryReport(request);
  if (!report) return new NextResponse(null, { status: 204 });

  const admin = createAdminClient();
  // Vår egen id är den säkra nyckeln. Leverantörens id används bara när vi
  // varken fick tillbaka vår referens eller har den i URL:en.
  const localId = messageId ?? report.clientReference;
  let lookup = admin.from("sms_messages").select("id").eq("tenant_id", number.tenant_id);
  lookup = localId ? lookup.eq("id", localId) : lookup.eq("provider_message_id", report.providerMessageId);
  const { data: sms, error } = await lookup.maybeSingle();
  if (error) return NextResponse.json({ error: "sms_delivery_projection_failed" }, { status: 500 });
  if (sms) {
    // Statusen skrivs i databasen, inte här: den får aldrig gå bakåt, och
    // avtalsutskicket och avtalet ska följa med i samma transaktion. Rutten
    // skrev tidigare bara SMS-raden och nollade `delivered_at` vid varje
    // rapport som inte var "levererat".
    const { error: projectionError } = await admin.rpc("apply_sms_delivery_event", {
      p_tenant_id: number.tenant_id,
      p_sms_message_id: sms.id,
      p_status: report.status,
      p_provider_message_id: report.providerMessageId,
      p_provider_status: report.providerStatus,
      p_failure_message: report.errorMessage ?? undefined,
    });
    if (projectionError) return NextResponse.json({ error: "sms_delivery_projection_failed" }, { status: 500 });
    await admin.from("sms_delivery_events").upsert({
      tenant_id: number.tenant_id,
      sms_message_id: sms.id,
      provider_event_id: `${report.providerMessageId}:${report.providerStatus}`,
      status: report.status,
      payload: report.payload,
    }, { onConflict: "tenant_id,provider_event_id", ignoreDuplicates: true });
  }
  return new NextResponse(null, { status: 204 });
}
