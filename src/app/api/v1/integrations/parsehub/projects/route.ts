import { NextResponse } from "next/server";
import { z } from "zod";
import { getAppContext } from "@/lib/auth";
import { assertPermission } from "@/lib/permissions";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptJson, randomToken, sha256 } from "@/lib/crypto";
import { publicEnv, serverEnv } from "@/lib/env";

const projectSchema = z.object({
  projectName: z.string().trim().min(2).max(160),
  projectToken: z.string().trim().min(8).max(300),
  apiKey: z.string().trim().min(8).max(500),
  importProfileId: z.uuid(),
  sourceWebsite: z.enum(["allabolag", "merinfo", "other"]).default("other"),
});

export async function GET() {
  try {
    const ctx = await getAppContext();
    assertPermission(ctx.role, "imports.manage");
    const admin = createAdminClient();
    const { data, error } = await admin.from("parsehub_projects")
      .select("id,project_name,source_website,import_profile_id,active,configuration,created_at,updated_at")
      .eq("tenant_id", ctx.tenantId).order("project_name");
    if (error) throw new Error(error.message);
    return NextResponse.json({ projects: data ?? [] });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "internal_error" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await getAppContext();
    assertPermission(ctx.role, "imports.manage");
    if (!['owner','admin'].includes(ctx.role)) return NextResponse.json({ error: "admin_required" }, { status: 403 });
    const input = projectSchema.parse(await request.json());
    const admin = createAdminClient();
    const env = serverEnv();

    const profile = await admin.from("import_profiles").select("id").eq("tenant_id", ctx.tenantId).eq("id", input.importProfileId).eq("active", true).maybeSingle();
    if (profile.error || !profile.data) return NextResponse.json({ error: "import_profile_not_found" }, { status: 404 });

    const providerResult = await admin.from("data_providers").upsert({
      tenant_id: ctx.tenantId,
      provider: "parsehub",
      name: "ParseHub",
      status: "active",
      field_mapping: {},
      license_terms: { source: "tenant_configured", purpose: "crm_import" },
      adapter_key: "parsehub",
      integration_type: "api",
      cache_scope: "tenant",
      source_class: "licensed_provider",
      allowed_entity_types: ["organization", "person"],
      allowed_purposes: ["crm_import"],
      allow_raw_storage: true,
      allow_tenant_display: true,
      valid_from: new Date().toISOString().slice(0, 10),
    }, { onConflict: "tenant_id,provider,name" }).select("id").single();
    if (providerResult.error || !providerResult.data) throw new Error(providerResult.error?.message ?? "parsehub_provider_create_failed");

    const accountResult = await admin.from("provider_accounts").upsert({
      tenant_id: ctx.tenantId,
      data_provider_id: providerResult.data.id,
      name: "ParseHub API",
      status: "active",
      credentials_ciphertext: encryptJson({ apiKey: input.apiKey }, env.KUNDEXA_ENCRYPTION_KEY),
      configuration: { apiVersion: "v2" },
      created_by: ctx.userId,
    }, { onConflict: "tenant_id,data_provider_id,name" }).select("id").single();
    if (accountResult.error || !accountResult.data) throw new Error(accountResult.error?.message ?? "parsehub_account_create_failed");

    const webhookSecret = randomToken(32);
    const projectTokenHash = sha256(input.projectToken);
    const secretHash = sha256(`${webhookSecret}:${env.KUNDEXA_WEBHOOK_PEPPER}`);
    const projectResult = await admin.from("parsehub_projects").upsert({
      tenant_id: ctx.tenantId,
      provider_account_id: accountResult.data.id,
      import_profile_id: input.importProfileId,
      project_token_hash: projectTokenHash,
      project_name: input.projectName,
      source_website: input.sourceWebsite,
      webhook_secret_hash: secretHash,
      active: true,
      configuration: { apiVersion: "v2", projectTokenSuffix: input.projectToken.slice(-6) },
      created_by: ctx.userId,
    }, { onConflict: "tenant_id,project_token_hash" }).select("id").single();
    if (projectResult.error || !projectResult.data) throw new Error(projectResult.error?.message ?? "parsehub_project_create_failed");

    await admin.from("audit_logs").insert({ tenant_id: ctx.tenantId, actor_user_id: ctx.userId, action: "parsehub.project_configured", entity_type: "parsehub_project", entity_id: projectResult.data.id, after_data: { projectName: input.projectName, sourceWebsite: input.sourceWebsite, importProfileId: input.importProfileId } });
    const base = publicEnv().NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
    return NextResponse.json({
      id: projectResult.data.id,
      webhookUrl: `${base}/api/v1/integrations/parsehub/webhook?project=${encodeURIComponent(projectResult.data.id)}&secret=${encodeURIComponent(webhookSecret)}`,
      warning: "Webhook-adressen visas endast i detta svar. Spara den i ParseHub.",
    }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "invalid_request", issues: error.issues }, { status: 422 });
    return NextResponse.json({ error: error instanceof Error ? error.message : "internal_error" }, { status: 500 });
  }
}
