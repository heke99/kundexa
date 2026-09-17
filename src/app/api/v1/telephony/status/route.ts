import { NextResponse } from "next/server";
import { getAppContext } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { serverEnv } from "@/lib/env";

type TelephonyStatusPayload = Record<string, unknown> & {
  blockers?: Array<{ code?: string; message?: string }>;
};

/**
 * Kan säljaren ringa just nu, och om inte -- varför?
 *
 * Den gamla versionen svarade också på om säljaren fanns provisionerad hos
 * leverantören, hade en registrerad enhet, och vilken telefon som skulle ringa
 * först. Ingen av de frågorna finns kvar: webbläsaren ringer, och det finns
 * ingenting att provisionera.
 */
export async function GET() {
  try {
    await getAppContext();
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("telephony_status_for_current_user");
    if (error || !data) {
      console.error("telephony_status_failed", { code: error?.code ?? "NO_RESULT" });
      return NextResponse.json({
        tenantEnabled: false,
        manualReady: false,
        automaticReady: false,
        status: "error",
        errorCode: "TELEPHONY_STATUS_QUERY_FAILED",
        errorMessage: "Telefonistatus kunde inte läsas.",
        blockers: [],
      }, { status: 500 });
    }

    const payload = data as unknown as TelephonyStatusPayload;
    const env = serverEnv();
    const webphoneConfigured = Boolean(
      env.SINCH_APPLICATION_KEY?.trim() && env.SINCH_APPLICATION_SECRET?.trim(),
    );

    // Nycklarna är en serverinställning och syns inte i databasen, så det
    // hindret läggs till här. Utan det skulle statusen säga "redo" om en
    // webbtelefon som inte kan registrera sig.
    const blockers = [
      ...(webphoneConfigured ? [] : [{
        code: "WEBPHONE_NOT_CONFIGURED",
        message: "Webbtelefonen är inte konfigurerad. Kontakta plattformsadministratören.",
      }]),
      ...(payload.blockers ?? []),
    ];

    return NextResponse.json({
      ...payload,
      webphoneConfigured,
      manualReady: webphoneConfigured && payload.manualReady === true,
      automaticReady: webphoneConfigured && payload.automaticReady === true,
      status: blockers.length === 0 ? "ready" : "blocked",
      blockers,
    });
  } catch (error) {
    console.error("telephony_status_failed", { error: error instanceof Error ? error.name : "unknown" });
    return NextResponse.json({
      tenantEnabled: false,
      manualReady: false,
      automaticReady: false,
      status: "error",
      errorCode: "TELEPHONY_STATUS_QUERY_FAILED",
      errorMessage: "Telefonistatus kunde inte läsas.",
      blockers: [],
    }, { status: 500 });
  }
}
