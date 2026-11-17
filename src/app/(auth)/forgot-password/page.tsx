import Link from "next/link";
import { requestPasswordRecovery } from "@/app/actions/password-recovery";
import { Logo } from "@/components/logo";
import { Field } from "@/components/ui/form-field";
export default async function ForgotPasswordPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return <main className="auth-page"><section className="auth-brand"><Logo /><div><h1>Återfå tillgång till ditt konto.</h1><p>Vi skickar en engångskod till din registrerade e-postadress.</p></div></section><section className="auth-form-wrap"><div className="auth-form"><h2>Glömt lösenord</h2>{error ? <p className="form-error">{error}</p> : null}<form action={requestPasswordRecovery} className="form-stack"><Field label="E-post" name="email" type="email" autoComplete="email" required /><button type="submit" className="button button-primary">Skicka engångskod</button></form><Link href="/reset-password">Jag har redan en kod</Link><p><Link href="/login">Till inloggning</Link></p></div></section></main>;
}
