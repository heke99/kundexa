import { ListFilter } from "@/components/icons";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
export default async function ListsPage(){const s=await createClient();const {data}=await s.from('customer_lists').select('*,customer_list_members(count),teams(name)').order('created_at',{ascending:false});return <><PageHeader title="Listor" description="Statiska, dynamiska, kampanj-, återuppringnings-, förnyelse- och spärrlistor."/><Card><CardHeader><h2><ListFilter size={17}/> Sparade listor</h2><Badge>{data?.length??0}</Badge></CardHeader><CardContent style={{padding:0}}><DataTable headers={['Lista','Typ','Team','Filter','Låst','Skapad']}>{data?.map(x=>{const team=Array.isArray(x.teams)?x.teams[0]:x.teams;return <tr key={x.id}><td><strong>{x.name}</strong><br/><span className="muted">{x.description??'—'}</span></td><td>{x.list_type}</td><td>{team?.name??'Hela organisationen'}</td><td><code>{Object.keys(x.filter_definition??{}).length} villkor</code></td><td>{x.is_locked?'Ja':'Nej'}</td><td>{formatDate(x.created_at)}</td></tr>})}</DataTable><div className="notice" style={{margin:18}}>Dynamiska listor lagrar filterdefinitionen, inte kopior av kunddata. Medlemmar kan materialiseras för kampanjer och export.</div></CardContent></Card></>}
