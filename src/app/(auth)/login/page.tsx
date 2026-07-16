//
import Link from "next/link";
import { Logo } from "@/components/logo";
import { signIn } from "@/app/actions/auth";
import { Field } from "@/components/ui/form-field";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; message?: string }> }) {
  const params=await searchParams;
  return <main className="auth-page"><section className="auth-brand"><Logo /><div><h1>Välkommen tillbaka till Kundexa.</h1><p>Arbeta med kunder, ringlistor, samtal, avtal och automatiseringar i samma säkra arbetsyta.</p></div><small>© 2026 Kundexa</small></section><section className="auth-form-wrap"><div className="auth-form"><h2>Logga in</h2><p>Använd ditt arbetskonto.</p>{params.error?<p className="form-error">{params.error}</p>:null}{params.message?<p className="notice">{params.message}</p>:null}<form action={signIn} className="form-stack"><Field label="E-post" name="email" type="email" autoComplete="email" required /><Field label="Lösenord" name="password" type="password" autoComplete="current-password" required /><button className="button button-primary" type="submit">Logga in</button></form><p className="auth-switch">Saknar du konto? <Link href="/register">Skapa ett konto</Link></p></div></section></main>;
}
