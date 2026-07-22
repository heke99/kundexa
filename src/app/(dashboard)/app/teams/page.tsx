import { Plus, Users } from "@/components/icons";
import { createClient } from "@/lib/supabase/server";
import { getAppContext } from "@/lib/auth";
import { createTeam, removeTeamMember, setTeamMember, updateTeam } from "@/app/actions/organization";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Field, SelectField, TextareaField } from "@/components/ui/form-field";
import { Badge } from "@/components/ui/badge";

export default async function TeamsPage({ searchParams }: { searchParams: Promise<{ error?: string; message?: string }> }) {
  const params = await searchParams;
  const context = await getAppContext();
  const supabase = await createClient();
  const [{ data: teams }, { data: teamMembers }, { data: memberships }] = await Promise.all([
    supabase.from("teams").select("id,name,description,department,office,code,status,is_default,invite_sellers_enabled,max_members,default_dialing_mode").order("name"),
    supabase.from("team_members").select("team_id,user_id,role,is_primary,assignment_paused,daily_lead_limit,joined_at").order("joined_at"),
    supabase.from("tenant_memberships").select("user_id,role,status,profiles:user_id(full_name,last_seen_at)").in("status", ["invited", "active"]).order("created_at"),
  ]);
  const memberInfo = new Map((memberships ?? []).map((membership) => {
    const profile = Array.isArray(membership.profiles) ? membership.profiles[0] : membership.profiles;
    return [membership.user_id, { name: profile?.full_name || "Inbjuden användare", membershipRole: membership.role, status: membership.status }];
  }));
  const managedTeamIds = new Set(context.role === "owner" || context.role === "admin"
    ? (teams ?? []).map((team) => team.id)
    : (teamMembers ?? []).filter((member) => member.user_id === context.userId && member.role === "manager").map((member) => member.team_id));
  const mayCreate = ["owner", "admin", "team_lead"].includes(context.role);

  return <>
    <PageHeader title="Team och säljorganisation" description="Skapa team, utse teamledare, pausa leadtilldelning och sätt kapacitet. Teamledare kan administrera sina egna team och bjuda in säljare." />
    {params.error ? <p className="form-error">{params.error}</p> : null}
    {params.message ? <div className="notice">{params.message}</div> : null}
    <div className={mayCreate ? "split-layout" : "grid"}>
      <div className="grid">
        {(teams ?? []).map((team) => {
          const members = (teamMembers ?? []).filter((member) => member.team_id === team.id);
          const mayManage = managedTeamIds.has(team.id);
          return <Card key={team.id}>
            <CardHeader><h2><Users size={17} /> {team.name}</h2><Badge className={team.status === "active" ? "badge-success" : "badge-warning"}>{members.length}{team.max_members ? ` / ${team.max_members}` : ""}</Badge></CardHeader>
            <CardContent>
              <p className="muted">{team.description ?? "Ingen beskrivning"} · {team.department ?? "Ingen avdelning"} · {team.office ?? "Inget kontor"} · {team.default_dialing_mode === "automatic" ? "automatisk dialer" : "manuell dialer"}</p>
              {mayManage ? <details className="assignment-settings"><summary>Teaminställningar och status</summary><form action={updateTeam} className="form-stack">
                <input type="hidden" name="team_id" value={team.id} />
                <Field label="Teamnamn" name="name" defaultValue={team.name} required />
                <TextareaField label="Beskrivning" name="description" defaultValue={team.description ?? ""} />
                <div className="form-grid"><Field label="Kod" name="code" defaultValue={team.code ?? ""} /><Field label="Avdelning" name="department" defaultValue={team.department ?? ""} /><Field label="Kontor" name="office" defaultValue={team.office ?? ""} /><Field label="Max medlemmar" name="max_members" type="number" min="1" max="10000" defaultValue={team.max_members ?? ""} /><SelectField label="Status" name="status" defaultValue={team.status}><option value="active">Aktivt</option><option value="paused">Pausat</option>{!team.is_default ? <option value="archived">Arkiverat</option> : null}</SelectField><SelectField label="Standarddialer" name="default_dialing_mode" defaultValue={team.default_dialing_mode}><option value="manual">Manuell</option><option value="automatic">Automatisk</option></SelectField></div>
                <label className="check-row"><input type="checkbox" name="invite_sellers_enabled" defaultChecked={team.invite_sellers_enabled} /> Teamledare får bjuda in säljare</label>
                <button className="button button-secondary">Spara teaminställningar</button>
              </form></details> : null}
              <div className="grid">
                {members.map((member) => {
                  const info = memberInfo.get(member.user_id);
                  return <div className="activity-line" key={member.user_id}>
                    <span className="activity-dot"><Users size={14} /></span>
                    <div style={{ flex: 1 }}><strong>{info?.name ?? member.user_id}</strong><p>{info?.membershipRole} · {member.role === "manager" ? "teamledare" : "medlem"}{member.is_primary ? " · primärt team" : ""}{member.assignment_paused ? " · tilldelning pausad" : ""}</p></div>
                    <Badge>{member.daily_lead_limit ? `${member.daily_lead_limit}/dag` : "fri kapacitet"}</Badge>
                    {mayManage && member.user_id !== context.userId ? <form action={removeTeamMember}><input type="hidden" name="team_id" value={team.id} /><input type="hidden" name="user_id" value={member.user_id} /><button className="button button-secondary button-sm">Ta bort</button></form> : null}
                  </div>;
                })}
              </div>
              {mayManage ? <details className="assignment-settings"><summary>Lägg till eller uppdatera medlem</summary><form action={setTeamMember} className="form-stack">
                <input type="hidden" name="team_id" value={team.id} />
                <SelectField label="Tenantmedlem" name="user_id" defaultValue="" required><option value="" disabled>Välj användare</option>{(memberships ?? []).map((membership) => <option key={membership.user_id} value={membership.user_id}>{memberInfo.get(membership.user_id)?.name} · {membership.role}</option>)}</SelectField>
                <div className="form-grid"><SelectField label="Teamroll" name="team_role" defaultValue="member"><option value="member">Medlem</option>{context.role !== "team_lead" ? <option value="manager">Teamledare</option> : null}</SelectField><Field label="Daglig leadgräns" name="daily_lead_limit" type="number" min="1" max="10000" /></div>
                <label className="check-row"><input type="checkbox" name="is_primary" /> Primärt team</label>
                <label className="check-row"><input type="checkbox" name="assignment_paused" /> Pausa automatisk leadtilldelning</label>
                <button className="button button-secondary">Spara teammedlem</button>
              </form></details> : null}
            </CardContent>
          </Card>;
        })}
      </div>
      {mayCreate ? <Card>
        <CardHeader><h2><Plus size={16} /> Nytt team</h2></CardHeader>
        <CardContent><form action={createTeam} className="form-stack">
          <Field label="Teamnamn" name="name" required />
          <TextareaField label="Beskrivning" name="description" />
          <div className="form-grid"><Field label="Kod" name="code" /><Field label="Avdelning" name="department" /><Field label="Kontor" name="office" /><Field label="Max medlemmar" name="max_members" type="number" min="1" max="10000" /><SelectField label="Standarddialer" name="default_dialing_mode" defaultValue="manual"><option value="manual">Manuell</option><option value="automatic">Automatisk</option></SelectField></div>
          <label className="check-row"><input type="checkbox" name="invite_sellers_enabled" defaultChecked /> Teamledare får bjuda in säljare</label>
          <button className="button button-primary">Skapa team</button>
        </form></CardContent>
      </Card> : null}
    </div>
  </>;
}
