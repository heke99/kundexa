import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Logo } from "@/components/logo";
import { MfaForm } from "./mfa-form";
export default async function MfaPage() {
 const supabase=await createClient();const {data:{user}}=await supabase.auth.getUser();
 if(!user)redirect("/login");
 return <main className="auth-page"><section className="auth-brand"><Logo/><div><h1>Skydda ditt administratörskonto.</h1><p>Bekräfta inloggningen med din autentiseringsapp.</p></div></section><section className="auth-form-wrap"><div className="auth-form"><MfaForm/></div></section></main>;
}
