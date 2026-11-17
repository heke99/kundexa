import { redirect } from "next/navigation";
import type { createClient } from "@/lib/supabase/server";

export async function enforceMfaGate(supabase: Awaited<ReturnType<typeof createClient>>) {
  const { data: required, error } = await supabase.rpc("current_user_mfa_required");
  if (error) throw new Error("mfa_policy_unavailable");
  if (!required) return;
  const assurance = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (assurance.error) throw new Error("mfa_assurance_unavailable");
  if (assurance.data.currentLevel !== "aal2") redirect("/mfa");
}
