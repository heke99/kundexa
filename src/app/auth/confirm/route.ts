import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

function safeNext(value: string | null) {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/change-password";
  return value;
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as EmailOtpType | null;
  const next = safeNext(url.searchParams.get("next"));

  if (!tokenHash || !type) {
    return NextResponse.redirect(new URL("/login?error=Aktiveringslänken är ogiltig", url.origin));
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
  if (error) {
    const reference = crypto.randomUUID();
    console.warn("auth_email_confirmation_failed", {
      reference,
      code: error.code ?? null,
      status: error.status ?? null,
      type,
    });
    return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(`Aktiveringslänken kunde inte verifieras. Referens: ${reference}`)}`, url.origin));
  }

  return NextResponse.redirect(new URL(next, url.origin));
}
