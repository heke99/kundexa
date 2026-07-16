import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticateRequest } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";

const schema = z.object({
  providerId: z.uuid(), providerAccountId: z.uuid(), permissionId: z.uuid(), entityType: z.enum(["organization", "establishment", "person"]),
  name: z.string().min(2).max(120).default("Manuell kataloghämtning"), filters: z.record(z.string(), z.unknown()).default({}),
  maxRecords: z.number().int().min(1).max(5000).default(5000), runNow: z.boolean().default(true),
});

export async function POST(request: Request) {
  try {
    const identity = await authenticateRequest(request, "enrichment:write");
    const input = schema.parse(await request.json());
    const admin = createAdminClient();
    const [{ data: provider }, { data: account }, { data: permission }] = await Promise.all([
      admin.from("data_providers").select("id,adapter_key,discovery_configuration,status").eq("tenant_id", identity.tenantId).eq("id", input.providerId).eq("status", "active").maybeSingle(),
      admin.from("provider_accounts").select("id,status,configuration").eq("tenant_id", identity.tenantId).eq("id", input.providerAccountId).eq("status", "active").maybeSingle(),
      admin.from("provider_permissions").select("id,status,allowed_entity_types,expires_at").eq("tenant_id", identity.tenantId).eq("id", input.permissionId).eq("status", "active").maybeSingle(),
    ]);
    if (!provider || !account || !permission) return NextResponse.json({ error: "provider_configuration_invalid" }, { status: 409 });
    if (!(permission.allowed_entity_types ?? []).includes(input.entityType)) return NextResponse.json({ error: "entity_type_not_permitted" }, { status: 403 });
    if (permission.expires_at && new Date(permission.expires_at) <= new Date()) return NextResponse.json({ error: "provider_permission_expired" }, { status: 403 });
    const endpoint = (provider.discovery_configuration as Record<string, unknown> | null)?.endpoint_template ?? (account.configuration as Record<string, unknown> | null)?.discovery_endpoint_template;
    if (!endpoint) return NextResponse.json({ error: "provider_discovery_endpoint_missing" }, { status: 409 });
    const { data: job, error } = await admin.from("ingestion_jobs").insert({
      tenant_id: identity.tenantId, data_provider_id: provider.id, provider_account_id: account.id, permission_id: permission.id,
      name: input.name, entity_type: input.entityType, priority: 10, max_records: input.maxRecords, quota_interpretation: "per_run",
      filter_definition: input.filters, adapter_key: provider.adapter_key ?? "generic_json", adapter_configuration: provider.discovery_configuration ?? {},
      status: "active", next_run_at: input.runNow ? new Date().toISOString() : null, created_by: identity.userId,
    }).select("*").single();
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    await admin.from("audit_logs").insert({ tenant_id: identity.tenantId, actor_user_id: identity.userId, action: "ingestion_job.created", entity_type: "ingestion_job", entity_id: job.id, after_data: job });
    return NextResponse.json({ data: job }, { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof z.ZodError) return NextResponse.json({ error: "validation_error", details: error.issues }, { status: 422 });
    return NextResponse.json({ error: error instanceof Error ? error.message : "internal_error" }, { status: 500 });
  }
}
