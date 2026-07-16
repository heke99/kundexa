import { KeyRound } from "@/components/icons";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { Badge } from "@/components/ui/badge";
import { ApiKeyCreator } from "@/components/api-key-creator";
import { formatDate } from "@/lib/utils";
export default async function ApiPage(){const s=await createClient();const {data}=await s.from('api_keys').select('id,name,key_prefix,scopes,rate_limit_per_minute,last_used_at,expires_at,revoked_at').order('created_at',{ascending:false});return <><PageHeader title="API" description="Versionshanterat tenant-API med hashade nycklar, scopes, rate limits, idempotens och audit."/><div className="split-layout"><Card><CardHeader><h2><KeyRound size={17}/> API-nycklar</h2><Badge>{data?.length??0}</Badge></CardHeader><CardContent style={{padding:0}}><DataTable headers={['Namn','Prefix','Scopes','Rate limit','Senast använd','Status']}>{data?.map(k=><tr key={k.id}><td><strong>{k.name}</strong></td><td><code>{k.key_prefix}…</code></td><td>{k.scopes.join(', ')}</td><td>{k.rate_limit_per_minute}/min</td><td>{formatDate(k.last_used_at)}</td><td><Badge className={k.revoked_at?'badge-danger':'badge-success'}>{k.revoked_at?'Återkallad':'Aktiv'}</Badge></td></tr>)}</DataTable></CardContent></Card><Card><CardHeader><h2>Skapa nyckel</h2></CardHeader><CardContent><ApiKeyCreator/><p style={{marginTop:18}}><a className="button button-secondary" href="/api/openapi.json" target="_blank" rel="noreferrer">Öppna OpenAPI 3.1</a></p><div className="code" style={{marginTop:18}}>curl -H &quot;Authorization: Bearer kx_live_...&quot; \
  https://app.example.com/api/v1/customers</div></CardContent></Card></div></>}
