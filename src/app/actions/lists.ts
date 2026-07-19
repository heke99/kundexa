"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getAppContext } from "@/lib/auth";
import { assertPermission } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";
import { zonedLocalDateTimeToIso } from "@/lib/domain/time";

const value = (form: FormData, key: string) => String(form.get(key) ?? "").trim();
const checked = (form: FormData, key: string) => form.get(key) === "on";

function message(error: { message: string } | null) {
  return encodeURIComponent((error?.message ?? "Åtgärden misslyckades").replaceAll("_", " "));
}

export async function createCustomerList(form: FormData) {
  const context = await getAppContext();
  assertPermission(context.role, "lists.manage");
  const parsed = z.object({
    name: z.string().min(2).max(120),
    description: z.string().max(1000),
    listType: z.enum(["static", "dynamic", "campaign", "personal", "callback", "renewal", "import", "upsell", "missed_calls"]),
    teamId: z.union([z.uuid(), z.literal("")]),
    dialingMode: z.enum(["manual", "automatic"]),
    priority: z.coerce.number().int().min(0).max(10000),
    startTime: z.string().regex(/^\d{2}:\d{2}$/),
    endTime: z.string().regex(/^\d{2}:\d{2}$/),
    maxAttempts: z.coerce.number().int().min(1).max(100),
    retryMinutes: z.coerce.number().int().min(1).max(525600),
    autoDelay: z.coerce.number().int().min(0).max(300),
    callbackPolicy: z.enum(["personal", "global", "both"]),
    script: z.string().max(10000),
  }).safeParse({
    name: value(form, "name"), description: value(form, "description"), listType: value(form, "list_type"),
    teamId: value(form, "team_id"), dialingMode: value(form, "dialing_mode"), priority: value(form, "priority") || "100",
    startTime: value(form, "start_time") || "09:00", endTime: value(form, "end_time") || "18:00",
    maxAttempts: value(form, "max_attempts") || "7", retryMinutes: value(form, "retry_delay_minutes") || "1440",
    autoDelay: value(form, "auto_next_delay_seconds") || "4", callbackPolicy: value(form, "callback_policy") || "both",
    script: value(form, "script"),
  });
  if (!parsed.success) redirect("/app/lists?error=Kontrollera listinställningarna");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_managed_customer_list", {
    p_name: parsed.data.name,
    p_description: parsed.data.description,
    p_list_type: parsed.data.listType,
    p_team_id: parsed.data.teamId || null,
    p_dialing_mode: parsed.data.dialingMode,
    p_priority: parsed.data.priority,
    p_start_time: parsed.data.startTime,
    p_end_time: parsed.data.endTime,
    p_max_attempts: parsed.data.maxAttempts,
    p_retry_delay_minutes: parsed.data.retryMinutes,
    p_auto_next_delay_seconds: parsed.data.autoDelay,
    p_callback_policy: parsed.data.callbackPolicy,
    p_allow_skip: checked(form, "allow_skip"),
    p_allow_browse: checked(form, "allow_browse"),
    p_script: parsed.data.script,
  });
  if (error || !data) redirect(`/app/lists?error=${message(error)}`);
  revalidatePath("/app/lists");
  redirect(`/app/lists/${data}`);
}

