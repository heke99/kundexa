"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getAppContext } from "@/lib/auth";
import { assertPermission } from "@/lib/permissions";
import { zonedLocalDateTimeToIso } from "@/lib/domain/time";
import { createClient } from "@/lib/supabase/server";

const value = (form: FormData, key: string) => String(form.get(key) ?? "").trim();
const clean = (message: string) => encodeURIComponent(message.replaceAll("_", " "));

export async function claimCallback(form: FormData) {
  const context = await getAppContext();
  assertPermission(context.role, "callbacks.create");
  const callbackId = z.uuid().parse(value(form, "callback_id"));
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("claim_customer_callback", { p_activity_id: callbackId });
  if (error) redirect(`/app/callbacks?error=${clean(error.message)}`);
  const result = data as { customerId?: string; listId?: string | null };
  if (result.listId) redirect(`/app/dialer/lists/${result.listId}`);
  if (!result.customerId) redirect("/app/callbacks?error=Återkomsten saknar kund");
  revalidatePath("/app/callbacks");
  redirect(`/app/dialer?customer=${result.customerId}&callback=${callbackId}`);
}

export async function snoozeCallback(form: FormData) {
  const context = await getAppContext();
  assertPermission(context.role, "callbacks.create");
  const callbackId = z.uuid().parse(value(form, "callback_id"));
  let snoozedUntil: string;
  try { snoozedUntil = zonedLocalDateTimeToIso(value(form, "snoozed_until"), context.tenantTimezone); }
  catch { redirect("/app/callbacks?error=Ogiltig snoozetid"); }
  const supabase = await createClient();
  const { error } = await supabase.rpc("snooze_customer_callback", { p_activity_id: callbackId, p_snoozed_until: snoozedUntil });
  if (error) redirect(`/app/callbacks?error=${clean(error.message)}`);
  revalidatePath("/app/callbacks");
  revalidatePath("/app/dialer");
  redirect("/app/callbacks?saved=1");
}

export async function completeCallback(form: FormData) {
  const context = await getAppContext();
  assertPermission(context.role, "callbacks.create");
  const callbackId = z.uuid().parse(value(form, "callback_id"));
  const supabase = await createClient();
  const { error } = await supabase.rpc("complete_customer_callback", { p_activity_id: callbackId, p_notes: value(form, "notes") || null });
  if (error) redirect(`/app/callbacks?error=${clean(error.message)}`);
  revalidatePath("/app/callbacks");
  revalidatePath("/app/dialer");
  redirect("/app/callbacks?saved=1");
}

export async function reassignCallback(form: FormData) {
  const context = await getAppContext();
  assertPermission(context.role, "lists.manage");
  const parsed = z.object({ callbackId: z.uuid(), userId: z.uuid() }).safeParse({
    callbackId: value(form, "callback_id"), userId: value(form, "user_id"),
  });
  if (!parsed.success) redirect("/app/callbacks?error=Välj en giltig säljare");
  const supabase = await createClient();
  const { error } = await supabase.rpc("reassign_customer_callback", { p_activity_id: parsed.data.callbackId, p_user_id: parsed.data.userId });
  if (error) redirect(`/app/callbacks?error=${clean(error.message)}`);
  revalidatePath("/app/callbacks");
  redirect("/app/callbacks?saved=1");
}
