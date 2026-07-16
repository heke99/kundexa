import { NextResponse } from "next/server";
import { z } from "zod";
import { getAppContext, isAdmin } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { randomToken, sha256 } from "@/lib/crypto";

const scopeSchema = z.enum([
  "*",
  "customers:read",
  "customers:write",
  "contracts:read",
  "contracts:write",
  "calls:create",
  "messages:send",
  "imports:write",
  "reports:read",
  "directory:read",
  "directory:refresh",
  "segments:write",
  "providers:manage",
]);

export async function POST(request: Request) {
  try {
    const ctx = await getAppContext();
    if (!isAdmin(ctx.role)) return NextResponse.json({ error: "admin_required" }, { status: 403 });

    const parsed = z.object({
      name: z.string().min(2).max(100),
      scopes: z.array(scopeSchema).min(1).max(20),
      expiresAt: z.iso.datetime().optional(),
    }).parse(await request.json());

    const raw = `kx_live_${randomToken(32)}`;
    const admin = createAdminClient();
    const { error } = await admin.from("api_keys").insert({
      tenant_id: ctx.tenantId,
      name: parsed.name,
      key_prefix: raw.slice(0, 16),
      key_hash: sha256(raw),
      scopes: [...new Set(parsed.scopes)],
      expires_at: parsed.expiresAt ?? null,
      created_by: ctx.userId,
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });

    return NextResponse.json({ key: raw }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "validation_error", details: error.issues }, { status: 422 });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
