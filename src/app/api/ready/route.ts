import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isPlatformRinkelRuntimeConfigured } from "@/lib/integrations/rinkel/client";

export const dynamic = "force-dynamic";

export async function GET() {
  const startedAt = Date.now();
  try {
    const admin = createAdminClient();
    const { error } = await admin.from("tenants").select("id", { head: true, count: "exact" }).limit(1);
    if (error) {
      return NextResponse.json({
        status: "not_ready",
        service: "kundexa-web",
        checks: { database: false, telephonyRuntimeConfigured: isPlatformRinkelRuntimeConfigured() },
        durationMs: Date.now() - startedAt,
      }, { status: 503, headers: { "cache-control": "no-store" } });
    }
    return NextResponse.json({
      status: "ready",
      service: "kundexa-web",
      checks: { database: true, telephonyRuntimeConfigured: isPlatformRinkelRuntimeConfigured() },
      durationMs: Date.now() - startedAt,
    }, { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({
      status: "not_ready",
      service: "kundexa-web",
      checks: { database: false, telephonyRuntimeConfigured: false },
      durationMs: Date.now() - startedAt,
    }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
