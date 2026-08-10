import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Logo } from "@/components/logo";
import { signOut } from "@/app/actions/auth";

type TenantLifecycle = { onboarding_status?: string };

export default async function OnboardingPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: securityRows, error: securityError } = await supabase.rpc("current_user_security_state");
  if (securityError) redirect("/login?error=Säkerhetsstatus kunde inte verifieras");
  const securityState = Array.isArray(securityRows) ? securityRows[0] : securityRows;
  if (securityState?.must_change_password) redirect("/change-password");

  const { data: platformMembership } = await supabase.from("platform_memberships").select("role").eq("user_id", user.id).eq("status", "active").maybeSingle();
  if (platformMembership) redirect("/app/platform");

  const { data: membership } = await supabase
    .from("tenant_memberships")
    .select("tenant_id,role,status,tenants(onboarding_status)")
    .eq("user_id", user.id)
    .eq("status", "active")
    .limit(1)
    .maybeSingle();

  const tenant = Array.isArray(membership?.tenants) ? membership.tenants[0] : membership?.tenants as TenantLifecycle | null | undefined;
  if (membership && tenant?.onboarding_status === "active") {
    await supabase.rpc("switch_active_tenant", { p_tenant_id: membership.tenant_id });
    redirect("/app");
  }

  const waitingForTenantCompletion = Boolean(membership);
  return <main className="auth-page">
    <section className="auth-brand"><Logo /><div><h1>{waitingForTenantCompletion ? "Organisationen slutför sin grundkonfiguration." : "Ditt konto väntar på en organisation."}</h1><p>Kundexa använder plattformsstyrd B2B-onboarding. Tenant, juridiskt bolag, Huvudteam och grundinställningar skapas i ett sammanhängande flöde.</p></div><small>Ingen separat självregistrering skapar en parallell tenant.</small></section>
    <section className="auth-form-wrap"><div className="auth-form"><h2>{waitingForTenantCompletion ? "Onboarding pågår" : "Ingen aktiv tenant"}</h2><p>{waitingForTenantCompletion ? "Kontot är kopplat till organisationen, men dess obligatoriska grundstatus är inte aktiv ännu. Kundexa öppnar inte CRM/Dialer förrän den databaskontrollen är klar." : "Kontakta Kundexa eller er administratör om du väntar på åtkomst. Om du nyligen blivit skapad, kontrollera att du loggar in med rätt e-postadress."}</p><form action={signOut}><button className="button button-secondary">Logga ut</button></form></div></section>
  </main>;
}
