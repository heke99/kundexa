import { NextResponse } from "next/server";
import { getAppContext } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export async function GET() {
  try {
    await getAppContext();
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("telephony_status_for_current_user");
    if (error || !data) {
      return NextResponse.json({
        platformConfigured: null,
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
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({
      platformConfigured: null,
      platformReady: false,
      manualReady: false,
      automaticReady: false,
      webhookReady: false,
      status: "error",
      errorCode: "RINKEL_STATUS_FAILED",
      errorMessage: "Telefonistatus kunde inte hämtas.",
    }, { status: 500 });
  }
}
