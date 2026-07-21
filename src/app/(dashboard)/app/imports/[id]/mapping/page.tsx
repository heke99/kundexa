import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { createClient } from "@/lib/supabase/server";
import { ImportFieldMappingEditor } from "@/components/import-field-mapping-editor";
import type { Json } from "@/lib/supabase/database.types";

function objectValue(value: Json | null): Record<string, Json | undefined> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export default async function ImportMappingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const [{ data: run }, { data: sample }] = await Promise.all([
    supabase.from("import_runs").select("id,name,status,field_mapping,validation_report").eq("id", id).maybeSingle(),
    supabase.from("import_rows").select("raw_data,normalized_data").eq("import_run_id", id).order("row_number").limit(1).maybeSingle(),
  ]);
  if (!run) notFound();
  const validation = objectValue(run.validation_report);
  const columns = Array.isArray(validation.columns) ? validation.columns.map(String) : Object.keys(objectValue(sample?.raw_data ?? null));
  const contactConfig = objectValue(objectValue(run.field_mapping).contacts as Json ?? null);
  const rawSample = objectValue(sample?.raw_data ?? null);
  const normalizedSample = objectValue(sample?.normalized_data ?? null);
  const detectedContactPath = Object.entries(rawSample).find(([, value]) => Array.isArray(value) && value.some((item) => item && typeof item === "object" && !Array.isArray(item)))?.[0] ?? "";
  const contactRecordsPath = typeof contactConfig.recordsPath === "string" ? contactConfig.recordsPath : detectedContactPath;
  const contactCandidate = contactRecordsPath ? rawSample[contactRecordsPath] : undefined;
  const firstContact = Array.isArray(contactCandidate) ? objectValue(contactCandidate[0]) : {};
  const companyColumns = columns.map((column) => ({
    name: column,
    example: String(rawSample[column] ?? "").slice(0, 100),
    normalizedExample: String(normalizedSample[column] ?? "").slice(0, 100),
  }));
  const contactColumns = Object.keys(firstContact).map((column) => ({
    name: column,
    example: String(firstContact[column] ?? "").slice(0, 100),
  }));
  return <>
    <PageHeader title={`Fältmappning · ${run.name}`} description="Varje importerad körning sparar exakt profilversion och mappning. Uppdatering här kör om normaliseringen på rådata utan att ladda upp filen igen." action={<Link className="button button-secondary" href={`/app/imports/${id}`}>Till importen</Link>} />
    <Card>
      <CardHeader><h2>Dynamisk fältmappning</h2><Badge>{columns.length + contactColumns.length} inkommande fält</Badge></CardHeader>
      <CardContent>
        <ImportFieldMappingEditor
          importRunId={id}
          initialMapping={objectValue(run.field_mapping)}
          companyColumns={companyColumns}
          contactColumns={contactColumns}
          initialContactRecordsPath={contactRecordsPath}
        />
      </CardContent>
    </Card>
  </>;
}
