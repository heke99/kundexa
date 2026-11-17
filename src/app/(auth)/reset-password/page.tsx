import Link from "next/link";
import { recoverPassword } from "@/app/actions/password-recovery";
import { Logo } from "@/components/logo";
import { Field } from "@/components/ui/form-field";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, passwordPolicyHint } from "@/lib/security/password-policy-config";
export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ error?: string; message?: string }> }) {
  const params = await searchParams;
  return <main className="auth-page"><section className="auth-brand"><Logo /><div><h1>Välj ett nytt lösenord.</h1><p>Använd engångskoden från återställningsmejlet.</p></div></section><section className="auth-form-wrap"><div className="auth-form"><h2>Återställ lösenord</h2><p>{passwordPolicyHint()}</p>{params.error ? <p className="form-error">{params.error}</p> : null}{params.message ? <p className="notice">{params.message}</p> : null}<form action={recoverPassword} className="form-stack"><Field label="E-post" name="email" type="email" autoComplete="email" required /><Field label="Engångskod" name="token" type="text" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" required /><Field label="Nytt lösenord" name="password" type="password" minLength={PASSWORD_MIN_LENGTH} maxLength={PASSWORD_MAX_LENGTH} autoComplete="new-password" required /><Field label="Bekräfta lösenord" name="password_confirm" type="password" minLength={PASSWORD_MIN_LENGTH} maxLength={PASSWORD_MAX_LENGTH} autoComplete="new-password" required /><button type="submit" className="button button-primary">Ändra lösenord</button></form><p><Link href="/forgot-password">Begär en ny kod</Link></p><Link href="/login">Till inloggning</Link></div></section></main>;
}
