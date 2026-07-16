import { Activity, CalendarCheck2 } from "@/components/icons";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
export default async function ActivitiesPage(){const s=await createClient();const {data}=await s.from('activities').select('*,customers(display_name)').order('due_at',{ascending:true,nullsFirst:false}).limit(150);return <><PageHeader title="Aktiviteter" description="Uppgifter, återuppringningar, möten, förnyelser och onboarding."/><Card><CardHeader><h2><CalendarCheck2 size={17}/> Arbetslista</h2><Badge>{data?.filter(x=>x.status!=='completed').length??0} öppna</Badge></CardHeader><CardContent>{data?.map(a=>{const c=Array.isArray(a.customers)?a.customers[0]:a.customers;return <div className="activity-line" key={a.id}><span className="activity-dot"><Activity size={14}/></span><div><strong>{a.title}</strong><p>{c?.display_name??'Ingen kund'} · {a.type} · {a.priority}</p></div><div style={{textAlign:'right'}}><Badge className={a.status==='completed'?'badge-success':''}>{a.status}</Badge><br/><time>{formatDate(a.due_at)}</time></div></div>})}</CardContent></Card></>}
