import { Blocks, ShieldCheck } from "@/components/icons";
import { createClient } from "@/lib/supabase/server";
import { ModuleOverview } from "@/components/module-overview";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
export default async function SecurityPage(){const s=await createClient();const {data}=await s.from('security_events').select('*').order('created_at',{ascending:false}).limit(30);return <ModuleOverview title="Säkerhet" description="RLS, MFA-stöd, krypterade leverantörshemligheter, audit, sessionskontroll och incidentlogg." icon={ShieldCheck} features={['Tvingad tenantisolering i PostgreSQL RLS','Serverhärledd tenantkontext','AES-256-GCM för provider credentials','Privata storage buckets och signerade länkar','Separat inspelningsbehörighet','Audit och säkerhetshändelser']}><Card><CardHeader><h2><Blocks size={17}/> Senaste säkerhetshändelser</h2><Badge>{data?.length??0}</Badge></CardHeader><CardContent>{data?.map(e=><div className="activity-line" key={e.id}><span className="activity-dot"><ShieldCheck size={14}/></span><div><strong>{e.event_type}</strong><p>{e.severity}</p></div><time>{formatDate(e.created_at)}</time></div>)}</CardContent></Card></ModuleOverview>}
