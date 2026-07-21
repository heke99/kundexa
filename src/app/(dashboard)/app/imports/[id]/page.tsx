import Link from "next/link";
import { notFound } from "next/navigation";
import { Import } from "@/components/icons";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { Badge } from "@/components/ui/badge";
import { createClient } from "@/lib/supabase/server";
import { formatDate } from "@/lib/utils";
import { processImport, rollbackImport } from "@/app/actions/imports";
import type { Json } from "@/lib/supabase/database.types";

function preview(value: Json | null, limit = 180) {
  const text = JSON.stringify(value ?? {});
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export default async function ImportDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; message?: string }> }) {
  const { id } = await params;
  const query = await searchParams;
  const supabase = await createClient();
  const [{ data: run }, { data: rows }, { data: conflicts }] = await Promise.all([
    supabase.from("import_runs").select("*").eq("id", id).maybeSingle(),
    supabase.from("import_rows").select("id,row_number,row_status,decision,error_code,warning_codes,normalized_data,raw_data,matched_customer_id,matched_contact_person_id,processing_ms").eq("import_run_id", id).order("row_number").limit(200),
    supabase.from("import_merge_conflicts").select("id,reason,status,field_name,existing_value,incoming_value,created_at").eq("import_run_id", id).order("created_at", { ascending: false }).limit(50),
  ]);
  if (!run) notFound();
  const canCommit = ["preview_ready", "validated", "queued"].includes(run.status);
  const canRollback = ["completed", "completed_with_warnings"].includes(run.status);
  return <>
    <PageHeader title={run.name} description={`${run.source_provider}${run.source_website ? ` · ${run.source_website}` : ""} · ${run.source_type}`} action={<div style={{ display: "flex", gap: 8 }}><Link className="button button-secondary" href="/app/imports">Översikt</Link><Link className="button button-secondary" href={`/app/imports/${id}/mapping`}>Fältmappning</Link></div>} />
    {query.error ? <p className="form-error">{query.error}</p> : null}
    {query.message ? <p className="notice">{query.message}</p> : null}
    <div className="metric-grid">
      {[
        ["Status", run.status], ["Rader", run.total_rows], ["Nya företag", run.new_count], ["Uppdaterade", run.updated_count],
        ["Oförändrade", run.unchanged_count], ["Nya kontakter", run.new_contact_count], ["Uppdaterade kontakter", run.updated_contact_count],
        ["Konflikter", run.conflict_count], ["Blockerade", run.blocked_count], ["Varningar", run.warning_count], ["Fel", run.error_count],
      ].map(([label, value]) => <Card key={String(label)}><CardContent><small>{label}</small><strong style={{ display: "block", fontSize: 22, marginTop: 4 }}>{value}</strong></CardContent></Card>)}
    </div>
    <Card>
      <CardHeader><h2><Import size={17} /> Körningsinformation</h2><Badge>{run.scan_status}</Badge></CardHeader>
      <CardContent>
        <div className="key-value"><span>Filhash</span><code>{run.file_sha256 ?? run.scan_sha256 ?? "—"}</code><span>Profilversion</span><span>{run.profile_version ?? "Engångsmappning"}</span><span>Arbetsblad</span><span>{run.worksheet_name ?? "—"}</span><span>JSON-path</span><span>{run.records_path ?? "—"}</span><span>Skapad</span><span>{formatDate(run.created_at)}</span><span>Slutförd</span><span>{run.completed_at ? formatDate(run.completed_at) : "—"}</span></div>
        <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
          {canCommit ? <form action={processImport}><input type="hidden" name="import_run_id" value={id} /><button className="button button-primary">Godkänn och genomför import</button></form> : null}
          {canRollback ? <form action={rollbackImport}><input type="hidden" name="import_run_id" value={id} /><button className="button button-secondary">Säker rollback</button></form> : null}
        </div>
      </CardContent>
    </Card>
    <Card>
      <CardHeader><h2>Förhandsgranskning och radresultat</h2><Badge>{rows?.length ?? 0} visade</Badge></CardHeader>
      <CardContent style={{ padding: 0 }}>
        <DataTable headers={["Rad", "Status", "Normaliserad data", "Rådata", "Matchning", "Tid"]}>
          {rows?.map((row) => <tr key={row.id}><td>{row.row_number}</td><td><Badge className={row.row_status === "invalid" || row.decision === "conflict" ? "badge-danger" : row.row_status === "warning" ? "badge-warning" : "badge-success"}>{row.decision ?? row.row_status}</Badge>{row.error_code ? <><br /><small>{row.error_code}</small></> : null}</td><td><code>{preview(row.normalized_data)}</code></td><td><code>{preview(row.raw_data)}</code></td><td>{row.matched_customer_id ? "Kund" : "—"}{row.matched_contact_person_id ? " + kontakt" : ""}</td><td>{row.processing_ms == null ? "—" : `${row.processing_ms} ms`}</td></tr>)}
        </DataTable>
      </CardContent>
    </Card>
    {conflicts?.length ? <Card><CardHeader><h2>Merge-konflikter</h2><Badge className="badge-danger">{conflicts.length}</Badge></CardHeader><CardContent style={{ padding: 0 }}><DataTable headers={["Orsak", "Fält", "Status", "Inkommande", "Befintligt"]}>{conflicts.map((conflict) => <tr key={conflict.id}><td>{conflict.reason}</td><td>{conflict.field_name ?? "—"}</td><td>{conflict.status}</td><td><code>{preview(conflict.incoming_value)}</code></td><td><code>{preview(conflict.existing_value)}</code></td></tr>)}</DataTable></CardContent></Card> : null}
  </>;
}
