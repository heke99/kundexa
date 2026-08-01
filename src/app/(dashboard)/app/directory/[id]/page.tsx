import { notFound } from "next/navigation";
import { getAppContext } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { isJsonObject } from "@/lib/supabase/json";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";

interface DirectoryEntityProjection {
  canonical_name: string | null;
  organization_number: string | null;
  city: string | null;
  fresh_until: string | null;
}

interface VisibleDirectoryField {
  field_key: string;
  field_value: unknown;
  confidence: number;
  verified_at: string | null;
  fresh_until: string | null;
}

function projectionFrom(value: unknown): DirectoryEntityProjection | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!isJsonObject(candidate)) return null;
  return {
    canonical_name: typeof candidate.canonical_name === "string" ? candidate.canonical_name : null,
    organization_number: typeof candidate.organization_number === "string" ? candidate.organization_number : null,
    city: typeof candidate.city === "string" ? candidate.city : null,
    fresh_until: typeof candidate.fresh_until === "string" ? candidate.fresh_until : null,
  };
}

function visibleFieldsFrom(value: unknown): VisibleDirectoryField[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isJsonObject(entry) || typeof entry.field_key !== "string") return [];
    return [{
      field_key: entry.field_key,
      field_value: entry.field_value,
      confidence: typeof entry.confidence === "number" ? entry.confidence : Number(entry.confidence ?? 0),
      verified_at: typeof entry.verified_at === "string" ? entry.verified_at : null,
      fresh_until: typeof entry.fresh_until === "string" ? entry.fresh_until : null,
    }];
  });
}

export default async function DirectoryEntityPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const context = await getAppContext();
  const admin = createAdminClient();
  const [
    { data: entityProjection },
    { data: visibleFields },
    { data: freshness },
    { data: quality },
    { data: conflicts },
  ] = await Promise.all([
    admin.rpc("directory_entity_projection_for_tenant", { p_tenant_id: context.tenantId, p_entity_id: id }),
    admin.rpc("directory_visible_fields_for_tenant", { p_tenant_id: context.tenantId, p_entity_id: id }),
    admin.from("field_freshness").select("*").eq("master_entity_id", id),
    admin.from("data_quality_scores").select("*").eq("master_entity_id", id).maybeSingle(),
    admin.from("data_conflicts").select("id,field_key,candidate_values,status,created_at").eq("master_entity_id", id).order("created_at", { ascending: false }),
  ]);

  const entity = projectionFrom(entityProjection);
  if (!entity) notFound();
  const fields = visibleFieldsFrom(visibleFields);
  const isFresh = Boolean(entity.fresh_until && new Date(entity.fresh_until) > new Date());

  return <>
    <PageHeader title={entity.canonical_name ?? "Licensierad katalogpost"} description="Licensfiltrerad masterdata med källa, freshness, historik och datakvalitet." />
    <div className="grid grid-4">
      <Card><CardContent><strong>{entity.organization_number ?? "—"}</strong><div className="muted">Organisationsnummer</div></CardContent></Card>
      <Card><CardContent><strong>{entity.city ?? "—"}</strong><div className="muted">Ort</div></CardContent></Card>
      <Card><CardContent><strong>{Math.round(Number(quality?.overall ?? 0))}/100</strong><div className="muted">Datakvalitet</div></CardContent></Card>
      <Card><CardContent><Badge className={isFresh ? "badge-success" : ""}>{isFresh ? "fresh" : "stale"}</Badge><div className="muted">Till {formatDate(entity.fresh_until)}</div></CardContent></Card>
    </div>
    <Card><CardHeader><h2>Visningsbara fält</h2><Badge>{fields.length}</Badge></CardHeader><CardContent style={{ padding: 0 }}>
      <DataTable headers={["Fält", "Värde", "Säkerhet", "Verifierat", "Giltigt till"]}>
        {fields.map((field) => <tr key={field.field_key}>
          <td><strong>{field.field_key}</strong></td>
          <td>{typeof field.field_value === "string" ? field.field_value : JSON.stringify(field.field_value)}</td>
          <td>{Math.round(Number(field.confidence) * 100)}%</td>
          <td>{formatDate(field.verified_at)}</td>
          <td>{formatDate(field.fresh_until)}</td>
        </tr>)}
      </DataTable>
    </CardContent></Card>
    <Card><CardHeader><h2>Freshness per fält</h2></CardHeader><CardContent style={{ padding: 0 }}>
      <DataTable headers={["Fält", "Status", "Verifierat", "Nästa kontroll"]}>
        {freshness?.map((field) => <tr key={field.field_key}><td>{field.field_key}</td><td><Badge>{field.state}</Badge></td><td>{formatDate(field.verified_at)}</td><td>{formatDate(field.next_refresh_at)}</td></tr>)}
      </DataTable>
    </CardContent></Card>
    {conflicts?.length ? <Card><CardHeader><h2>Öppna datakonflikter</h2><Badge className="badge-danger">{conflicts.length}</Badge></CardHeader><CardContent style={{ padding: 0 }}>
      <DataTable headers={["Fält", "Kandidater", "Status", "Skapad"]}>
        {conflicts.map((conflict) => <tr key={conflict.id}><td>{conflict.field_key}</td><td><pre>{JSON.stringify(conflict.candidate_values, null, 2)}</pre></td><td>{conflict.status}</td><td>{formatDate(conflict.created_at)}</td></tr>)}
      </DataTable>
    </CardContent></Card> : null}
  </>;
}
