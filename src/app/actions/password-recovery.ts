"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { serverEnv } from "@/lib/env";
import { passwordSchema } from "@/lib/security/password-policy";

export async function requestPasswordRecovery(form: FormData) {
  const email = z.email().max(254).safeParse(String(form.get("email") ?? "").trim());
  if (!email.success) redirect("/forgot-password?error=Ange en giltig e-postadress");
  const supabase = await createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(email.data, {
    redirectTo: new URL("/reset-password", serverEnv().NEXT_PUBLIC_APP_URL).toString(),
  });
  if (error) console.warn("password_recovery_request_failed", { code: error.code ?? null });
  // Identical response for absent accounts, provider rejection and successful requests.
  redirect("/reset-password?message=Om kontot finns får du en engångskod via e-post. Kontrollera även skräpposten.");
}

export async function recoverPassword(form: FormData) {
  const parsed = z.object({ email: z.email().max(254), token: z.string().regex(/^\d{6}$/), password: passwordSchema, confirmation: z.string() }).safeParse({
    email: String(form.get("email") ?? "").trim(), token: String(form.get("token") ?? "").trim(),
    password: String(form.get("password") ?? ""), confirmation: String(form.get("password_confirm") ?? ""),
  });
  if (!parsed.success || parsed.data.password !== parsed.data.confirmation) redirect("/reset-password?error=Kontrollera e-post, kod och att lösenorden uppfyller kraven och matchar");
  const supabase = await createClient();
  const { data, error } = await supabase.auth.verifyOtp({ email: parsed.data.email, token: parsed.data.token, type: "recovery" });
  if (error || !data.user || !data.session || data.user.email?.toLowerCase() !== parsed.data.email.toLowerCase()) redirect("/reset-password?error=Koden är ogiltig eller har gått ut. Begär en ny kod.");
  // Verify recovery in this action; an existing session alone never authorises a reset.
  const changed = await supabase.auth.updateUser({ password: parsed.data.password });
  if (changed.error) {
    await supabase.auth.signOut();
    redirect("/forgot-password?error=Lösenordet kunde inte ändras. Begär en ny kod och försök igen.");
  }
  const completed = await createAdminClient().rpc("complete_user_password_change", { p_user_id: data.user.id });
  await supabase.auth.signOut();
  if (completed.error) redirect("/login?error=Lösenordet är ändrat men säkerhetsstatusen kunde inte slutföras. Kontakta administratören.");
  redirect("/login?message=Lösenordet är ändrat. Logga in med ditt nya lösenord.");
}
