import Link from "next/link";
import { notFound } from "next/navigation";
import { ok } from "@/lib/supabase/read";
import { ArrowLeft, ScrollText } from "@/components/icons";
import { createClient } from "@/lib/supabase/server";
import { getAppContext } from "@/lib/auth";
import { createContractTemplateVersion, approveContractTemplateVersion } from "@/app/actions/templates";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Field, SelectField, TextareaField } from "@/components/ui/form-field";
import { ContractTemplateDocumentUpload } from "@/components/contract-template-document-upload";
import { TemplateFieldReference } from "@/components/template-field-reference";
import { formatDate } from "@/lib/utils";

type Version = {
  id: string; version: number; status: string; approved_at: string | null; created_at: string;
  title_template: string; body_template: string; terms_template: string;
};

/**
 * Mallen, läsbar och redigerbar.
 *
 * Listan visade namn, typ och status -- aldrig vad som faktiskt stod i avtalet.
 * Och den enda vägen till en ändring var att skriva om hela mallen från början
 * i formuläret bredvid, eftersom `create_contract_template_version` tar hela
 * texten. Innehållet fanns, det visades bara inte, och därför kunde ingen se
 * vad de godkände.
 *
 * Versioner är oföränderliga med flit: en godkänd juridisk text får inte ändras
 * under fötterna på avtal som redan hänvisar till den. "Redigera" betyder
 * därför en ny version med den nuvarande texten förifylld.
 */
