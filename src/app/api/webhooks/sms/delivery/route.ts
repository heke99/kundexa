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
  let update = admin.from("sms_messages").update({
    provider_message_id: report.providerMessageId,
    status: report.status,
    delivered_at: report.status === "delivered" ? new Date().toISOString() : null,
    error_message: report.errorMessage,
  }).eq("tenant_id", number.tenant_id);
  // Vår egen id är den säkra nyckeln. Leverantörens id används bara när vi
  // varken fick tillbaka vår referens eller har den i URL:en.
  const localId = messageId ?? report.clientReference;
  update = localId ? update.eq("id", localId) : update.eq("provider_message_id", report.providerMessageId);
  const { data: sms, error } = await update.select("id").maybeSingle();
  if (error) return NextResponse.json({ error: "sms_delivery_projection_failed" }, { status: 500 });
  if (sms) {
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
