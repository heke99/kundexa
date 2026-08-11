import { redirect } from "next/navigation";
import { Logo } from "@/components/logo";
import { Field } from "@/components/ui/form-field";
import { changePassword } from "@/app/actions/change-password";
import { createClient } from "@/lib/supabase/server";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, passwordPolicyHint } from "@/lib/security/password-policy-config";

export default async function ChangePasswordPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const params = await searchParams;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const { data: rows, error: stateError } = await supabase.rpc("current_user_security_state");
  if (stateError) redirect("/login?error=Säkerhetsstatus kunde inte verifieras");
  const state = Array.isArray(rows) ? rows[0] : rows;
  if (!state?.must_change_password) redirect("/app");

  return <main className="auth-page">
    <section className="auth-brand"><Logo /><div><h1>Skapa ditt personliga lösenord.</h1><p>Du har verifierat din Supabase-inbjudan. Välj nu lösenordet som du ska använda när du loggar in i Kundexa.</p></div><small>Kundexa · säker kontoaktivering</small></section>
    <section className="auth-form-wrap"><div className="auth-form"><h2>Välj lösenord</h2><p>{passwordPolicyHint()}</p>{params.error ? <p className="form-error">{params.error}</p> : null}<form action={changePassword} className="form-stack">
      <Field label="Nytt lösenord" name="password" type="password" minLength={PASSWORD_MIN_LENGTH} maxLength={PASSWORD_MAX_LENGTH} autoComplete="new-password" required />
      <Field label="Bekräfta nytt lösenord" name="password_confirm" type="password" minLength={PASSWORD_MIN_LENGTH} maxLength={PASSWORD_MAX_LENGTH} autoComplete="new-password" required />
      <button className="button button-primary" type="submit">Aktivera konto</button>
    </form></div></section>
  </main>;
}
