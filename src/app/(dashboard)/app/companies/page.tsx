import Link from "next/link";
import { Building2 } from "@/components/icons";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/utils";
export default async function CompaniesPage(){const s=await createClient();const {data}=await s.from('customers').select('*').eq('customer_type','company').is('deleted_at',null).order('display_name');return <><PageHeader title="Företag" description="Företagskunder och prospekt med organisation, SNI, ekonomi och kontaktpersoner."/><Card><CardHeader><h2><Building2 size={17}/> Företagsregister</h2><Badge>{data?.length??0}</Badge></CardHeader><CardContent style={{padding:0}}><DataTable headers={['Företag','Org.nr','Bransch / SNI','Ort','Omsättning','Anställda','Status']}>{data?.map(c=><tr key={c.id}><td><Link href={`/app/customers/${c.id}`}><strong>{c.display_name}</strong></Link></td><td>{c.organization_number??'—'}</td><td>{[c.industry,c.sni_code].filter(Boolean).join(' / ')||'—'}</td><td>{c.city??'—'}</td><td>{c.revenue?formatCurrency(Number(c.revenue)):'—'}</td><td>{c.employee_count??'—'}</td><td><Badge>{c.lifecycle}</Badge></td></tr>)}</DataTable></CardContent></Card></>}
