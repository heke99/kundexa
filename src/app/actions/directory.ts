"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getAppContext, isAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { directorySearchSchema } from "@/lib/directory";

const text = (form: FormData, key: string) => String(form.get(key) ?? "").trim();
const optionalNumber = (form: FormData, key: string) => text(form, key) ? Number(text(form, key)) : undefined;
const optionalBoolean = (form: FormData, key: string) => form.has(key) ? form.get(key) === "true" || form.get(key) === "on" : undefined;

function filtersFromForm(form: FormData) {
  return directorySearchSchema.parse({
    entityType: text(form, "entityType") || "organization", query: text(form, "query") || undefined,
    countryCode: text(form, "countryCode") || "SE", county: text(form, "county") || undefined, municipality: text(form, "municipality") || undefined,
    city: text(form, "city") || undefined, postalCode: text(form, "postalCode") || undefined, sniCode: text(form, "sniCode") || undefined,
    legalForm: text(form, "legalForm") || undefined, organizationStatus: text(form, "organizationStatus") || undefined,
    employeeMin: optionalNumber(form, "employeeMin"), employeeMax: optionalNumber(form, "employeeMax"), revenueMin: optionalNumber(form, "revenueMin"), revenueMax: optionalNumber(form, "revenueMax"),
    resultMin: optionalNumber(form, "resultMin"), resultMax: optionalNumber(form, "resultMax"), hasPhone: optionalBoolean(form, "hasPhone"), hasEmail: optionalBoolean(form, "hasEmail"), hasWebsite: optionalBoolean(form, "hasWebsite"),
    phoneType: text(form, "phoneType") || undefined, freshOnly: form.get("freshOnly") === "on", dataAgeDaysMax: optionalNumber(form, "dataAgeDaysMax"),
    latitude: optionalNumber(form, "latitude"), longitude: optionalNumber(form, "longitude"), radiusKm: optionalNumber(form, "radiusKm"),
    previouslyContacted: optionalBoolean(form, "previouslyContacted"), callAttemptsMin: optionalNumber(form, "callAttemptsMin"),
    customerLifecycle: text(form, "customerLifecycle") || undefined, sort: text(form, "sort") || "quality_desc", limit: 50, offset: 0,
  });
}

export async function createDirectorySegment(form: FormData) {
  const context = await getAppContext(); const name = text(form, "name");
  if (!name) redirect("/app/directory?error=Segmentnamn krävs");
  const rules = filtersFromForm(form); const supabase = await createClient();
  const { data, error } = await supabase.from("segments").insert({ tenant_id: context.tenantId, name, description: text(form, "description") || null, entity_type: rules.entityType, segment_type: text(form, "segmentType") || "dynamic", rule_definition: rules, owner_user_id: context.userId, active: true }).select("id").single();
  if (error) redirect(`/app/directory?error=${encodeURIComponent(error.message)}`);
  const { error: refreshError } = await supabase.rpc("refresh_segment_materialization", { p_segment_id: data.id, p_actor: context.userId });
  if (refreshError) redirect(`/app/directory?error=${encodeURIComponent(refreshError.message)}`);
  revalidatePath("/app/directory"); redirect("/app/directory?message=Segmentet skapades och materialiserades");
}

export async function refreshDirectorySegment(form: FormData) {
  const context = await getAppContext(); const segmentId = text(form, "segment_id"); if (!segmentId) return;
  const supabase = await createClient(); const { error } = await supabase.rpc("refresh_segment_materialization", { p_segment_id: segmentId, p_actor: context.userId });
  if (error) redirect(`/app/directory?error=${encodeURIComponent(error.message)}`); revalidatePath("/app/directory");
}

export async function sendSegmentToCampaign(form: FormData) {
  const context = await getAppContext(); const segmentId = text(form, "segment_id"); const campaignId = text(form, "campaign_id");
  if (!segmentId || !campaignId) redirect("/app/directory?error=Segment och kampanj krävs");
  const supabase = await createClient(); const { data, error } = await supabase.rpc("materialize_segment_to_campaign", { p_segment_id: segmentId, p_campaign_id: campaignId, p_actor: context.userId });
  if (error) redirect(`/app/directory?error=${encodeURIComponent(error.message)}`); revalidatePath("/app/directory"); revalidatePath("/app/campaigns");
  redirect(`/app/directory?message=${encodeURIComponent(`Segmentet skickades till kampanjen: ${JSON.stringify(data)}`)}`);
}

export async function mergeDirectoryEntities(form: FormData) {
  const context = await getAppContext(); if (!isAdmin(context.role)) throw new Error("Adminbehörighet krävs");
  const target = text(form, "target_entity_id"); const source = text(form, "source_entity_id"); if (!target || !source) return;
  const supabase = await createClient(); const { error } = await supabase.rpc("merge_master_entities", { p_tenant_id: context.tenantId, p_target: target, p_source: source, p_actor: context.userId });
  if (error) redirect(`/app/directory?error=${encodeURIComponent(error.message)}`); revalidatePath("/app/directory");
}
