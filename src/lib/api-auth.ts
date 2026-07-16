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
      .select("id,tenant_id,scopes,rate_limit_per_minute,expires_at,revoked_at")
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

    await admin.from("api_keys").update({ last_used_at: new Date().toISOString() }).eq("id", key.id);
    return { tenantId: key.tenant_id, userId: null, role: null, scopes: key.scopes, rateLimit: key.rate_limit_per_minute, source: "api_key" };
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw jsonError("authentication_required", 401);

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
