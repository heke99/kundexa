import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    error: "legacy_webrtc_disabled",
    replacement: "/api/v1/integrations/rinkel/status",
  }, { status: 410 });
}
