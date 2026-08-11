"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { PASSWORD_MAX_LENGTH } from "@/lib/security/password-policy-config";

function text(formData: FormData, key: string) { return String(formData.get(key) ?? "").trim(); }

export async function signIn(formData: FormData) {
  const parsed = z.object({ email: z.email(), password: z.string().min(1).max(PASSWORD_MAX_LENGTH) }).safeParse({
    email: text(formData, "email"),
    password: String(formData.get("password") ?? ""),
  });
  if (!parsed.success) redirect("/login?error=Kontrollera e-post och lösenord");
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) {
    const reference = crypto.randomUUID();
    console.warn("auth_sign_in_failed", {
      reference,
      code: error.code ?? null,
      status: error.status ?? null,
    });
    redirect(`/login?error=${encodeURIComponent(`Inloggningen misslyckades. Referens: ${reference}`)}`);
  }

  // A newly provisioned identity stays only an Auth identity + invited membership until
  // the temporary credential has been replaced. This prevents direct Data API/RLS access
  // during first login instead of relying only on a Next.js redirect.
  const { data: securityRows, error: securityError } = await supabase.rpc("current_user_security_state");
  if (securityError) redirect("/login?error=Säkerhetsstatus kunde inte verifieras");
  const securityState = Array.isArray(securityRows) ? securityRows[0] : securityRows;
  if (securityState?.must_change_password) redirect("/change-password");

  const invitation = await supabase.rpc("activate_current_user_invitation");
  if (invitation.error) {
    const reference = crypto.randomUUID();
    console.error("Tenant invitation activation after sign-in failed", { reference, code: invitation.error.code ?? null });
    await supabase.auth.signOut();
    redirect(`/login?error=${encodeURIComponent(`Inbjudan kunde inte aktiveras. Referens: ${reference}`)}`);
  }
  redirect("/app");
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
