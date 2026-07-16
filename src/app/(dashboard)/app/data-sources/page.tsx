import { ClipboardList } from "@/components/icons";
import { createClient } from "@/lib/supabase/server";
import { getAppContext, isAdmin } from "@/lib/auth";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { Badge } from "@/components/ui/badge";
import { Field, SelectField, TextareaField } from "@/components/ui/form-field";
import { configureGenericJsonProvider } from "@/app/actions/admin";
import { formatDate } from "@/lib/utils";

export default async function DataSourcesPage({ searchParams }: { searchParams: Promise<{ error?: string; message?: string }> }) {
  const params = await searchParams;
  const context = await getAppContext();
  const supabase = await createClient();
  const [{ data: providers }, { data: accounts }, { data: permissions }, { data: jobs }] = await Promise.all([
    supabase.from("data_providers").select("id,provider,name,status,adapter_key,integration_type,cache_scope,field_mapping,updated_at").order("name"),
    supabase.from("provider_accounts").select("id,data_provider_id,name,status,configuration,updated_at").order("created_at", { ascending: false }),
    supabase.from("provider_permissions").select("id,data_provider_id,permission_name,status,cache_scope,allowed_domains,allowed_entity_types,raw_storage_allowed,tenant_display_allowed,expires_at").order("created_at", { ascending: false }),
    supabase.from("enrichment_jobs").select("id,status,estimated_cost,actual_cost,last_error,created_at,completed_at").order("created_at", { ascending: false }).limit(10),
  ]);
  const accountByProvider = new Map((accounts ?? []).map((account) => [account.data_provider_id, account]));
  const permissionByProvider = new Map((permissions ?? []).map((permission) => [permission.data_provider_id, permission]));

  return <>
    <PageHeader title="Datakällor" description="Licensstyrda provideradaptrar, kvoter, fältregler, rådata och 20-dagars freshness utan dubbla externa anrop." />
    {params.error ? <p className="form-error">{params.error}</p> : null}
    {params.message ? <div className="notice success">{params.message}</div> : null}
    <div className="grid">
      <Card>
        <CardHeader><h2><ClipboardList size={17} /> Leverantörer och tillstånd</h2><Badge>{providers?.length ?? 0}</Badge></CardHeader>
        <CardContent style={{ padding: 0 }}>
          <DataTable headers={["Leverantör", "Adapter", "Konto", "Cache", "Tillstånd", "Fält", "Uppdaterad"]}>
            {providers?.map((provider) => {
              const account = accountByProvider.get(provider.id);
              const permission = permissionByProvider.get(provider.id);
              return <tr key={provider.id}>
                <td><strong>{provider.name}</strong><div className="muted">{provider.provider}</div></td>
                <td>{provider.adapter_key ?? "—"}<div className="muted">{provider.integration_type}</div></td>
                <td><Badge className={account?.status === "active" ? "badge-success" : ""}>{account?.status ?? "saknas"}</Badge></td>
                <td>{provider.cache_scope}</td>
                <td><Badge className={permission?.status === "active" ? "badge-success" : "badge-danger"}>{permission?.status ?? "saknas"}</Badge><div className="muted">{permission?.allowed_domains?.join(", ") ?? ""}</div></td>
                <td>{Object.keys(provider.field_mapping ?? {}).length}</td>
                <td>{formatDate(provider.updated_at)}</td>
              </tr>;
            })}
          </DataTable>
          <div className="notice warning" style={{ margin: 18 }}>
            API och strukturerad filöverföring ska användas först. Skrapning kräver ett separat granskat adapterpaket och ett dokumenterat tillstånd; formuläret nedan aktiverar inte skrapning.
          </div>
        </CardContent>
      </Card>

      {isAdmin(context.role) ? <Card>
        <CardHeader><h2>Konfigurera JSON-API</h2><Badge>Atomisk</Badge></CardHeader>
        <CardContent>
          <form action={configureGenericJsonProvider} className="form-stack">
            <div className="grid grid-2">
              <Field label="Leverantörsnyckel" name="provider" placeholder="merinfo" required />
              <Field label="Visningsnamn" name="name" placeholder="Merinfo API" required />
              <Field label="Tillståndets namn" name="permission_name" placeholder="Produktionsavtal 2026" required />
              <SelectField label="HTTP-metod" name="method" defaultValue="GET"><option>GET</option><option>POST</option></SelectField>
            </div>
            <Field label="Endpoint-mall" name="endpoint_template" placeholder="https://api.exempel.se/v1/company/{{external_identifier}}" required hint="Måste vara HTTPS och innehålla {{external_identifier}} eller {{organization_number}}." />
            <div className="grid grid-2">
              <Field label="Tillåtna domäner" name="allowed_domains" placeholder="api.exempel.se" required />
              <Field label="Tillåtna sökvägar" name="allowed_paths" placeholder="/v1/company" />
              <Field label="API-nyckel" name="api_key" type="password" hint="Lämna tomt vid uppdatering för att behålla befintlig nyckel." />
              <Field label="API-key header" name="api_key_header" defaultValue="Authorization" />
            </div>
            <TextareaField label="Fältmappning (JSON)" name="field_mapping" required rows={8} defaultValue={'{\n  "canonical_name": "name",\n  "organization_number": "organizationNumber",\n  "phone_e164": "phone",\n  "email": "email",\n  "city": "address.city",\n  "sni_code": "industry.sni"\n}'} />
            <div className="grid grid-2">
              <SelectField label="Cacheomfattning" name="cache_scope" defaultValue="tenant">
                <option value="tenant">Endast tenant</option><option value="provider_account">Leverantörskonto</option><option value="global">Global</option><option value="one_time">Engångsflöde</option>
              </SelectField>
              <Field label="Tillåtna ändamål" name="allowed_purposes" defaultValue="crm_refresh,contract_verification" />
              <Field label="Skriftligt godkännande / avtalsreferens" name="written_approval_reference" placeholder="Avtal 2026-07-16" />
              <Field label="Rådataretention, dagar" name="retention_days" type="number" min="0" defaultValue="30" />
              <Field label="Freshness TTL, dagar" name="ttl_days" type="number" min="0" max="3650" defaultValue="20" />
              <Field label="Beräknad kostnad per anrop" name="estimated_cost_per_call" type="number" min="0" step="0.0001" defaultValue="0" />
            </div>
            <fieldset className="field"><span>Entitetstyper</span><label><input type="checkbox" name="entity_types" value="organization" defaultChecked /> Företag</label><label><input type="checkbox" name="entity_types" value="establishment" /> Arbetsställen</label><label><input type="checkbox" name="entity_types" value="person" /> Privatpersoner</label></fieldset>
            <fieldset className="field"><span>Licensrättigheter</span><label><input type="checkbox" name="tenant_display_allowed" defaultChecked /> Visa fälten i tenantens katalog</label><label><input type="checkbox" name="raw_storage_allowed" /> Lagra krypterad rådata</label><label><input type="checkbox" name="cross_tenant_reuse_allowed" /> Tillåt uttryckligen återanvändning mellan tenants</label><label><input type="checkbox" name="export_allowed" /> Tillåt export</label><label><input type="checkbox" name="attribution_required" /> Kräv källangivelse</label></fieldset>
            <div className="grid grid-2">
              <Field label="Kvot per fönster" name="quota_units" type="number" min="1" defaultValue="5000" />
              <Field label="Kvotfönster, sekunder" name="quota_window_seconds" type="number" min="1" defaultValue="432000" hint="432000 = fem dagar." />
              <Field label="Max samtidighet" name="max_concurrency" type="number" min="1" defaultValue="1" />
              <Field label="Minsta fördröjning, ms" name="minimum_delay_ms" type="number" min="0" defaultValue="250" />
              <Field label="Timeout, ms" name="timeout_ms" type="number" min="1000" max="120000" defaultValue="30000" />
              <Field label="Max återförsök" name="max_retries" type="number" min="0" max="20" defaultValue="5" />
            </div>
            <button className="button button-primary">Spara leverantör och tillstånd</button>
          </form>
        </CardContent>
      </Card> : null}

      <Card>
        <CardHeader><h2>Senaste berikningsjobb</h2><Badge>{jobs?.length ?? 0}</Badge></CardHeader>
        <CardContent style={{ padding: 0 }}>
          <DataTable headers={["Status", "Skapad", "Kostnad", "Slutförd", "Fel"]}>
            {jobs?.map((job) => <tr key={job.id}><td><Badge className={job.status === "completed" ? "badge-success" : job.status === "failed" ? "badge-danger" : ""}>{job.status}</Badge></td><td>{formatDate(job.created_at)}</td><td>{Number(job.actual_cost ?? job.estimated_cost ?? 0).toFixed(2)}</td><td>{formatDate(job.completed_at)}</td><td>{job.last_error ?? "—"}</td></tr>)}
          </DataTable>
        </CardContent>
      </Card>
    </div>
  </>;
}
