import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";

const nullableBoolean = z.boolean().nullish();
const nullableNumber = z.number().finite().nullish();
const nullableString = (max = 200) => z.string().trim().max(max).nullish();

export const directorySearchSchema = z.object({
  entityType: z.enum(["organization", "establishment", "person"]).default("organization"),
  query: nullableString(200),
  countryCode: z.string().trim().length(2).default("SE").nullable(),
  county: nullableString(120), municipality: nullableString(120), city: nullableString(120), postalCode: nullableString(20),
  sniCode: nullableString(20), legalForm: nullableString(120), organizationStatus: nullableString(120),
  dataProviderId: z.uuid().nullish(), sourceProvider: nullableString(120), ageMin: z.number().int().min(0).max(130).nullish(), ageMax: z.number().int().min(0).max(130).nullish(),
  employeeMin: z.number().int().min(0).nullish(), employeeMax: z.number().int().min(0).nullish(),
  revenueMin: nullableNumber, revenueMax: nullableNumber, resultMin: nullableNumber, resultMax: nullableNumber,
  hasPhone: nullableBoolean, hasEmail: nullableBoolean, hasWebsite: nullableBoolean,
  phoneType: z.enum(["mobile", "landline", "unknown"]).nullish(),
  freshOnly: z.boolean().default(false), dataAgeDaysMax: z.number().int().min(0).max(3650).nullish(),
  registrationFrom: z.iso.date().nullish(), registrationTo: z.iso.date().nullish(),
  fTaxRegistered: nullableBoolean, vatRegistered: nullableBoolean, employerRegistered: nullableBoolean,
  latitude: z.number().min(-90).max(90).nullish(), longitude: z.number().min(-180).max(180).nullish(), radiusKm: z.number().positive().max(1000).nullish(),
  previouslyContacted: nullableBoolean, callAttemptsMin: z.number().int().min(0).nullish(), hasContactPerson: nullableBoolean,
  assignedUserId: z.uuid().nullish(), assignedTeamId: z.uuid().nullish(), campaignId: z.uuid().nullish(), customerLifecycle: z.enum(["prospect", "lead", "customer", "former_customer", "lost", "blocked"]).nullish(),
  contractStatus: z.enum(["draft","ready","sent","delivered","opened","signing","accepted","signed","declined","expired","cancelled","superseded","active","terminated"]).nullish(),
  activeContract: nullableBoolean, nixStatus: z.enum(["listed","not_listed","unknown","error","missing"]).nullish(), blocked: nullableBoolean,
  allowedChannel: z.enum(["call","sms","email"]).nullish(),
  sort: z.enum(["quality_desc", "updated_desc", "name_asc", "name_desc"]).default("quality_desc"),
  limit: z.number().int().min(1).max(200).default(50), offset: z.number().int().min(0).default(0),
}).superRefine((value, context) => {
  for (const [minimum, maximum, label] of [
    [value.employeeMin, value.employeeMax, "employee"], [value.ageMin, value.ageMax, "age"], [value.revenueMin, value.revenueMax, "revenue"], [value.resultMin, value.resultMax, "result"],
  ] as const) if (minimum != null && maximum != null && minimum > maximum) context.addIssue({ code: "custom", message: `${label}_minimum_must_not_exceed_maximum` });
  const radiusFields = [value.latitude, value.longitude, value.radiusKm];
  if (radiusFields.some((entry) => entry != null) && radiusFields.some((entry) => entry == null)) context.addIssue({ code: "custom", message: "latitude_longitude_and_radius_are_required_together" });
});

export type DirectorySearchInput = z.infer<typeof directorySearchSchema>;
export type DirectorySearchSummary = {
  total: number; fresh: number; stale: number; missing: number; refreshing: number; quarantined: number;
  missingPhone: number; missingEmail: number; linkedCustomers: number; averageQuality: number;
};
export type DirectorySearchRow = {
  id: string; entity_type: "organization" | "establishment" | "person"; canonical_name: string | null;
  organization_number: string | null; legal_form: string | null; organization_status: string | null;
  address_line1: string | null; postal_code: string | null; city: string | null; municipality: string | null; county: string | null;
  country_code: string | null; latitude: number | null; longitude: number | null; industry: string | null; sni_code: string | null;
  employee_count: number | null; revenue: number | null; result: number | null; website: string | null; phone_e164: string | null; email: string | null;
  data_quality_score: number | null; enriched_at: string | null; fresh_until: string | null;
  freshness_state: "fresh" | "stale" | "missing" | "refreshing" | "quarantined"; source_attribution_required: boolean;
  customer_id: string | null; last_contact_at: string | null; call_attempts: number | null; customer_lifecycle: string | null; campaign_id: string | null;
};

function rpcFilters(input: DirectorySearchInput) {
  const { limit: _limit, offset: _offset, ...filters } = input;
  return Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== undefined && value !== null && value !== ""));
}