export async function updateCustomerList(form: FormData) {
  const context = await getAppContext();
  assertPermission(context.role, "lists.manage");
  const listId = value(form, "list_id");
  const timezone = value(form, "timezone") || context.tenantTimezone;
  const allowedDays = form.getAll("allowed_days").map(Number).filter((day) => Number.isInteger(day) && day >= 1 && day <= 7);
  if (!allowedDays.length) redirect(`/app/lists/${listId}?error=Välj minst en tillåten ringdag`);
  try { new Intl.DateTimeFormat("sv-SE", { timeZone: timezone }).format(new Date()); } catch { redirect(`/app/lists/${listId}?error=Ogiltig tidszon`); }
  let startsAt: string | null = null;
  let endsAt: string | null = null;
  try {
    startsAt = value(form, "starts_at") ? zonedLocalDateTimeToIso(value(form, "starts_at"), timezone) : null;
    endsAt = value(form, "ends_at") ? zonedLocalDateTimeToIso(value(form, "ends_at"), timezone) : null;
  } catch { redirect(`/app/lists/${listId}?error=Ogiltigt start- eller slutdatum för listans tidszon`); }
  const supabase = await createClient();
  const { error } = await supabase.rpc("update_customer_list_configuration", {
    p_list_id: listId,
    p_name: value(form, "name"),
    p_description: value(form, "description"),
    p_status: value(form, "status"),
    p_dialing_mode: value(form, "dialing_mode"),
    p_priority: Number(value(form, "priority") || 100),
    p_start_time: value(form, "start_time") || "09:00",
    p_end_time: value(form, "end_time") || "18:00",
    p_max_attempts: Number(value(form, "max_attempts") || 7),
    p_retry_delay_minutes: Number(value(form, "retry_delay_minutes") || 1440),
    p_auto_next_delay_seconds: Number(value(form, "auto_next_delay_seconds") || 4),
    p_callback_policy: value(form, "callback_policy") || "both",
    p_allow_skip: checked(form, "allow_skip"),
    p_allow_browse: checked(form, "allow_browse"),
    p_lock_to_seller: checked(form, "lock_to_seller"),
    p_script: value(form, "script"),
    p_timezone: timezone,
    p_allowed_days: allowedDays,
    p_outbound_phone_number_id: value(form, "outbound_phone_number_id") || null,
    p_recording_enabled: checked(form, "recording_enabled"),
    p_starts_at: startsAt,
    p_ends_at: endsAt,
  });
  if (error) redirect(`/app/lists/${listId}?error=${message(error)}`);
  revalidatePath(`/app/lists/${listId}`);
  revalidatePath("/app/lists");
  redirect(`/app/lists/${listId}?saved=1`);
}

export async function setCustomerListSellers(form: FormData) {
  const context = await getAppContext();
  assertPermission(context.role, "lists.manage");
  const listId = value(form, "list_id");
  const sellerIds = form.getAll("seller_ids").map(String).filter(Boolean);
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_customer_list_sellers", { p_list_id: listId, p_user_ids: sellerIds });
  if (error) redirect(`/app/lists/${listId}?error=${message(error)}`);
  revalidatePath(`/app/lists/${listId}`);
  revalidatePath("/app/dialer");
  redirect(`/app/lists/${listId}?saved=1`);
}

export async function updateCustomerListSellerAssignment(form: FormData) {
  const context = await getAppContext();
  assertPermission(context.role, "lists.manage");
  const parsed = z.object({
    listId: z.uuid(), userId: z.uuid(), status: z.enum(["active", "paused", "ended"]),
    weight: z.coerce.number().int().min(1).max(10000), capacity: z.union([z.coerce.number().int().min(1).max(10000), z.literal("")]),
  }).safeParse({
    listId: value(form, "list_id"), userId: value(form, "user_id"), status: value(form, "status"),
    weight: value(form, "weight") || "100", capacity: value(form, "daily_capacity"),
  });
  if (!parsed.success) redirect(`/app/lists/${value(form, "list_id")}?error=Kontrollera säljarens tilldelning`);
  const timezone = value(form, "timezone") || context.tenantTimezone;
  let startsAt: string | null = null; let endsAt: string | null = null;
  try {
    startsAt = value(form, "starts_at") ? zonedLocalDateTimeToIso(value(form, "starts_at"), timezone) : null;
    endsAt = value(form, "ends_at") ? zonedLocalDateTimeToIso(value(form, "ends_at"), timezone) : null;
  } catch { redirect(`/app/lists/${parsed.data.listId}?error=Ogiltigt start- eller slutdatum för säljaren`); }
  const supabase = await createClient();
  const { error } = await supabase.from("customer_list_seller_assignments").update({
    status: parsed.data.status, weight: parsed.data.weight, daily_capacity: parsed.data.capacity === "" ? null : parsed.data.capacity,
    starts_at: startsAt, ends_at: endsAt,
  }).eq("list_id", parsed.data.listId).eq("user_id", parsed.data.userId);
  if (error) redirect(`/app/lists/${parsed.data.listId}?error=${message(error)}`);
  revalidatePath(`/app/lists/${parsed.data.listId}`); revalidatePath("/app/dialer");
  redirect(`/app/lists/${parsed.data.listId}?saved=1`);
}

