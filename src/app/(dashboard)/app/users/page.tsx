import { UserPlus, Users } from "@/components/icons";
import { createClient } from "@/lib/supabase/server";
import { getAppContext } from "@/lib/auth";
import { inviteUser, updateTenantMember } from "@/app/actions/organization";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { Field, SelectField, TextareaField } from "@/components/ui/form-field";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";

export default async function UsersPage({ searchParams }: { searchParams: Promise<{ error?: string; message?: string }> }) {
  const params = await searchParams;
  const context = await getAppContext();
  const supabase = await createClient();
  const [{ data: memberships }, { data: teams }, { data: teamMembers }, { data: invitations }] = await Promise.all([
    supabase.from("tenant_memberships").select("user_id,role,status,joined_at,primary_team_id,profiles:user_id(full_name,last_seen_at)").order("created_at"),
    supabase.from("teams").select("id,name,status,invite_sellers_enabled").neq("status", "archived").order("name"),
    supabase.from("team_members").select("team_id,user_id,role"),
    supabase.from("tenant_invitations").select("id,email,role,status,team_ids,expires_at,created_at").order("created_at", { ascending: false }).limit(50),
  ]);
  const managedTeamIds = new Set(context.role === "owner" || context.role === "admin"
    ? (teams ?? []).map((team) => team.id)
    : (teamMembers ?? []).filter((member) => member.user_id === context.userId && member.role === "manager").map((member) => member.team_id));
  const availableTeams = (teams ?? []).filter((team) => managedTeamIds.has(team.id));
  const teamNames = new Map((teams ?? []).map((team) => [team.id, team.name]));
  const mayInvite = ["owner", "admin", "team_lead"].includes(context.role);
  const mayManageMembers = ["owner", "admin"].includes(context.role);
  const activeMembers = (memberships ?? []).filter((membership) => membership.status === "active");

  return <>
    <PageHeader title="Användare och inbjudningar" description="Tenantägaren styr roller och team. Teamledare kan bara bjuda in säljare till team de själva leder." />
    {params.error ? <p className="form-error">{params.error}</p> : null}
    {params.message ? <div className="notice">{params.message}</div> : null}
    <div className={mayInvite ? "split-layout" : "grid"}>
      <Card><CardHeader><h2><Users size={17} /> Medlemmar</h2><Badge>{memberships?.length ?? 0}</Badge></CardHeader><CardContent style={{ padding: 0 }}>
        <DataTable headers={["Namn", "Roll", "Team", "Status", "Ansluten", "Senast aktiv"]}>{(memberships ?? []).map((membership) => {
          const profile = Array.isArray(membership.profiles) ? membership.profiles[0] : membership.profiles;
          const userTeams = (teamMembers ?? []).filter((member) => member.user_id === membership.user_id).map((member) => teamNames.get(member.team_id)).filter(Boolean);
          return <tr key={membership.user_id}><td><strong>{profile?.full_name ?? "Inbjuden användare"}</strong></td><td>{membership.role}</td><td>{userTeams.join(", ") || "Ej tilldelad"}</td><td><Badge className={membership.status === "active" ? "badge-success" : "badge-warning"}>{membership.status}</Badge></td><td>{formatDate(membership.joined_at)}</td><td>{formatDate(profile?.last_seen_at)}</td></tr>;
        })}</DataTable>
      </CardContent></Card>
      {mayInvite ? <Card><CardHeader><h2><UserPlus size={16} /> Bjud in</h2></CardHeader><CardContent><form action={inviteUser} className="form-stack">
        <Field label="E-post" name="email" type="email" required />
        <SelectField label="Roll" name="role" defaultValue="sales">
          {context.role === "owner" ? <option value="owner">Tenantägare</option> : null}
          {context.role !== "team_lead" ? <><option value="admin">Administratör</option><option value="team_lead">Teamledare</option><option value="contract_manager">Avtalsansvarig</option><option value="quality">Kvalitetskontroll</option><option value="backoffice">Backoffice</option><option value="finance">Ekonomi</option><option value="viewer">Läsbehörig</option></> : null}
          <option value="sales">Säljare</option>
        </SelectField>
        <fieldset className="form-section"><legend>Team</legend>{availableTeams.map((team) => <label className="check-row" key={team.id}><input type="checkbox" name="team_ids" value={team.id} /> {team.name}</label>)}{!availableTeams.length ? <p className="muted">Du leder inget team som kan ta emot inbjudan.</p> : null}</fieldset>
        <TextareaField label="Personligt meddelande" name="message" />
        <button className="button button-primary" disabled={!availableTeams.length && context.role === "team_lead"}><UserPlus size={16} /> Skicka inbjudan</button>
      </form></CardContent></Card> : null}
    </div>
    {mayManageMembers ? <Card><CardHeader><h2>Roller, status och omfördelning</h2><Badge>{memberships?.length ?? 0}</Badge></CardHeader><CardContent><div className="grid">{(memberships ?? []).map((membership) => {
      const profile = Array.isArray(membership.profiles) ? membership.profiles[0] : membership.profiles;
      const mayEdit = membership.user_id !== context.userId && (context.role === "owner" || !["owner", "admin"].includes(membership.role));
      if (!mayEdit) return null;
      return <form action={updateTenantMember} className="form-section form-stack" key={membership.user_id}>
        <input type="hidden" name="user_id" value={membership.user_id} />
        <strong>{profile?.full_name ?? "Inbjuden användare"}</strong>
        <div className="form-grid"><SelectField label="Roll" name="role" defaultValue={membership.role}>
          {context.role === "owner" ? <><option value="owner">Tenantägare</option><option value="admin">Administratör</option></> : null}
          <option value="team_lead">Teamledare</option><option value="sales">Säljare</option><option value="contract_manager">Avtalsansvarig</option><option value="quality">Kvalitetskontroll</option><option value="backoffice">Backoffice</option><option value="finance">Ekonomi</option><option value="viewer">Läsbehörig</option>
        </SelectField><SelectField label="Status" name="status" defaultValue={membership.status}>{membership.status === "invited" ? <><option value="invited">Inbjuden</option><option value="removed">Återkalla inbjudan</option></> : <><option value="active">Aktiv</option><option value="suspended">Pausad</option><option value="removed">Borttagen</option></>}</SelectField><SelectField label="Omfördela öppet arbete till" name="reassign_user_id" defaultValue=""><option value="">Teamets gemensamma kö / ingen ägare</option>{activeMembers.filter((candidate) => candidate.user_id !== membership.user_id).map((candidate) => { const candidateProfile = Array.isArray(candidate.profiles) ? candidate.profiles[0] : candidate.profiles; return <option key={candidate.user_id} value={candidate.user_id}>{candidateProfile?.full_name ?? candidate.user_id} · {candidate.role}</option>; })}</SelectField></div>
        <p className="muted">Vid paus eller borttagning stoppas nya listtilldelningar. Öppna callbacks, kunder, affärer och listposter flyttas till vald användare eller lämnas utan personlig ägare.</p>
        <button className="button button-secondary">Uppdatera medlem</button>
      </form>;
    })}</div></CardContent></Card> : null}
    <Card><CardHeader><h2>Inbjudningshistorik</h2><Badge>{invitations?.length ?? 0}</Badge></CardHeader><CardContent>{(invitations ?? []).map((invitation) => <div className="activity-line" key={invitation.id}><span className="activity-dot"><UserPlus size={14} /></span><div style={{ flex: 1 }}><strong>{invitation.email}</strong><p>{invitation.role} · {(invitation.team_ids ?? []).map((id: string) => teamNames.get(id) ?? id).join(", ") || "Inget team"} · löper ut {formatDate(invitation.expires_at)}</p></div><Badge className={invitation.status === "accepted" ? "badge-success" : "badge-warning"}>{invitation.status}</Badge></div>)}</CardContent></Card>
  </>;
}
