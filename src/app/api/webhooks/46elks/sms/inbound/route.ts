import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { authenticate46ElksNumber, formToObject, verify46ElksNetwork } from "@/lib/webhooks/46elks";
import { decideAcceptance, normalizeAcceptanceText } from "@/lib/domain/acceptance";

export async function POST(request: Request) {
  if (!await verify46ElksNetwork(request)) return new NextResponse(null, { status: 403 });
  try {
    const token = new URL(request.url).searchParams.get("token") ?? "";
    const payload = formToObject(await request.formData());
    const to = payload.to;
    const from = payload.from;
    const message = payload.message ?? "";
    const number = to ? await authenticate46ElksNumber(to, token) : null;
    if (!number || !from) return new NextResponse(null, { status: 403 });

    const admin = createAdminClient();
    const providerId = payload.id ?? null;
    const { data: event } = await admin.from("provider_webhook_events").upsert({
      tenant_id: number.tenant_id,
      provider: "46elks",
      event_type: "sms.inbound",
      provider_event_id: providerId,
      route_key: to,
      payload,
      status: "received",
    }, { onConflict: "provider,provider_event_id", ignoreDuplicates: true }).select("id").maybeSingle();
    if (providerId && !event) return new NextResponse(null, { status: 204 });

    const { data: customer } = await admin.from("customers")
      .select("id")
      .eq("tenant_id", number.tenant_id)
      .eq("phone_e164", from)
      .is("deleted_at", null)
      .limit(1)
      .maybeSingle();

    const { data: conversation, error: conversationError } = await admin.from("sms_conversations").upsert({
      tenant_id: number.tenant_id,
      customer_id: customer?.id ?? null,
      phone_number_id: number.id,
      external_number: from,
      status: "open",
      last_message_at: new Date().toISOString(),
      assigned_user_id: number.assigned_user_id,
      assigned_team_id: number.assigned_team_id,
    }, { onConflict: "tenant_id,phone_number_id,external_number" }).select("id").single();
    if (conversationError) throw conversationError;

    const { data: sms, error: smsError } = await admin.from("sms_messages").upsert({
      tenant_id: number.tenant_id,
      conversation_id: conversation.id,
      customer_id: customer?.id ?? null,
      provider_message_id: providerId,
      direction: "inbound",
      from_number: from,
      to_number: to,
      body: message,
      status: "delivered",
      delivered_at: payload.created ?? new Date().toISOString(),
    }, { onConflict: "tenant_id,provider_message_id" }).select("id").single();
    if (smsError) throw smsError;

    const { data: recipients } = await admin.from("contract_recipients")
      .select("id")
      .eq("tenant_id", number.tenant_id)
      .eq("phone_e164", from);

    if (recipients?.length) {
      const { data: acceptanceRequests } = await admin.from("contract_acceptance_requests")
        .select("id,tenant_id,contract_id,contract_version_id,recipient_id,acceptance_code,allowed_phrases,decline_phrases,require_code,call_ended_at,contracts(audience)")
        .eq("tenant_id", number.tenant_id)
        .in("recipient_id", recipients.map((recipient) => recipient.id))
        .eq("status", "pending")
        .gt("expires_at", new Date().toISOString())
        .order("created_at", { ascending: false });

      let matched = false;
      for (const acceptanceRequest of acceptanceRequests ?? []) {
        const decision = decideAcceptance(
          message,
          acceptanceRequest.acceptance_code ?? "",
          !acceptanceRequest.require_code && (acceptanceRequests?.length ?? 0) === 1,
          acceptanceRequest.allowed_phrases ?? undefined,
          acceptanceRequest.decline_phrases ?? undefined,
        );
        if (decision === "manual_review") continue;

        const contractRaw = acceptanceRequest.contracts as unknown as { audience?: string } | { audience?: string }[] | null;
        const contract = Array.isArray(contractRaw) ? contractRaw[0] : contractRaw;
        let status: "accepted_via_sms" | "declined" | "manual_review_required" = decision === "accepted" ? "accepted_via_sms" : "declined";
        if (decision === "accepted" && contract?.audience === "B2C" && !acceptanceRequest.call_ended_at) {
          status = "manual_review_required";
        }

        const normalized = normalizeAcceptanceText(message);
        const { error } = await admin.rpc("record_contract_acceptance", {
          p_request_id: acceptanceRequest.id,
          p_method: "sms",
          p_status: status,
          p_raw_response: message,
          p_normalized_response: normalized,
          p_acceptance_phrase: normalized.split(" ")[0] ?? null,
          p_acceptance_code: acceptanceRequest.acceptance_code,
          p_ip_address: null,
          p_user_agent: null,
          p_provider_message_id: providerId,
          p_evidence: {
            incoming_sms_id: sms.id,
            provider_payload: payload,
            call_ended_at: acceptanceRequest.call_ended_at,
          },
        });
        if (error) throw error;
        matched = true;
        break;
      }

      // Preserve an ambiguous reply for human review only when there is one
      // unambiguous pending request to attach it to.
      if (!matched && acceptanceRequests?.length === 1) {
        const acceptanceRequest = acceptanceRequests[0];
        const normalized = normalizeAcceptanceText(message);
        const { error } = await admin.rpc("record_contract_acceptance", {
          p_request_id: acceptanceRequest.id,
          p_method: "sms",
          p_status: "manual_review_required",
          p_raw_response: message,
          p_normalized_response: normalized,
          p_acceptance_phrase: null,
          p_acceptance_code: acceptanceRequest.acceptance_code,
          p_ip_address: null,
          p_user_agent: null,
          p_provider_message_id: providerId,
          p_evidence: { incoming_sms_id: sms.id, provider_payload: payload },
        });
        if (error) throw error;
      }
    }

    if (event) {
      await admin.from("provider_webhook_events").update({ status: "processed", processed_at: new Date().toISOString() }).eq("id", event.id);
    }
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "webhook_processing_failed" }, { status: 500 });
  }
}
