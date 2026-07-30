import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json({ error: "legacy_46elks_voice_disabled", provider: "rinkel" }, { status: 410 });
}
