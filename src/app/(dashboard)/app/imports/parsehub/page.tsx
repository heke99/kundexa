import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ParseHubProjectManager } from "@/components/parsehub-project-manager";
import { createClient } from "@/lib/supabase/server";

export default async function ParseHubPage() {
  const supabase = await createClient();
  const [{ data: profiles }, { data: projects }] = await Promise.all([
    supabase.from("import_profiles").select("id,name,current_version").eq("active", true).order("name"),
    supabase.from("parsehub_projects").select("id,project_name,source_website,active,created_at").order("project_name"),
  ]);
  return <>
    <PageHeader title="ParseHub" description="Anslut ParseHub-projekt till en versionsstyrd importprofil. API-nycklar och run-tokens lagras krypterat." action={<Link className="button button-secondary" href="/app/imports/profiles">Hantera profiler</Link>} />
    <Card><CardHeader><h2>Projekt och webhook</h2></CardHeader><CardContent><ParseHubProjectManager profiles={profiles ?? []} projects={projects ?? []} /></CardContent></Card>
  </>;
}
