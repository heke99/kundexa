"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { passwordSchema } from "@/lib/security/password-policy";

function text(formData: FormData, key: string) {
  return String(formData.get(key) ?? "");
}

export async function changePassword(formData: FormData) {
  const parsed = z.object({
    password: passwordSchema,
    confirmation: z.string(),
  }).safeParse({
    password: text(formData, "password"),
    confirmation: text(formData, "password_confirm"),
  });
  if (!parsed.success) redirect("/change-password?error=Det nya lösenordet uppfyller inte säkerhetskraven");
  if (parsed.data.password !== parsed.data.confirmation) redirect("/change-password?error=Lösenorden matchar inte");

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: stateRows, error: stateError } = await supabase.rpc("current_user_security_state");
  if (stateError) redirect("/change-password?error=Säkerhetsstatus kunde inte verifieras");
  const state = Array.isArray(stateRows) ? stateRows[0] : stateRows;
  if (!state?.must_change_password) redirect("/app");

  const { error: authError } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (authError) redirect("/change-password?error=Lösenordet kunde inte uppdateras");

  // Clear the credential gate only after Supabase Auth has accepted the new password.
  const admin = createAdminClient();
  const { error: completionError } = await admin.rpc("complete_user_password_change", { p_user_id: user.id });
  if (completionError) {
    console.error("password_change_state_completion_failed", { userId: user.id, code: completionError.code ?? null });
    redirect("/change-password?error=Lösenordet är ändrat men säkerhetsstatusen kunde inte slutföras. Logga in igen med det nya lösenordet.");
  }

  // Only now does the invitation become an active tenant/team membership.
  const invitation = await supabase.rpc("activate_current_user_invitation");
  if (invitation.error) {
    const reference = crypto.randomUUID();
    console.error("tenant_invitation_activation_after_password_change_failed", { userId: user.id, reference, code: invitation.error.code ?? null });
    await supabase.auth.signOut();
    redirect(`/login?error=${encodeURIComponent(`Lösenordet är ändrat men tenantaktiveringen behöver köras om. Logga in igen. Referens: ${reference}`)}`);
  }
  redirect("/app");
}
