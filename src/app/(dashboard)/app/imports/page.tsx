import Link from "next/link";
import { Import, Upload } from "@/components/icons";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";

function statusClass(status: string) {
  if (["completed", "completed_with_warnings"].includes(status)) return "badge-success";
  if (["failed", "cancelled"].includes(status)) return "badge-danger";
  if (["mapping_required", "preview_ready", "validated"].includes(status)) return "badge-warning";
  return "badge-info";
}

export default async function ImportsPage({ searchParams }: { searchParams: Promise<{ error?: string; message?: string }> }) {
  const params = await searchParams;
  const supabase = await createClient();
  const { data } = await supabase.from("import_runs").select("id,name,source_type,source_provider,source_website,scan_status,status,total_rows,new_count,updated_count,unchanged_count,new_contact_count,updated_contact_count,blocked_count,warning_count,error_count,created_at").order("created_at", { ascending: false }).limit(100);
  return <>
    <PageHeader
      title="Importer"
      description="ParseHub-, JSON-, CSV- och Excel-import med versionsstyrd mappning, säker upsert, kontaktpersoner, compliance och listkoppling."
      action={<div style={{ display: "flex", gap: 8 }}><Link className="button button-secondary" href="/app/imports/profiles">Importprofiler</Link><Link className="button button-secondary" href="/app/imports/parsehub">ParseHub</Link><Link className="button button-primary" href="/app/imports/new"><Upload size={16} /> Ny import</Link></div>}
    />
    {params.error ? <p className="form-error">{params.error}</p> : null}
    {params.message ? <p className="notice">{params.message}</p> : null}
    <Card>
      <CardHeader><h2><Import size={17} /> Importkörningar</h2><Badge>{data?.length ?? 0}</Badge></CardHeader>
      <CardContent style={{ padding: 0 }}>
        <DataTable headers={["Import", "Källa", "Status", "Rader", "Nya", "Uppdaterade", "Kontakter", "Blockerade", "Varningar", "Fel", "Datum"]}>
          {data?.map((run) => <tr key={run.id}>
            <td><Link href={`/app/imports/${run.id}`}><strong>{run.name}</strong></Link></td>
            <td>{run.source_provider}{run.source_website ? ` · ${run.source_website}` : ""}<br /><small>{run.source_type}</small></td>
            <td><Badge className={statusClass(run.status)}>{run.status}</Badge><br /><small>scan: {run.scan_status}</small></td>
            <td>{run.total_rows}</td>
            <td>{run.new_count}</td>
            <td>{run.updated_count}<br /><small>{run.unchanged_count} oförändrade</small></td>
            <td>{run.new_contact_count + run.updated_contact_count}</td>
            <td>{run.blocked_count}</td>
            <td>{run.warning_count}</td>
            <td>{run.error_count}</td>
            <td>{formatDate(run.created_at)}</td>
          </tr>)}
        </DataTable>
      </CardContent>
    </Card>
  </>;
}
