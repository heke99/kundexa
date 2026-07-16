import Link from "next/link";
import { BookUser } from "@/components/icons";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
export default async function ProspectsPage(){const s=await createClient();const {data}=await s.from('customers').select('*').in('lifecycle',['prospect','lead']).is('deleted_at',null).order('next_activity_at',{ascending:true,nullsFirst:false});return <><PageHeader title="Prospekt" description="Arbetslistan för nya, tilldelade och pågående leads."/><Card><CardHeader><h2><BookUser size={17}/> Prospekt och leads</h2><Badge>{data?.length??0}</Badge></CardHeader><CardContent style={{padding:0}}><DataTable headers={['Prospekt','Typ','Telefon','Ort','Försök','Nästa aktivitet','Spärr']}>{data?.map(c=><tr key={c.id}><td><Link href={`/app/customers/${c.id}`}><strong>{c.display_name}</strong></Link></td><td>{c.customer_type}</td><td>{c.phone_e164??'—'}</td><td>{c.city??'—'}</td><td>{c.call_attempts}</td><td>{formatDate(c.next_activity_at)}</td><td><Badge className={c.do_not_call?'badge-danger':'badge-success'}>{c.do_not_call?'Spärrad':'Tillåten'}</Badge></td></tr>)}</DataTable></CardContent></Card></>}
