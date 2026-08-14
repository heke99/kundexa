import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isPlatformRinkelRuntimeConfigured } from "@/lib/integrations/rinkel/client";
import { isUsablePublicAppUrl, publicEnv } from "@/lib/env";

export const dynamic = "force-dynamic";

export async function GET() {
  const startedAt = Date.now();
  // The configured public base URL is what customers receive in acceptance and
  // signing links. It is not a secret, and surfacing it here is the only way to
  // confirm from outside that a deployment builds links for the canonical domain
  // rather than for a host that no longer resolves.
  let appBaseUrl: string | null = null;
  try {
    appBaseUrl = publicEnv().NEXT_PUBLIC_APP_URL;
  } catch {
    appBaseUrl = null;
  }
  const appBaseUrlUsable = appBaseUrl !== null && isUsablePublicAppUrl(appBaseUrl);
  try {
    const admin = createAdminClient();
    const { error } = await admin.from("tenants").select("id", { head: true, count: "exact" }).limit(1);
    if (error) {
      return NextResponse.json({
        status: "not_ready",
        service: "kundexa-web",
        checks: { database: false, telephonyRuntimeConfigured: isPlatformRinkelRuntimeConfigured(), appBaseUrl, appBaseUrlUsable },
        durationMs: Date.now() - startedAt,
      }, { status: 503, headers: { "cache-control": "no-store" } });
    }
    return NextResponse.json({
      status: "ready",
      service: "kundexa-web",
      checks: { database: true, telephonyRuntimeConfigured: isPlatformRinkelRuntimeConfigured(), appBaseUrl, appBaseUrlUsable },
      durationMs: Date.now() - startedAt,
    }, { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({
      status: "not_ready",
      service: "kundexa-web",
      checks: { database: false, telephonyRuntimeConfigured: false, appBaseUrl, appBaseUrlUsable },
      durationMs: Date.now() - startedAt,
    }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
