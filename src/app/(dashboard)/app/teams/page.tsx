import { Plus, Users } from "@/components/icons";
import { createClient } from "@/lib/supabase/server";
import { createTeam } from "@/app/actions/admin";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { Field } from "@/components/ui/form-field";
import { Badge } from "@/components/ui/badge";
export default async function TeamsPage(){const s=await createClient();const {data}=await s.from('teams').select('*,team_members(count)').order('name');return <><PageHeader title="Team" description="Separata team, avdelningar, kontor, kapacitet och featureinställningar."/><div className="split-layout"><Card><CardHeader><h2><Users size={17}/> Team</h2><Badge>{data?.length??0}</Badge></CardHeader><CardContent style={{padding:0}}><DataTable headers={['Team','Avdelning','Kontor','Standard','Inställningar']}>{data?.map(t=><tr key={t.id}><td><strong>{t.name}</strong><br/><span className="muted">{t.description??'—'}</span></td><td>{t.department??'—'}</td><td>{t.office??'—'}</td><td>{t.is_default?'Ja':'Nej'}</td><td>{Object.keys(t.settings??{}).length}</td></tr>)}</DataTable></CardContent></Card><Card><CardHeader><h2><Plus size={16}/> Nytt team</h2></CardHeader><CardContent><form action={createTeam} className="form-stack"><Field label="Teamnamn" name="name" required/><Field label="Beskrivning" name="description"/><Field label="Avdelning" name="department"/><Field label="Kontor" name="office"/><button className="button button-primary">Skapa team</button></form></CardContent></Card></div></>}
