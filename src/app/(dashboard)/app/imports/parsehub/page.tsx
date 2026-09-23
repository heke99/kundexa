import { ok } from "@/lib/supabase/read";
import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { Badge } from "@/components/ui/badge";
import { ParseHubProjectManager } from "@/components/parsehub-project-manager";
import { createClient } from "@/lib/supabase/server";
import { formatDate } from "@/lib/utils";

const runStatusLabels: Record<string, string> = {
  queued: "Väntar", processing: "Hämtas", completed: "Klar", failed: "Misslyckades",
};

export default async function ParseHubPage() {
  const supabase = await createClient();
  const [{ data: profiles }, { data: projects }, { data: runs }] = await Promise.all([
    ok(supabase.from("import_profiles").select("id,name,current_version").eq("active", true).order("name")),
    ok(supabase.from("parsehub_projects").select("id,project_name,source_website,active,created_at").order("project_name")),
    // Körningarna syntes ingenstans: ett ParseHub-flöde som slutat fungera
    // märktes först när listan inte fylldes på (FAILURE-0130).
    ok(supabase.from("parsehub_runs").select("id,parsehub_project_id,status,attempts,last_error_code,import_run_id,webhook_received_at,run_completed_at,next_attempt_at").order("created_at", { ascending: false }).limit(20)),
  ]);
  const projectNames = new Map((projects ?? []).map((project) => [project.id, project.project_name]));
  return <>
    <PageHeader title="ParseHub" description="Anslut ParseHub-projekt till en versionsstyrd importprofil. API-nycklar och run-tokens lagras krypterat." action={<Link className="button button-secondary" href="/app/imports/profiles">Hantera profiler</Link>} />
    <Card><CardHeader><h2>Projekt och webhook</h2></CardHeader><CardContent><ParseHubProjectManager profiles={profiles ?? []} projects={projects ?? []} /></CardContent></Card>
    <Card style={{ marginTop: 18 }}><CardHeader><h2>Senaste körningar</h2><Badge>{runs?.length ?? 0}</Badge></CardHeader><CardContent style={{ padding: 0 }}>
      {runs?.length ? <DataTable headers={["Projekt", "Mottagen", "Status", "Försök", "Fel", "Import"]}>{runs.map((run) => <tr key={run.id}>
        <td>{projectNames.get(run.parsehub_project_id) ?? "Okänt projekt"}</td>
        <td>{formatDate(run.webhook_received_at)}</td>
        <td><Badge className={run.status === "completed" ? "badge-success" : run.status === "failed" ? "badge-danger" : ""}>{runStatusLabels[run.status] ?? run.status}</Badge>{run.status === "queued" && run.next_attempt_at ? <><br /><small className="muted">Nytt försök {formatDate(run.next_attempt_at)}</small></> : null}</td>
        <td>{run.attempts}</td>
        <td>{run.last_error_code ? <code>{run.last_error_code}</code> : "—"}</td>
        <td>{run.import_run_id ? <Link href={`/app/imports/${run.import_run_id}`}>Öppna</Link> : "—"}</td>
      </tr>)}</DataTable> : <p className="muted" style={{ padding: 20 }}>Inga körningar har tagits emot ännu.</p>}
    </CardContent></Card>
  </>;
}
