import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const supabase = await createClient();
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent("Inbjudan kunde inte aktiveras")}`, url.origin));
  }

  // Invited users must join the intended tenant instead of accidentally creating
  // a separate organization in onboarding.
  const invitation = await supabase.rpc("activate_current_user_invitation");
  if (invitation.error) {
    const reference = crypto.randomUUID();
    console.error("Tenant invitation activation failed", { reference, error: invitation.error });
    return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(`Inbjudan kunde inte aktiveras. Referens: ${reference}`)}`, url.origin));
  }
  return NextResponse.redirect(new URL("/app", url.origin));
}