export default async function TemplateDetailPage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; message?: string; version?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const [ctx, supabase] = await Promise.all([getAppContext(), createClient()]);
  const [{ data: template }, { data: legalEntities }] = await Promise.all([
    ok(supabase.from("contract_templates")
      .select("id,name,contract_type,audience,description,active,current_version_id,legal_entity_id,contract_template_versions!contract_template_versions_tenant_id_template_id_fkey(id,version,status,approved_at,created_at,title_template,body_template,terms_template)")
      .eq("id", id).maybeSingle()),
    ok(supabase.from("tenant_legal_entities").select("id,legal_name,organization_number,is_default").eq("active", true).order("is_default", { ascending: false }).order("legal_name")),
  ]);
  if (!template) notFound();

  const versions = ((template.contract_template_versions ?? []) as Version[])
    .slice().sort((a, b) => b.version - a.version);
  // Den version man tittar på: den man valt, annars den godkända, annars den
  // senaste. En mall utan versioner kan inte hända -- den skapas med sin första.
  const shown = versions.find((version) => version.id === query.version)
    ?? versions.find((version) => version.id === template.current_version_id)
    ?? versions[0]
    ?? null;
  const mayApprove = ["owner", "admin"].includes(ctx.role);
  const mayEdit = ["owner", "admin", "contract_manager", "team_lead"].includes(ctx.role);

  return <>
    <PageHeader
      title={template.name}
      description={`${template.contract_type} · ${template.audience}${template.description ? ` · ${template.description}` : ""}`}
    />
    <Link href="/app/templates" className="button button-ghost" style={{ marginBottom: 14 }}><ArrowLeft size={16} /> Alla mallar</Link>
    {query.error ? <p className="form-error">{query.error}</p> : null}
    {query.message ? <div className="notice">{query.message}</div> : null}

    <div className="split-layout">
      <Card>
        <CardHeader>
          <h2><ScrollText size={17} /> {shown ? `Version ${shown.version}` : "Ingen version"}</h2>
          {shown ? <Badge className={shown.status === "approved" ? "badge-success" : "badge-warning"}>{shown.status === "approved" ? "Godkänd" : "Utkast"}</Badge> : null}
        </CardHeader>
        <CardContent>
          {shown ? <>
            {shown.status === "draft" ? <div className="notice warning">Den här versionen kan inte användas i ett avtal förrän den är godkänd.{mayApprove ? "" : " En ägare eller administratör godkänner den."}</div> : null}
            {shown.status === "draft" && mayApprove
              ? <form action={approveContractTemplateVersion} style={{ marginBottom: 14 }}>
                  <input type="hidden" name="version_id" value={shown.id} />
                  <button className="button button-primary">Godkänn version {shown.version}</button>
                </form>
              : null}
            <h3>Avtalstitel</h3>
            <p style={{ whiteSpace: "pre-wrap", lineHeight: 1.7 }}>{shown.title_template}</p>
            <h3 style={{ marginTop: 16 }}>Avtalstext</h3>
            <p style={{ whiteSpace: "pre-wrap", lineHeight: 1.7 }}>{shown.body_template}</p>
            <h3 style={{ marginTop: 16 }}>Fullständiga villkor</h3>
            <p style={{ whiteSpace: "pre-wrap", lineHeight: 1.7 }}>{shown.terms_template}</p>
          </> : <p className="muted">Mallen saknar versioner.</p>}
        </CardContent>
      </Card>

      <div className="form-stack">
        {versions.length > 1 ? <Card>
          <CardHeader><h3>Versioner</h3><Badge>{versions.length}</Badge></CardHeader>
          <CardContent style={{ padding: 0 }}>
            {versions.map((version) => <div className="activity-line" key={version.id}>
              <span className="activity-dot"><ScrollText size={14} /></span>
              <div>
                <Link href={`/app/templates/${template.id}?version=${version.id}`}><strong>Version {version.version}</strong></Link>
                <p>{version.status === "approved" ? `Godkänd ${formatDate(version.approved_at)}` : `Utkast ${formatDate(version.created_at)}`}{version.id === template.current_version_id ? " · används nu" : ""}</p>
              </div>
            </div>)}
          </CardContent>
        </Card> : null}

        {mayEdit && shown ? <Card>
          <CardHeader><h3>Redigera</h3></CardHeader>
          <CardContent>
            {/* En godkänd text får inte ändras under fötterna på avtal som
                hänvisar till den, så ändringen blir en ny version -- men med
                den nuvarande texten förifylld i stället för ett tomt fält. */}
            <div className="notice">Ändringar sparas som en ny version. Den nuvarande texten är ifylld nedan — skriv om det du vill ändra.</div>
            <form action={createContractTemplateVersion} className="form-stack" style={{ marginTop: 12 }}>
              <input type="hidden" name="template_id" value={template.id} />
              <Field label="Mallnamn" name="name" defaultValue={template.name} required />
              <Field label="Avtalstyp" name="contract_type" defaultValue={template.contract_type} required />
              <SelectField label="Målgrupp" name="audience" defaultValue={template.audience} required>
                <option value="B2B">Företag</option><option value="B2C">Privatperson</option><option value="BOTH">Båda</option>
              </SelectField>
              <SelectField label="Juridiskt avsändarbolag" name="legal_entity_id" defaultValue={template.legal_entity_id ?? legalEntities?.find((entity) => entity.is_default)?.id ?? ""} required>
                <option value="">Välj bolag</option>
                {legalEntities?.map((entity) => <option key={entity.id} value={entity.id}>{entity.legal_name}{entity.organization_number ? ` · ${entity.organization_number}` : ""}</option>)}
              </SelectField>
              <TextareaField label="Beskrivning" name="description" defaultValue={template.description ?? ""} />
              <Field label="Dynamisk avtalstitel" name="title_template" defaultValue={shown.title_template} required />
              <ContractTemplateDocumentUpload target="body_template" label="Ersätt avtalstexten från .docx" />
              <TextareaField label="Avtalstext" name="body_template" defaultValue={shown.body_template} required />
              <ContractTemplateDocumentUpload target="terms_template" label="Ersätt villkoren från .docx" />
              <TextareaField label="Fullständiga villkor" name="terms_template" defaultValue={shown.terms_template} required />
              <TemplateFieldReference />
              <button className="button button-secondary">Spara som ny version</button>
            </form>
          </CardContent>
        </Card> : null}
      </div>
    </div>
  </>;
}
