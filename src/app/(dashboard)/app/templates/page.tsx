import { ScrollText } from "@/components/icons";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { Badge } from "@/components/ui/badge";
export default async function TemplatesPage(){const s=await createClient();const {data}=await s.from('contract_templates').select('*,contract_template_versions(version,created_at)').order('name');return <><PageHeader title="Avtalsmallar" description="Separata B2B/B2C-mallar, dynamiska variabler, bilagor och versionshistorik."/><Card><CardHeader><h2><ScrollText size={17}/> Mallar</h2><Badge>{data?.length??0}</Badge></CardHeader><CardContent style={{padding:0}}><DataTable headers={['Mall','Typ','Målgrupp','Versioner','Status']}>{data?.map(t=><tr key={t.id}><td><strong>{t.name}</strong></td><td>{t.contract_type}</td><td>{t.audience}</td><td>{Array.isArray(t.contract_template_versions)?t.contract_template_versions.length:0}</td><td><Badge className={t.active?'badge-success':''}>{t.active?'Aktiv':'Inaktiv'}</Badge></td></tr>)}</DataTable></CardContent></Card></>}
