"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getAppContext } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { assertPermission } from "@/lib/permissions";
import { zonedLocalDateTimeToIso } from "@/lib/domain/time";

// The set `complete_manual_call_work` accepts. Anything else is refused there as
// `manual_disposition_invalid`, so offering a wider list in the UI only produces
// a failure after the seller has typed their note.
const manualDispositions = new Set([
  "no_answer", "busy", "voicemail", "callback", "interested",
  "not_interested", "wrong_number", "do_not_call", "nix_listed",
]);

// The database speaks in codes. Translate the ones a seller can actually act on.
function afterCallMessage(error: { message?: string }) {
  const raw = String(error?.message ?? "");
  if (raw.includes("call_not_finished")) {
    return "Samtalet är inte avslutat ännu. Vänta tills telefonitjänsten rapporterat slutstatus, eller avsluta samtalet i dialern.";
  }
  if (raw.includes("manual_call_not_found")) return "Samtalet hör inte till dig, eller är ett listsamtal.";
  if (raw.includes("future_callback_required")) return "Återkomsten måste ligga i framtiden.";
  if (raw.includes("manual_disposition_invalid")) return "Välj ett giltigt samtalsresultat.";
  return errorMessage(error instanceof Error ? error : new Error(raw));
}

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

export async function setCallDisposition(form: FormData) {
  const ctx = await getAppContext();
  assertPermission(ctx.role, "calls.create");
  const callId = value(form, "call_id");
  const disposition = value(form, "disposition");
  const notes = value(form, "notes");
  const callbackScope = value(form, "callback_scope") || "personal";
  const callbackDueAt = value(form, "callback_due_at");
  if (!callId) redirect("/app/calls?error=Samtalet saknas");

  const supabase = await createClient();
  // A failed read here used to be indistinguishable from "the call does not
  // exist", and the code went on to update a row it had not found.
  const { data: call, error: callError } = await supabase.from("calls")
    .select("id,list_id").eq("id", callId).maybeSingle();
  if (callError) redirect("/app/calls?error=Samtalet kunde inte läsas. Försök igen.");
  if (!call) redirect("/app/calls?error=Samtalet finns inte");
  if (call.list_id) redirect(`/app/dialer/lists/${call.list_id}?error=Listans efterarbete måste slutföras i ringsessionen`);

  if (!manualDispositions.has(disposition)) {
    redirect("/app/calls?error=Välj ett giltigt samtalsresultat");
  }
  if (disposition === "callback" && !callbackDueAt) {
    redirect("/app/calls?error=Ange när återkomsten ska ske");
  }

  // The canonical after-call path, the same one the dialer uses. Writing the
  // disposition straight onto `calls` — which is what this action used to do —
  // skipped every consequence the disposition is supposed to have. Most
  // seriously, `do_not_call` and `nix_listed` never reached
  // `apply_call_block_disposition`, so a customer who asked not to be called
  // again was recorded as such on the call row and remained fully callable.
  // There is no trigger on `calls` that applies the block; the function is the
  // only path. It also brings the terminal-status guard, the customer's contact
  // counters, the note, the callback activity, the audit row, and idempotency.
  const { error } = await supabase.rpc("complete_manual_call_work_v2", {
    p_call_id: callId,
    p_disposition: disposition,
    p_notes: notes || null,
    p_callback_scope: disposition === "callback" ? callbackScope : null,
    p_callback_due_at: disposition === "callback"
      ? zonedLocalDateTimeToIso(callbackDueAt, ctx.tenantTimezone)
      : null,
  });
  if (error) redirect(`/app/calls?error=${encodeURIComponent(afterCallMessage(error))}`);
  revalidatePath("/app/calls");
  redirect("/app/calls?message=Efterarbetet är registrerat");
}
