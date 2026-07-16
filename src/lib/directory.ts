import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";

export const directorySearchSchema = z.object({
  entityType: z.enum(["organization", "establishment", "person"]).default("organization"),
  query: z.string().trim().max(200).nullish(),
  countryCode: z.string().trim().length(2).default("SE").nullable(),
  county: z.string().trim().max(120).nullish(),
  municipality: z.string().trim().max(120).nullish(),
  city: z.string().trim().max(120).nullish(),
  sniCode: z.string().trim().max(20).nullish(),
  employeeMin: z.number().int().min(0).nullish(),
  employeeMax: z.number().int().min(0).nullish(),
  hasPhone: z.boolean().nullish(),
  hasEmail: z.boolean().nullish(),
  freshOnly: z.boolean().default(false),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
}).refine((value) => value.employeeMin == null || value.employeeMax == null || value.employeeMin <= value.employeeMax, {
  message: "employeeMin_must_not_exceed_employeeMax",
});

export type DirectorySearchInput = z.infer<typeof directorySearchSchema>;

export type DirectorySearchRow = {
  id: string;
  entity_type: "organization" | "establishment" | "person";
  canonical_name: string;
  organization_number: string | null;
  legal_form: string | null;
  organization_status: string | null;
  address_line1: string | null;
  postal_code: string | null;
  city: string | null;
  municipality: string | null;
  county: string | null;
  country_code: string | null;
  latitude: number | null;
  longitude: number | null;
  industry: string | null;
  sni_code: string | null;
  employee_count: number | null;
  revenue: number | null;
  result: number | null;
  website: string | null;
  phone_e164: string | null;
  email: string | null;
  data_quality_score: number | null;
  enriched_at: string | null;
  fresh_until: string | null;
  freshness_state: "fresh" | "stale" | "missing" | "refreshing" | "quarantined";
  source_attribution_required: boolean;
};

export async function searchDirectoryForTenant(tenantId: string, input: DirectorySearchInput): Promise<DirectorySearchRow[]> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("directory_search_for_tenant", {
    p_tenant_id: tenantId,
    p_entity_type: input.entityType,
    p_query: input.query || null,
    p_country_code: input.countryCode || null,
    p_county: input.county || null,
    p_municipality: input.municipality || null,
    p_city: input.city || null,
    p_sni_code: input.sniCode || null,
    p_employee_min: input.employeeMin ?? null,
    p_employee_max: input.employeeMax ?? null,
    p_has_phone: input.hasPhone ?? null,
    p_has_email: input.hasEmail ?? null,
    p_fresh_only: input.freshOnly,
    p_limit: input.limit,
    p_offset: input.offset,
  });
  if (error) throw new Error(error.message);
  return (data ?? []) as DirectorySearchRow[];
}

export type EnrichmentRequest = {
  tenantId: string;
  userId: string | null;
  entityId: string;
  purpose: string;
  enrichmentType: string;
  requestedFields: string[];
  force: boolean;
  idempotencyKey?: string;
};

type MasterEntity = {
  id: string;
  entity_type: "organization" | "establishment" | "person";
  license_tenant_id: string;
  data_provider_id: string;
  provider_account_id: string | null;
  permission_id: string;
  external_primary_id: string | null;
  fresh_until: string | null;
};

