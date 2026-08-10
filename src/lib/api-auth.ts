import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { sha256 } from "@/lib/crypto";
import { apiScopePermission, can } from "@/lib/permissions";

export type ApiIdentity = {
  tenantId: string;
  userId: string | null;
  role: string | null;
  scopes: string[];
  rateLimit: number;
  source: "api_key" | "session";
};

function jsonError(error: string, status: number, headers?: HeadersInit) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export async function authenticateRequest(request: Request, requiredScope?: string): Promise<ApiIdentity> {
  const authorization = request.headers.get("authorization");
  const admin = createAdminClient();

  if (authorization?.startsWith("Bearer kx_")) {
    const raw = authorization.slice(7).trim();
    const { data: key } = await admin
      .from("api_keys")
      .select("id,tenant_id,scopes,rate_limit_per_minute,expires_at,revoked_at,created_by")
      .eq("key_hash", sha256(raw))
      .single();

    if (!key || key.revoked_at || (key.expires_at && new Date(key.expires_at) < new Date())) {
      throw jsonError("invalid_api_key", 401);
    }
    if (requiredScope && !key.scopes.includes(requiredScope) && !key.scopes.includes("*")) {
      throw jsonError("insufficient_scope", 403);
    }

    const { data: allowed } = await admin.rpc("consume_rate_limit", {
      p_tenant_id: key.tenant_id,
      p_bucket: `api:${key.id}`,
      p_limit: key.rate_limit_per_minute,
      p_window_seconds: 60,
    });
    if (!allowed) throw jsonError("rate_limit_exceeded", 429, { "retry-after": "60" });

    if (!key.created_by) throw jsonError("api_key_actor_missing", 403);
    const { data: membership } = await admin.from("tenant_memberships")
      .select("role,status")
      .eq("tenant_id", key.tenant_id)
      .eq("user_id", key.created_by)
      .eq("status", "active")
      .maybeSingle();
    if (!membership) throw jsonError("api_key_actor_membership_inactive", 403);
    // API-key requests execute through the service-role transport. Keep that bypass
    // capability restricted to tenant-wide administrative actors; team/user-scoped
    // automation must use session auth/RLS until impersonated-RLS tokens are supported.
    if (!["owner", "admin"].includes(membership.role)) throw jsonError("api_key_actor_requires_tenant_admin", 403);
    if (requiredScope) {
      const permission = apiScopePermission[requiredScope];
      if (!permission || !can(membership.role, permission)) throw jsonError("api_key_actor_insufficient_permission", 403);
    }

    await admin.from("api_keys").update({ last_used_at: new Date().toISOString() }).eq("id", key.id);
    return { tenantId: key.tenant_id, userId: key.created_by, role: membership.role, scopes: key.scopes, rateLimit: key.rate_limit_per_minute, source: "api_key" };
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw jsonError("authentication_required", 401);

  const { data: securityRows, error: securityError } = await supabase.rpc("current_user_security_state");
  if (securityError) throw jsonError("security_state_unavailable", 503);
  const securityState = Array.isArray(securityRows) ? securityRows[0] : securityRows;
  if (securityState?.must_change_password) throw jsonError("password_change_required", 403);

  const { data: profile } = await supabase.from("profiles").select("active_tenant_id").eq("id", user.id).single();
  if (!profile?.active_tenant_id) throw jsonError("active_tenant_required", 403);

  const { data: membership } = await supabase
    .from("tenant_memberships")
    .select("role,status")
    .eq("tenant_id", profile.active_tenant_id)
    .eq("user_id", user.id)
    .eq("status", "active")
    .single();
  if (!membership) throw jsonError("active_membership_required", 403);

  if (requiredScope) {
    const permission = apiScopePermission[requiredScope];
    if (!permission || !can(membership.role, permission)) throw jsonError("insufficient_permission", 403);
  }

  const rateLimit = 120;
  const { data: allowed } = await admin.rpc("consume_rate_limit", {
    p_tenant_id: profile.active_tenant_id,
    p_bucket: `session-api:${user.id}`,
    p_limit: rateLimit,
    p_window_seconds: 60,
  });
  if (!allowed) throw jsonError("rate_limit_exceeded", 429, { "retry-after": "60" });

  return {
    tenantId: profile.active_tenant_id,
    userId: user.id,
    role: membership.role,
    scopes: ["session"],
    rateLimit,
    source: "session",
  };
}

export async function dataClientForIdentity(identity: ApiIdentity): Promise<SupabaseClient> {
  return identity.source === "api_key" ? createAdminClient() : createClient();
}


export type ApiObjectResource = "customer" | "contract" | "call" | "contract_document";

/**
 * Explicit object gate for API-key detail endpoints. Session requests continue to
 * use normal RLS; API keys use service-role transport and therefore must prove
 * tenant ownership before any object read/write.
 */
export async function assertApiObjectAccess(identity: ApiIdentity, resource: ApiObjectResource, id: string) {
  if (identity.source === "session") return;
  if (!identity.userId || !["owner", "admin"].includes(identity.role ?? "")) throw jsonError("api_object_access_denied", 403);
  const admin = createAdminClient();
  let exists = false;
  if (resource === "customer") {
    const { data } = await admin.from("customers").select("id").eq("tenant_id", identity.tenantId).eq("id", id).is("deleted_at", null).maybeSingle();
    exists = Boolean(data);
  } else if (resource === "contract") {
    const { data } = await admin.from("contracts").select("id").eq("tenant_id", identity.tenantId).eq("id", id).maybeSingle();
    exists = Boolean(data);
  } else if (resource === "call") {
    const { data } = await admin.from("calls").select("id").eq("tenant_id", identity.tenantId).eq("id", id).maybeSingle();
    exists = Boolean(data);
  } else {
    const { data } = await admin.from("contract_documents").select("id").eq("tenant_id", identity.tenantId).eq("id", id).maybeSingle();
    exists = Boolean(data);
  }
  if (!exists) throw jsonError("not_found", 404);
}
