import Link from "next/link";
import { redirect } from "next/navigation";
import { Import, ListFilter, ShieldCheck } from "@/components/icons";
import { getPlatformContext, isPlatformAdmin } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { allocatePlatformList, revokePlatformAllocation } from "@/app/actions/platform-lists";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Field, SelectField, TextareaField } from "@/components/ui/form-field";
import { DataTable } from "@/components/ui/data-table";
import { formatDate } from "@/lib/utils";

export default async function PlatformListsPage({ searchParams }: { searchParams: Promise<{ error?: string; message?: string }> }) {
  const params = await searchParams;
  const context = await getPlatformContext();
  if (!context.platformRole) redirect("/app");
  const admin = createAdminClient();
  const [{ data: lists }, { data: tenants }, { data: allocations }] = await Promise.all([
    admin.from("platform_lists").select("id,name,description,source_provider,status,exclusivity_mode,total_entries,available_entries,allocated_entries,consumed_entries,created_at").order("created_at", { ascending: false }),
    admin.from("tenants").select("id,name,legal_name,status").in("status", ["trial", "active"]).order("name"),
    admin.from("platform_list_allocations").select("id,platform_list_id,tenant_id,target_list_id,name,status,allocated_count,exclusivity_mode,created_at,revoke_reason").order("created_at", { ascending: false }).limit(100),
  ]);
  const listNames = new Map((lists ?? []).map((list) => [list.id, list.name]));
  const tenantNames = new Map((tenants ?? []).map((tenant) => [tenant.id, tenant.name]));
  const mayWrite = isPlatformAdmin(context.platformRole);

  return <>
    <PageHeader
      title="Central listbank"
      description="Importera plattformsägda prospekt, fördela exklusiva eller delade urval till tenants och behåll full spårbarhet. Tenantens kopia materialiseras i deras vanliga CRM- och dialerflöde."
      action={<Link href="/app/platform" className="button button-secondary">Till plattformsadmin</Link>}
    />
    {params.error ? <p className="form-error">{params.error}</p> : null}
    {params.message ? <div className="notice">{params.message}</div> : null}

    {mayWrite ? <div className="split-layout">
      <Card>
        <CardHeader><h2><Import size={17} /> Importera central lista</h2><Badge>CSV · JSON · XLSX</Badge></CardHeader>
        <CardContent>
          <form action="/api/v1/platform/lists/import" method="post" encType="multipart/form-data" className="form-stack">
            <Field label="Listnamn" name="name" required placeholder="Allabolag · Malmö · juli 2026" />
            <TextareaField label="Beskrivning" name="description" />
            <div className="form-grid">
              <Field label="Källa" name="source_provider" defaultValue="file" placeholder="ParseHub, Allabolag, Merinfo" />
              <Field label="Källwebbplats" name="source_website" placeholder="allabolag.se" />
              <SelectField label="Exklusivitet" name="exclusivity_mode" defaultValue="exclusive">
                <option value="exclusive">Exklusiv per aktiv tenanttilldelning</option>
                <option value="time_limited">Tidsbegränsat exklusiv</option>
                <option value="shared">Kan delas till flera tenants</option>
              </SelectField>
              <Field label="Standarddagar för tidsbegränsning" name="default_exclusive_days" type="number" min="1" max="3650" defaultValue="30" />
              <Field label="JSON records path" name="records_path" placeholder="data.companies" />
              <Field label="Excel-arbetsblad" name="worksheet_name" placeholder="Företag" />
              <Field label="Rubrikrad" name="header_row" type="number" min="1" max="100" defaultValue="1" />
            </div>
            <label className="field"><span>Fil</span><input type="file" name="file" accept=".csv,.json,.jsonl,.ndjson,.xlsx,text/csv,application/json,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required /></label>
            <button className="button button-primary"><Import size={16} /> Importera till listbanken</button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><h2><ShieldCheck size={17} /> Tilldela till tenant</h2></CardHeader>
        <CardContent>
          <form action={allocatePlatformList} className="form-stack">
            <SelectField label="Central lista" name="platform_list_id" defaultValue="" required>
              <option value="" disabled>Välj lista</option>
              {(lists ?? []).filter((list) => list.status === "active" && Number(list.available_entries) > 0).map((list) => <option key={list.id} value={list.id}>{list.name} · {list.available_entries} tillgängliga</option>)}
            </SelectField>
            <SelectField label="Tenant" name="tenant_id" defaultValue="" required>
              <option value="" disabled>Välj tenant</option>
              {(tenants ?? []).map((tenant) => <option key={tenant.id} value={tenant.id}>{tenant.name} · {tenant.legal_name}</option>)}
            </SelectField>
            <Field label="Namn i tenantens system" name="name" required placeholder="Malmö företag · teamfördelning" />
            <div className="form-grid">
              <Field label="Antal" name="count" type="number" min="1" max="1000000" required />
              <SelectField label="Exklusivitet" name="exclusivity_mode" defaultValue="exclusive"><option value="exclusive">Exklusiv</option><option value="time_limited">Tidsbegränsad</option><option value="shared">Delad</option></SelectField>
              <Field label="Ort" name="city" />
              <Field label="Kommun" name="municipality" />
              <Field label="Län" name="county" />
              <Field label="Bransch innehåller" name="industry" />
              <Field label="Postnummer börjar med" name="postal_prefix" />
              <Field label="Min anställda" name="min_employees" type="number" min="0" />
              <Field label="Max anställda" name="max_employees" type="number" min="0" />
            </div>
            <button className="button button-primary">Materialisera och tilldela</button>
          </form>
        </CardContent>
      </Card>
    </div> : null}

    <Card>
      <CardHeader><h2><ListFilter size={17} /> Plattformslistor</h2><Badge>{lists?.length ?? 0}</Badge></CardHeader>
      <CardContent style={{ padding: 0 }}>
        <DataTable headers={["Lista", "Källa", "Exklusivitet", "Totalt", "Tillgängliga", "Aktivt tilldelade", "Bearbetade", "Status"]}>
          {(lists ?? []).map((list) => <tr key={list.id}>
            <td><strong>{list.name}</strong><br /><span className="muted">{list.description ?? formatDate(list.created_at)}</span></td>
            <td>{list.source_provider}</td><td>{list.exclusivity_mode}</td><td>{list.total_entries}</td><td>{list.available_entries}</td><td>{list.allocated_entries}</td><td>{list.consumed_entries}</td>
            <td><Badge className={list.status === "active" ? "badge-success" : "badge-warning"}>{list.status}</Badge></td>
          </tr>)}
        </DataTable>
      </CardContent>
    </Card>

    <Card>
      <CardHeader><h2>Senaste tenanttilldelningar</h2><Badge>{allocations?.length ?? 0}</Badge></CardHeader>
      <CardContent>
        {(allocations ?? []).map((allocation) => <div className="activity-line" key={allocation.id}>
          <span className="activity-dot"><ShieldCheck size={14} /></span>
          <div style={{ flex: 1 }}><strong>{allocation.name}</strong><p>{listNames.get(allocation.platform_list_id) ?? "Lista"} → {tenantNames.get(allocation.tenant_id) ?? "Tenant"} · {allocation.allocated_count} poster · {allocation.exclusivity_mode}</p></div>
          <Badge className={allocation.status === "active" ? "badge-success" : "badge-warning"}>{allocation.status}</Badge>
          {mayWrite && allocation.status === "active" ? <form action={revokePlatformAllocation} className="form-stack" style={{ minWidth: 220 }}>
            <input type="hidden" name="allocation_id" value={allocation.id} />
            <input name="reason" minLength={5} required placeholder="Anledning till återkallelse" />
            <button className="button button-secondary button-sm">Återkalla obearbetade</button>
          </form> : null}
        </div>)}
      </CardContent>
    </Card>
  </>;
}
