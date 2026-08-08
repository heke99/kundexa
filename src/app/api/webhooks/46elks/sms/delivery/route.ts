import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { authenticate46ElksNumber, formToObject, verify46ElksNetwork } from "@/lib/webhooks/46elks";

export async function POST(request: Request) {
  if (!await verify46ElksNetwork(request)) return new NextResponse(null, { status: 403 });
  const url = new URL(request.url);
  const token = url.searchParams.get("token") ?? "";
  const messageId = url.searchParams.get("message_id");
  const payload = formToObject(await request.formData());
  const from = payload.from ?? payload.sender ?? url.searchParams.get("from_number") ?? undefined;
  const number = from ? await authenticate46ElksNumber(from, token) : null;
  if (!number) return new NextResponse(null, { status: 403 });

  const providerId = payload.id ?? payload.smsid;
  if (!providerId) return new NextResponse(null, { status: 204 });
  const status = (payload.status ?? "sent").toLowerCase();
  const mapped = status.includes("deliver") ? "delivered" : status.includes("fail") ? "failed" : status.includes("send") ? "sent" : "created";
  const admin = createAdminClient();
  let update = admin.from("sms_messages").update({
    provider_message_id: providerId,
    status: mapped,
    delivered_at: mapped === "delivered" ? new Date().toISOString() : null,
    error_message: mapped === "failed" ? (payload.error ?? payload.message) : null,
    cost: payload.cost ? Number(payload.cost) : undefined,
  }).eq("tenant_id", number.tenant_id);
  update = messageId ? update.eq("id", messageId) : update.eq("provider_message_id", providerId);
  const { data: sms, error } = await update.select("id").maybeSingle();
  if (error) return NextResponse.json({ error: "sms_delivery_projection_failed" }, { status: 500 });
  if (sms) {
    await admin.from("sms_delivery_events").upsert({
      tenant_id: number.tenant_id,
      sms_message_id: sms.id,
      provider_event_id: `${providerId}:${status}`,
      status: mapped,
      payload,
    }, { onConflict: "tenant_id,provider_event_id", ignoreDuplicates: true });
  }
  return new NextResponse(null, { status: 204 });
}
