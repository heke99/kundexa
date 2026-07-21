import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ImportProfileManager } from "@/components/import-profile-manager";
import { createClient } from "@/lib/supabase/server";

export default async function ImportProfilesPage() {
  const supabase = await createClient();
  const [{ data: profiles }, { data: lists }] = await Promise.all([
    supabase.from("import_profiles").select("id,name,source_provider,source_website,format,worksheet_name,header_row,records_path,target_type,target_list_id,automatic_commit,current_version").eq("active", true).order("name"),
    supabase.from("customer_lists").select("id,name").in("status", ["draft", "active", "paused"]).order("name"),
  ]);
  const profileIds = (profiles ?? []).map((profile) => profile.id);
  const { data: versions } = profileIds.length
    ? await supabase.from("import_profile_versions").select("import_profile_id,version,field_mapping").in("import_profile_id", profileIds)
    : { data: [] };
  const versionByProfile = new Map((versions ?? []).map((version) => [`${version.import_profile_id}:${version.version}`, version.field_mapping]));
  const profilesWithMapping = (profiles ?? []).map((profile) => ({
    ...profile,
    field_mapping: versionByProfile.get(`${profile.id}:${profile.current_version}`) ?? {},
  }));
  return <>
    <PageHeader title="Importprofiler" description="Versionsstyr källformat, JSON-sökväg, arbetsblad, fältmappning, merge-policy och standardmål." action={<Link className="button button-secondary" href="/app/imports">Till importer</Link>} />
    <Card><CardHeader><h2>Profil och mappning</h2></CardHeader><CardContent><ImportProfileManager profiles={profilesWithMapping} lists={lists ?? []} /></CardContent></Card>
  </>;
}
