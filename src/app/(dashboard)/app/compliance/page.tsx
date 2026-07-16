import { ShieldCheck } from "@/components/icons";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
export default async function CompliancePage(){const s=await createClient();const {data}=await s.from('compliance_blocks').select('*,customers(display_name)').eq('active',true).order('created_at',{ascending:false});return <><PageHeader title="Spärrar och compliance" description="Central kontroll före samtal, SMS, e-post, kampanjtilldelning, automation och export."/><Card><CardHeader><h2><ShieldCheck size={17}/> Aktiva spärrar</h2><Badge className="badge-danger">{data?.length??0}</Badge></CardHeader><CardContent style={{padding:0}}><DataTable headers={['Kund / kontakt','Kanaler','Orsak','Källa','Gäller till','Skapad']}>{data?.map(b=>{const c=Array.isArray(b.customers)?b.customers[0]:b.customers;return <tr key={b.id}><td><strong>{c?.display_name??b.phone_e164??b.email??'Okänd'}</strong></td><td>{b.channels.join(', ')}</td><td>{b.reason}</td><td>{b.source}</td><td>{formatDate(b.expires_at)}</td><td>{formatDate(b.created_at)}</td></tr>})}</DataTable></CardContent></Card></>}
