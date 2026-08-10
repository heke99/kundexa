import Link from "next/link";
import { ShieldCheck, ListFilter, Plus } from "@/components/icons";
import { ModuleOverview } from "@/components/module-overview";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Field, SelectField } from "@/components/ui/form-field";
import { TemporaryPasswordFields } from "@/components/users/temporary-password-fields";
import { createClient } from "@/lib/supabase/server";
import { canReadPlatformAdministration, getPlatformContext, isPlatformAdmin, isPlatformOwner } from "@/lib/auth";
import { updatePlatformMembership, updateTenantPlatformStatus } from "@/app/actions/platform";
import { createPlatformTenantAndInviteOwner } from "@/app/actions/platform-lists";
import { authUserEmailsById } from "@/lib/supabase/auth-admin-users";

const roleLabels: Record<string, string> = {
  platform_owner: "Plattformsägare", platform_admin: "Plattformsadmin",
  platform_support: "Support", platform_auditor: "Revisor",
};

export default async function PlatformPage({ searchParams }: { searchParams: Promise<{ error?: string; message?: string }> }) {
  const params = await searchParams;
  const context = await getPlatformContext();
  if (!canReadPlatformAdministration(context.platformRole)) {
    return <ModuleOverview
      title="Plattformsåtkomst"
      description="Din plattformsroll är aktiv men har inte behörighet att läsa plattformsadministrationens tenant-, list- eller auditdata."
      icon={ShieldCheck}
      features={["Separat plattformsidentitet", "Minsta behörighet", "Ingen tenantberoende åtkomst"]}
    >
      {params.error ? <p className="form-error">{params.error}</p> : null}
      <Card>
        <CardHeader><h2>Begränsad plattformsroll</h2><Badge className="badge-warning">{roleLabels[context.platformRole] ?? context.platformRole}</Badge></CardHeader>
        <CardContent><p>Kontakta en plattformsägare om rollen behöver utökas. Tenantroller ger inte plattformsbehörighet och plattformsrollen ger inte tenantdata automatiskt.</p></CardContent>
      </Card>
    </ModuleOverview>;
  }
  const admin = await createClient();
  const [{ data: tenants }, { data: memberships }, { data: platformMemberships }, { data: audits }, { data: platformLists }] = await Promise.all([
    admin.from("tenants").select("id,name,legal_name,organization_number,status,created_at").order("created_at", { ascending: false }),
    admin.from("tenant_memberships").select("tenant_id,status"),
    admin.from("platform_memberships").select("user_id,role,status,created_at,updated_at").order("created_at"),
    admin.from("platform_audit_logs").select("id,action,entity_type,entity_id,tenant_id,reason,created_at,actor_user_id").order("created_at", { ascending: false }).limit(50),
    admin.from("platform_lists").select("id,status,total_entries,available_entries"),
  ]);
  const emailByUser = await authUserEmailsById([
    ...(platformMemberships ?? []).map((member) => member.user_id),
    ...(audits ?? []).map((audit) => audit.actor_user_id ?? ""),
  ]);
  const memberCountByTenant = new Map<string, number>();
  for (const membership of memberships ?? []) if (membership.status === "active") memberCountByTenant.set(membership.tenant_id, (memberCountByTenant.get(membership.tenant_id) ?? 0) + 1);
  const listEntries = (platformLists ?? []).reduce((sum, list) => sum + Number(list.total_entries), 0);
  const availableEntries = (platformLists ?? []).reduce((sum, list) => sum + Number(list.available_entries), 0);

  return <ModuleOverview
    title="Plattformsadministration"
    description="Separat, revisionsloggad styrning av tenants, plattformsroller och den centrala listbanken. Tenantroller ger aldrig automatiskt plattformsåtkomst."
    icon={ShieldCheck}
    features={["Tenantlivscykel och ägarinbjudan", "Central listbank och tenantdistribution", "Plattformsroller", "Revisionslogg"]}
  >
    {params.error ? <p className="form-error">{params.error}</p> : null}
    {params.message ? <div className="notice">{params.message}</div> : null}

    <div className="grid grid-3">
      <Card><CardContent><strong>{tenants?.length ?? 0}</strong><p className="muted">tenants</p></CardContent></Card>
      <Card><CardContent><strong>{listEntries}</strong><p className="muted">centrala listposter</p></CardContent></Card>
      <Card><CardContent><strong>{availableEntries}</strong><p className="muted">tillgängliga för tilldelning</p></CardContent></Card>
    </div>

    <div className="split-layout">
      <Card>
        <CardHeader><h2>Tenants</h2><Badge>{tenants?.length ?? 0}</Badge></CardHeader>
        <CardContent>
          {(tenants ?? []).map((tenant) => <div className="activity-line" key={tenant.id}>
            <span className="activity-dot"><ShieldCheck size={14} /></span>
            <div style={{ flex: 1 }}><strong>{tenant.name}</strong><p>{tenant.legal_name} · {tenant.organization_number ?? "Org.nr saknas"} · {memberCountByTenant.get(tenant.id) ?? 0} aktiva användare</p></div>
            <Badge className={tenant.status === "active" ? "badge-success" : ""}>{tenant.status}</Badge>
            {isPlatformAdmin(context.platformRole) ? <form action={updateTenantPlatformStatus} className="form-stack" style={{ minWidth: 230 }}>
              <input type="hidden" name="tenant_id" value={tenant.id} />
              <select name="status" defaultValue={tenant.status} aria-label={`Status för ${tenant.name}`}><option value="trial">Trial</option><option value="active">Aktiv</option><option value="suspended">Pausad</option><option value="cancelled">Avslutad</option></select>
              <input name="reason" minLength={5} required placeholder="Anledning till ändringen" />
              <button className="button button-secondary button-sm">Spara status</button>
            </form> : null}
          </div>)}
        </CardContent>
      </Card>

      {isPlatformAdmin(context.platformRole) ? <Card>
        <CardHeader><h2><Plus size={16} /> Ny tenant och ägare</h2></CardHeader>
        <CardContent><form action={createPlatformTenantAndInviteOwner} className="form-stack">
          <Field label="Visningsnamn" name="name" required />
          <Field label="Juridiskt namn" name="legal_name" required />
          <Field label="Organisationsnummer" name="organization_number" />
          <div className="form-grid"><Field label="Ägarens förnamn" name="owner_first_name" required /><Field label="Ägarens efternamn" name="owner_last_name" required /></div>
          <Field label="Tenantägarens e-post" name="owner_email" type="email" required />
          <TemporaryPasswordFields />
          <div className="form-grid"><Field label="Tidszon" name="timezone" defaultValue="Europe/Stockholm" required /><SelectField label="Språk/locale" name="locale" defaultValue="sv-SE"><option value="sv-SE">Svenska (sv-SE)</option><option value="en-US">English (en-US)</option></SelectField></div>
          <p className="muted">Huvudteam, tenantinställningar och juridisk standardavsändare skapas automatiskt. Det tillfälliga lösenordet sparas aldrig i Kundexas databas.</p>
          <button className="button button-primary">Skapa tenant och ägare</button>
        </form></CardContent>
      </Card> : null}
    </div>

    <Card>
      <CardHeader><h2><ListFilter size={17} /> Central listbank</h2><Badge>{platformLists?.length ?? 0} listor</Badge></CardHeader>
      <CardContent><p>Importera CSV, JSON och Excel centralt, filtrera urval och materialisera dem till valda tenants utan att blanda tenantdata.</p><Link href="/app/platform/lists" className="button button-primary">Öppna listbanken</Link></CardContent>
    </Card>
    {isPlatformAdmin(context.platformRole) ? <Card>
      <CardHeader><h2><ShieldCheck size={17} /> Central telefoni</h2></CardHeader>
      <CardContent><p>Hantera Kundexas enda Rinkel-anslutning, centrala katalog, webhookar och historiserade tenantallokeringar.</p><Link href="/app/platform/telephony" className="button button-primary">Öppna Rinkel-plattformen</Link></CardContent>
    </Card> : null}

    <div className="split-layout">
      <Card>
        <CardHeader><h2>Plattformsroller</h2><Badge>{platformMemberships?.filter((member) => member.status === "active").length ?? 0} aktiva</Badge></CardHeader>
        <CardContent>
          {(platformMemberships ?? []).map((member) => <div className="activity-line" key={member.user_id}><span className="activity-dot"><ShieldCheck size={14} /></span><div><strong>{emailByUser.get(member.user_id) ?? member.user_id}</strong><p>{roleLabels[member.role] ?? member.role}</p></div><Badge className={member.status === "active" ? "badge-success" : ""}>{member.status}</Badge></div>)}
          {isPlatformOwner(context.platformRole) ? <form action={updatePlatformMembership} className="form-stack" style={{ marginTop: 18 }}>
            <Field label="Registrerad användares e-post" name="email" type="email" required />
            <label>Plattformsroll<select name="role" defaultValue="platform_admin"><option value="platform_owner">Plattformsägare</option><option value="platform_admin">Plattformsadmin</option><option value="platform_support">Support</option><option value="platform_auditor">Revisor</option></select></label>
            <label>Status<select name="status" defaultValue="active"><option value="active">Aktiv</option><option value="suspended">Pausad</option><option value="removed">Borttagen</option></select></label>
            <Field label="Anledning" name="reason" required />
            <button className="button button-primary">Uppdatera plattformsroll</button>
          </form> : null}
        </CardContent>
      </Card>
      <Card><CardHeader><h2>Senaste plattformshändelser</h2><Badge>{audits?.length ?? 0}</Badge></CardHeader><CardContent>{(audits ?? []).map((audit) => <div className="activity-line" key={audit.id}><span className="activity-dot"><ShieldCheck size={14} /></span><div><strong>{audit.action}</strong><p>{audit.reason ?? "Ingen anledning angiven"} · {new Date(audit.created_at).toLocaleString("sv-SE")}</p></div><small>{emailByUser.get(audit.actor_user_id ?? "") ?? "system"}</small></div>)}</CardContent></Card>
    </div>
  </ModuleOverview>;
}