export async function queueEnrichmentForEntity(request: EnrichmentRequest) {
  const admin = createAdminClient();
  const { data: feature } = await admin.from("tenant_features").select("enabled")
    .eq("tenant_id", request.tenantId).eq("feature_key", "data_enrichment").maybeSingle();
  if (!feature?.enabled) throw new Error("feature_disabled:data_enrichment");

  const { data: accessible, error: entityError } = await admin.rpc("directory_entity_for_tenant", {
    p_tenant_id: request.tenantId,
    p_entity_id: request.entityId,
  });
  if (entityError) throw new Error(entityError.message);
  const entity = (accessible?.[0] ?? null) as MasterEntity | null;
  if (!entity) throw new Error("directory_entity_not_found");
  if (!request.force && entity.fresh_until && new Date(entity.fresh_until) > new Date()) {
    return { status: "fresh", entityId: entity.id, job: null, estimatedExternalCalls: 0, estimatedCost: 0 };
  }
  if (!entity.external_primary_id) throw new Error("entity_external_identifier_missing");

  // A shared/global entity may be read by another tenant, but that tenant must not
  // mutate the shared master row with its own provider licence. Refresh is owned by
  // the tenant whose provider permission created the entity.
  if (entity.license_tenant_id !== request.tenantId) {
    throw new Error("shared_entity_refresh_managed_by_license_owner");
  }

  const { data: provider } = await admin.from("data_providers").select("id,provider,status")
    .eq("tenant_id", request.tenantId).eq("id", entity.data_provider_id).eq("status", "active").maybeSingle();
  if (!provider) throw new Error("source_provider_not_active");

  const { data: permission } = await admin.from("provider_permissions")
    .select("id,provider_account_id,allowed_entity_types,allowed_purposes,expires_at,status")
    .eq("tenant_id", request.tenantId).eq("id", entity.permission_id).eq("status", "active").maybeSingle();
  if (!permission) throw new Error("provider_permission_missing_for_entity");
  const entityAllowed = (permission.allowed_entity_types ?? []).includes(entity.entity_type);
  const purposeAllowed = !(permission.allowed_purposes ?? []).length || permission.allowed_purposes.includes(request.purpose);
  const unexpired = !permission.expires_at || new Date(permission.expires_at) > new Date();
  if (!entityAllowed || !purposeAllowed || !unexpired) throw new Error("provider_permission_missing_for_purpose");
  if (!permission.provider_account_id || permission.provider_account_id !== entity.provider_account_id) {
    throw new Error("provider_account_mismatch");
  }

  const { data: account } = await admin.from("provider_accounts").select("id,status,configuration")
    .eq("tenant_id", request.tenantId).eq("id", permission.provider_account_id).eq("status", "active").maybeSingle();
  if (!account) throw new Error("provider_account_not_active");
  const configuration = (account.configuration ?? {}) as Record<string, unknown>;
  const estimatedCost = Number(configuration.estimated_cost_per_call ?? 0);
  const normalizedFields = [...new Set(request.requestedFields.map((field) => field.trim()).filter(Boolean))].sort();
  const idempotencyKey = request.idempotencyKey || [
    provider.provider,
    entity.entity_type,
    entity.external_primary_id,
    request.enrichmentType,
    normalizedFields.join(",") || "all",
    new Date().toISOString().slice(0, 10),
  ].join(":");

  const payload = {
    tenant_id: request.tenantId,
    master_entity_id: entity.id,
    data_provider_id: provider.id,
    provider_account_id: account.id,
    permission_id: permission.id,
    enrichment_type: request.enrichmentType,
    requested_fields: normalizedFields,
    purpose: request.purpose,
    status: "queued",
    idempotency_key: idempotencyKey,
    estimated_external_calls: 1,
    estimated_cost: estimatedCost,
    permission_result: { allowed: true, permission_id: permission.id, purpose: request.purpose },
    quota_result: { checked_at: new Date().toISOString(), reserved: false },
    requested_by: request.userId,
  };
  const { data: job, error: insertError } = await admin.from("enrichment_jobs").insert(payload).select("*").single();
  if (insertError) {
    if (insertError.code === "23505") {
      const { data: existing } = await admin.from("enrichment_jobs").select("*")
        .eq("tenant_id", request.tenantId).eq("idempotency_key", idempotencyKey).single();
      if (existing) return { status: existing.status, entityId: entity.id, job: existing, estimatedExternalCalls: existing.estimated_external_calls, estimatedCost: Number(existing.estimated_cost) };
    }
    throw new Error(insertError.message);
  }
  return { status: job.status, entityId: entity.id, job, estimatedExternalCalls: 1, estimatedCost };
}
