import { PhoneForwarded } from "@/components/icons";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { Badge } from "@/components/ui/badge";
export default async function QueuesPage(){const s=await createClient();const {data}=await s.from('call_queues').select('*,queue_members(count)').order('name');return <><PageHeader title="Samtalsköer" description="Inkommande routing, round-robin, väntetid, overflow och röstbrevlåda."/><Card><CardHeader><h2><PhoneForwarded size={17}/> Köer</h2><Badge>{data?.length??0}</Badge></CardHeader><CardContent style={{padding:0}}><DataTable headers={['Kö','Strategi','Max väntan','Röstbrevlåda','Konfiguration']}>{data?.map(q=><tr key={q.id}><td><strong>{q.name}</strong></td><td>{q.strategy}</td><td>{q.max_wait_seconds} sek</td><td>{q.voicemail_enabled?'Aktiv':'Av'}</td><td>{Object.keys(q.configuration??{}).length} inställningar</td></tr>)}</DataTable></CardContent></Card></>}
