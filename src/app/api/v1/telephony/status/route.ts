import { NextResponse } from "next/server";
import { getAppContext } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { isPlatformRinkelRuntimeConfigured } from "@/lib/integrations/rinkel/client";

type TelephonyStatusPayload = Record<string, unknown> & {
  errorMessage?: string | null;
  blockers?: Array<Record<string, unknown> & { message?: string | null }>;
};

function publicTelephonyMessage(message: string) {
  return message
    .replace(/rinkel/gi, "telefonitjänsten")
    .replace(/provider/gi, "telefonitjänsten")
    .replace(/leverantör/gi, "telefonitjänst");
}

export async function GET() {
  try {
    await getAppContext();
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("telephony_status_for_current_user");
    if (error || !data) {
      return NextResponse.json({
        platformConfigured: null,
        runtimeConfigured: isPlatformRinkelRuntimeConfigured(),
        platformReady: false,
        tenantEnabled: false,
        tenantHasNumber: false,
        userMapped: false,
        userHasDevice: false,
        userHasNumberAccess: false,
        manualReady: false,
        automaticReady: false,
        webhookReady: false,
        status: "error",
        errorCode: "RINKEL_STATUS_QUERY_FAILED",
        errorMessage: "Telefonistatus kunde inte läsas.",
      }, { status: 500 });
    }
    const payload = data as TelephonyStatusPayload;
    const runtimeConfigured = isPlatformRinkelRuntimeConfigured();
    const runtimeBlocker = runtimeConfigured ? [] : [{
      code: "RINKEL_RUNTIME_API_KEY_MISSING",
      message: "Telefonitjänstens serverkonfiguration saknas. Kontakta plattformsadministratören.",
    }];
    const blockers = [...runtimeBlocker, ...(payload.blockers ?? [])];
    return NextResponse.json({
      ...payload,
      runtimeConfigured,
      platformReady: runtimeConfigured && payload.platformReady === true,
      manualReady: runtimeConfigured && payload.manualReady === true,
      automaticReady: runtimeConfigured && payload.automaticReady === true,
      errorCode: blockers[0]?.code ?? payload.errorCode ?? null,
      errorMessage: blockers[0]?.message
        ? publicTelephonyMessage(String(blockers[0].message))
        : payload.errorMessage ? publicTelephonyMessage(payload.errorMessage) : payload.errorMessage,
      blockers: blockers.map((blocker) => ({
        ...blocker,
        message: blocker.message ? publicTelephonyMessage(String(blocker.message)) : blocker.message,
      })),
    });
  } catch {
    return NextResponse.json({
      platformConfigured: null,
      runtimeConfigured: isPlatformRinkelRuntimeConfigured(),
      platformReady: false,
      tenantEnabled: false,
      tenantHasNumber: false,
      userMapped: false,
      userHasDevice: false,
      userHasNumberAccess: false,
      manualReady: false,
      automaticReady: false,
      webhookReady: false,
      status: "error",
      errorCode: "RINKEL_STATUS_FAILED",
      errorMessage: "Telefonistatus kunde inte hämtas.",
    }, { status: 500 });
  }
}
