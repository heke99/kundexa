"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getAppContext } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { randomToken, sha256 } from "@/lib/crypto";
import { serverEnv } from "@/lib/env";
import { assertPermission } from "@/lib/permissions";

const value = (form: FormData, key: string) => String(form.get(key) ?? "").trim();
const requestKey = (form: FormData, prefix: string) => value(form, "idempotency_key") || `${prefix}:${crypto.randomUUID()}`;

function errorMessage(error: unknown) {
  if (!(error instanceof Error)) return "Åtgärden kunde inte genomföras";
  return error.message
    .replace("contact_not_allowed:", "Kontakt stoppades: ")
    .replace("usage_hard_limit_exceeded:", "Användningsgränsen är nådd för ")
    .replaceAll("_", " ");
}

export async function queueSms(form: FormData) {
  const ctx = await getAppContext();
  assertPermission(ctx.role, "messages.send");
  const customerId = value(form, "customer_id");
  const body = value(form, "body");
  if (!customerId || !body) redirect("/app/sms?error=Kund och meddelande krävs");
  const supabase = await createClient();
  const { error } = await supabase.rpc("queue_sms_message", {
    p_customer_id: customerId,
    p_body: body,
    p_idempotency_key: requestKey(form, "ui.sms"),
    p_purpose: "direct_marketing",
  });
  if (error) redirect(`/app/sms?error=${encodeURIComponent(errorMessage(error))}`);
  revalidatePath("/app/sms");
  redirect("/app/sms");
}

export async function queueEmail(form: FormData) {
  const ctx = await getAppContext();
  assertPermission(ctx.role, "messages.send");
  const customerId = value(form, "customer_id");
  const subject = value(form, "subject");
  const body = value(form, "body");
  if (!customerId || !subject || !body) redirect("/app/email?error=Kund, ämne och meddelande krävs");
  const supabase = await createClient();
  const { error } = await supabase.rpc("queue_email_message", {
    p_customer_id: customerId,
    p_subject: subject,
    p_body: body,
    p_idempotency_key: requestKey(form, "ui.email"),
    p_purpose: "direct_marketing",
  });
  if (error) redirect(`/app/email?error=${encodeURIComponent(errorMessage(error))}`);
  revalidatePath("/app/email");
  redirect("/app/email");
}

export async function startCall(form: FormData) {
  const ctx = await getAppContext();
  assertPermission(ctx.role, "calls.create");
  const customerId = value(form, "customer_id");
  if (!customerId) redirect("/app/dialer?error=Välj en kund");
  const supabase = await createClient();
  const { data: voiceClient } = await supabase.from("voice_clients")
    .select("client_number_e164")
    .eq("assigned_user_id", ctx.userId)
    .eq("status", "active")
    .maybeSingle();
  if (!voiceClient?.client_number_e164) redirect("/app/dialer?error=Din användare saknar en aktiv WebRTC-klient");

  const token = randomToken();
  const env = serverEnv();
  const { data: callId, error } = await supabase.rpc("queue_outbound_call", {
    p_customer_id: customerId,
    p_callback_token_hash: sha256(token + env.KUNDEXA_WEBHOOK_PEPPER),
    p_callback_token: token,
    p_voice_client_number: voiceClient.client_number_e164,
    p_idempotency_key: requestKey(form, "ui.call"),
    p_purpose: "direct_marketing",
  });
  if (error || !callId) redirect(`/app/dialer?error=${encodeURIComponent(errorMessage(error ?? new Error("Samtalet kunde inte köas")))}`);
  revalidatePath("/app/dialer");
  redirect(`/app/calls?started=${callId}`);
}

export async function setCallDisposition(form: FormData) {
  const ctx = await getAppContext();
  assertPermission(ctx.role, "calls.create");
  const callId = value(form, "call_id");
  const disposition = value(form, "disposition");
  const notes = value(form, "notes");
  const supabase = await createClient();
  const { data: call } = await supabase.from("calls").select("customer_id,list_id,callback_activity_id").eq("id", callId).single();
  if (call?.list_id) redirect(`/app/dialer/lists/${call.list_id}?error=Listans efterarbete måste slutföras i ringsessionen`);
  const { error } = await supabase.from("calls").update({ disposition, notes, status: "completed", ended_at: new Date().toISOString() }).eq("id", callId);
  if (error) throw error;
  if (call?.callback_activity_id) await supabase.from("activities").update({ status: "completed", completed_at: new Date().toISOString(), handled_at: new Date().toISOString(), claimed_by: null, claim_expires_at: null }).eq("id", call.callback_activity_id);
  if (call?.customer_id) {
    const next = disposition === "callback" ? new Date(Date.now() + 86_400_000).toISOString() : null;
    await supabase.from("customers").update({ last_contact_at: new Date().toISOString(), next_activity_at: next }).eq("id", call.customer_id);
    if (notes) await supabase.from("notes").insert({ tenant_id: ctx.tenantId, customer_id: call.customer_id, body: notes, note_type: "call", call_id: callId, created_by: ctx.userId });
    if (next) await supabase.from("activities").insert({ tenant_id: ctx.tenantId, customer_id: call.customer_id, type: "callback", title: "Återuppringning", due_at: next, assigned_user_id: ctx.userId, callback_scope: "personal", created_by: ctx.userId });
  }
  revalidatePath("/app/calls");
}
