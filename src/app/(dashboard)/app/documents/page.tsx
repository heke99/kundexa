import { FileText } from "@/components/icons";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
export default async function DocumentsPage(){const s=await createClient();const {data}=await s.from('contract_documents').select('*,contracts(contract_number,title)').order('created_at',{ascending:false}).limit(150);return <><PageHeader title="PDF-dokument" description="Privat objektlagring, SHA-256, signerade länkar och koppling till exakt avtalsversion."/><Card><CardHeader><h2><FileText size={17}/> Dokumentregister</h2><Badge>{data?.length??0}</Badge></CardHeader><CardContent style={{padding:0}}><DataTable headers={['Dokument','Avtal','Typ','Storlek','SHA-256','Skapat']}>{data?.map(d=>{const c=Array.isArray(d.contracts)?d.contracts[0]:d.contracts;return <tr key={d.id}><td><strong>{d.file_name}</strong></td><td>{c?.contract_number??'—'}</td><td>{d.document_type}</td><td>{d.size_bytes?`${Math.round(d.size_bytes/1024)} KB`:'—'}</td><td><code>{d.sha256.slice(0,16)}…</code></td><td>{formatDate(d.created_at)}</td></tr>})}</DataTable></CardContent></Card></>}