export async function addCustomersToList(form: FormData) {
  const context = await getAppContext();
  assertPermission(context.role, "lists.manage");
  const listId = value(form, "list_id");
  const customerIds = form.getAll("customer_ids").map(String).filter(Boolean);
  if (!customerIds.length) redirect(`/app/lists/${listId}?error=Välj minst ett prospekt`);
  const supabase = await createClient();
  const { error } = await supabase.rpc("add_customers_to_list", { p_list_id: listId, p_customer_ids: customerIds });
  if (error) redirect(`/app/lists/${listId}?error=${message(error)}`);
  revalidatePath(`/app/lists/${listId}`);
  revalidatePath("/app/dialer");
  redirect(`/app/lists/${listId}?saved=1`);
}

export async function materializeSegmentToList(form: FormData) {
  const context = await getAppContext();
  assertPermission(context.role, "lists.manage");
  const parsed = z.object({ listId: z.uuid(), segmentId: z.uuid() }).safeParse({
    listId: value(form, "list_id"),
    segmentId: value(form, "segment_id"),
  });
  if (!parsed.success) redirect(`/app/lists/${value(form, "list_id")}?error=Välj ett giltigt prospekteringssegment`);
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("materialize_segment_to_customer_list", {
    p_list_id: parsed.data.listId,
    p_segment_id: parsed.data.segmentId,
  });
  if (error) redirect(`/app/lists/${parsed.data.listId}?error=${message(error)}`);
  const result = (data ?? {}) as {
    addedToList?: number; createdCustomers?: number; pendingNix?: number; blocked?: number; removedFromDynamicList?: number;
  };
  const summary = encodeURIComponent(
    `${result.addedToList ?? 0} tillagda · ${result.createdCustomers ?? 0} nya kundkort · ${result.pendingNix ?? 0} inväntar NIX · ${result.blocked ?? 0} blockerade · ${result.removedFromDynamicList ?? 0} borttagna vid dynamisk synk`,
  );
  revalidatePath(`/app/lists/${parsed.data.listId}`);
  revalidatePath("/app/dialer");
  redirect(`/app/lists/${parsed.data.listId}?imported=${summary}`);
}

export async function upsertListDisposition(form: FormData) {
  const context = await getAppContext();
  assertPermission(context.role, "lists.manage");
  const listId = value(form, "list_id");
  const key = value(form, "key").toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  const label = value(form, "label");
  if (key.length < 2 || !label) redirect(`/app/lists/${listId}?error=Utfall kräver nyckel och namn`);
  const retry = value(form, "retry_after_minutes");
  const supabase = await createClient();
  const { error } = await supabase.from("list_dispositions").upsert({
    tenant_id: context.tenantId,
    list_id: listId,
    key,
    label,
    outcome_group: value(form, "outcome_group") || "neutral",
    terminal: checked(form, "terminal"),
    retry_after_minutes: retry ? Number(retry) : null,
    requires_note: checked(form, "requires_note"),
    requires_callback: checked(form, "requires_callback"),
    requires_order: checked(form, "requires_order"),
    active: true,
  }, { onConflict: "list_id,key" });
  if (error) redirect(`/app/lists/${listId}?error=${message(error)}`);
  revalidatePath(`/app/lists/${listId}`);
  redirect(`/app/lists/${listId}?saved=1`);
}
