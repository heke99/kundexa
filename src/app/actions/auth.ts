"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

function text(formData: FormData, key: string) { return String(formData.get(key) ?? "").trim(); }

export async function signIn(formData: FormData) {
  const parsed = z.object({ email: z.email(), password: z.string().min(8) }).safeParse({ email: text(formData,"email"), password: text(formData,"password") });
  if (!parsed.success) redirect("/login?error=Kontrollera e-post och lösenord");
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) redirect(`/login?error=${encodeURIComponent("Inloggningen misslyckades")}`);
  const invitation = await supabase.rpc("activate_current_user_invitation");
  if (invitation.error) {
    const reference = crypto.randomUUID();
    console.error("Tenant invitation activation after sign-in failed", { reference, error: invitation.error });
    redirect(`/login?error=${encodeURIComponent(`Inbjudan kunde inte aktiveras. Referens: ${reference}`)}`);
  }
  redirect("/app");
}

export async function signUp(formData: FormData) {
  const parsed = z.object({ fullName: z.string().min(2), email: z.email(), password: z.string().min(10) }).safeParse({ fullName:text(formData,"full_name"), email:text(formData,"email"), password:text(formData,"password") });
  if (!parsed.success) redirect("/register?error=Kontrollera uppgifterna. Lösenordet måste vara minst 10 tecken.");
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({ email: parsed.data.email, password: parsed.data.password, options: { data: { full_name: parsed.data.fullName } } });
  if (error) redirect(`/register?error=${encodeURIComponent(error.message)}`);
  redirect(data.session ? "/onboarding" : "/login?message=Kontrollera din e-post för att bekräfta kontot");
}

export async function createOrganization(formData: FormData) {
  const parsed = z.object({ name:z.string().min(2), legalName:z.string().min(2), organizationNumber:z.string().optional() }).safeParse({ name:text(formData,"name"), legalName:text(formData,"legal_name"), organizationNumber:text(formData,"organization_number") || undefined });
  if (!parsed.success) redirect("/onboarding?error=Fyll i organisationens namn");
  const supabase = await createClient();
  const { error } = await supabase.rpc("create_tenant_with_owner", { p_name:parsed.data.name, p_legal_name:parsed.data.legalName, p_organization_number:parsed.data.organizationNumber ?? null });
  if (error) redirect(`/onboarding?error=${encodeURIComponent(error.message)}`);
  redirect("/app");
}

export async function signOut() { const supabase=await createClient(); await supabase.auth.signOut(); redirect("/login"); }
