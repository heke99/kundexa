import { ClipboardList } from "@/components/icons";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { Badge } from "@/components/ui/badge";
export default async function DataSourcesPage(){const s=await createClient();const {data}=await s.from('data_providers').select('*').order('name');return <><PageHeader title="Datakällor" description="Generell adaptermodell för Merinfo, Bolagsverket, SCB, geokodning och kundens egna register."/><Card><CardHeader><h2><ClipboardList size={17}/> Leverantörer</h2><Badge>{data?.length??0}</Badge></CardHeader><CardContent style={{padding:0}}><DataTable headers={['Leverantör','Namn','Status','Fältmappning','Licensregler']}>{data?.map(d=><tr key={d.id}><td><strong>{d.provider}</strong></td><td>{d.name}</td><td><Badge className={d.status==='active'?'badge-success':''}>{d.status}</Badge></td><td>{Object.keys(d.field_mapping??{}).length}</td><td>{Object.keys(d.license_terms??{}).length}</td></tr>)}</DataTable><div className="notice warning" style={{margin:18}}>Merinfo ska anslutas genom avtalat API eller filleverans. Kundexa innehåller ingen webbskrapning.</div></CardContent></Card></>}