export async function searchDirectoryForTenant(tenantId: string, input: DirectorySearchInput) {
  const admin = createAdminClient();
  const filters = rpcFilters(input);
  const [{ data, error }, { data: summary, error: summaryError }] = await Promise.all([
    admin.rpc("directory_search_v2_for_tenant", { p_tenant_id: tenantId, p_filters: filters, p_limit: input.limit, p_offset: input.offset }),
    admin.rpc("directory_search_summary_for_tenant", { p_tenant_id: tenantId, p_filters: filters }),
  ]);
  if (error) throw new Error(error.message);
  if (summaryError) throw new Error(summaryError.message);
  return { data: (Array.isArray(data) ? data : []) as DirectorySearchRow[], summary: summary as DirectorySearchSummary };
}

export type EnrichmentRequest = {
  tenantId: string; userId: string | null; entityId: string; purpose: string; enrichmentType: string;
  requestedFields: string[]; force: boolean; idempotencyKey?: string;
};
type MasterEntity = {
  id: string; entity_type: "organization" | "establishment" | "person"; license_tenant_id: string; data_provider_id: string;
  provider_account_id: string | null; permission_id: string; external_primary_id: string | null; fresh_until: string | null;
};

export async function queueEnrichmentForEntity(request: EnrichmentRequest) {
  const admin = createAdminClient();
  const { data: feature } = await admin.from("tenant_features").select("enabled").eq("tenant_id", request.tenantId).eq("feature_key", "data_enrichment").maybeSingle();
  if (!feature?.enabled) throw new Error("feature_disabled:data_enrichment");
  const { data: accessible, error: entityError } = await admin.rpc("directory_entity_for_tenant", { p_tenant_id: request.tenantId, p_entity_id: request.entityId });
  if (entityError) throw new Error(entityError.message);
  const entity = (accessible?.[0] ?? null) as MasterEntity | null;
  if (!entity) throw new Error("directory_entity_not_found");
  if (!request.force && entity.fresh_until && new Date(entity.fresh_until) > new Date()) return { status: "fresh", entityId: entity.id, job: null, estimatedExternalCalls: 0, estimatedCost: 0 };
  if (!entity.external_primary_id) throw new Error("entity_external_identifier_missing");
  if (entity.license_tenant_id !== request.tenantId) throw new Error("shared_entity_refresh_managed_by_license_owner");
  const { data: provider } = await admin.from("data_providers").select("id,provider,status").eq("tenant_id", request.tenantId).eq("id", entity.data_provider_id).eq("status", "active").maybeSingle();
  if (!provider) throw new Error("source_provider_not_active");
  const { data: permission } = await admin.from("provider_permissions").select("id,provider_account_id,allowed_entity_types,allowed_purposes,expires_at,status").eq("tenant_id", request.tenantId).eq("id", entity.permission_id).eq("status", "active").maybeSingle();
  if (!permission) throw new Error("provider_permission_missing_for_entity");
  const entityAllowed = (permission.allowed_entity_types ?? []).includes(entity.entity_type);
  const purposeAllowed = !(permission.allowed_purposes ?? []).length || permission.allowed_purposes.includes(request.purpose);
  const unexpired = !permission.expires_at || new Date(permission.expires_at) > new Date();
  if (!entityAllowed || !purposeAllowed || !unexpired) throw new Error("provider_permission_denied");
  const accountId = entity.provider_account_id ?? permission.provider_account_id;
  if (!accountId) throw new Error("provider_account_missing");
  const { data: account } = await admin.from("provider_accounts").select("id,status,configuration").eq("tenant_id", request.tenantId).eq("id", accountId).eq("status", "active").maybeSingle();
  if (!account) throw new Error("provider_account_inactive");
  const estimatedCost = Number((account.configuration as Record<string, unknown> | null)?.estimated_cost_per_call ?? 0);
  const key = request.idempotencyKey ?? `${provider.provider}:${entity.entity_type}:${entity.external_primary_id}:${request.enrichmentType}`;
  const { data: existing } = await admin.from("enrichment_jobs").select("*").eq("tenant_id", request.tenantId).eq("idempotency_key", key).maybeSingle();
  if (existing) return { status: existing.status, entityId: entity.id, job: existing, estimatedExternalCalls: existing.estimated_external_calls, estimatedCost: Number(existing.estimated_cost) };
  const { data: job, error } = await admin.from("enrichment_jobs").insert({
    tenant_id: request.tenantId, master_entity_id: entity.id, data_provider_id: provider.id, provider_account_id: account.id,
    permission_id: permission.id, enrichment_type: request.enrichmentType, requested_fields: request.requestedFields,
    purpose: request.purpose, idempotency_key: key, estimated_external_calls: 1, estimated_cost: estimatedCost,
    permission_result: { entityAllowed, purposeAllowed, unexpired }, requested_by: request.userId,
  }).select("*").single();
  if (error) throw new Error(error.message);
  return { status: job.status, entityId: entity.id, job, estimatedExternalCalls: 1, estimatedCost };
}
