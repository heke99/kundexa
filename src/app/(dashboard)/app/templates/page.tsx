import Link from "next/link";
import { ok } from "@/lib/supabase/read";
import { ScrollText } from "@/components/icons";
import { createClient } from "@/lib/supabase/server";
import { createContractTemplateVersion } from "@/app/actions/templates";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { Badge } from "@/components/ui/badge";
import { Field, SelectField, TextareaField } from "@/components/ui/form-field";
import { ContractTemplateDocumentUpload } from "@/components/contract-template-document-upload";
import { TemplateFieldReference } from "@/components/template-field-reference";
import { TemplateFieldButtons } from "@/components/template-field-buttons";
import { formatDate } from "@/lib/utils";
import { getAppContext } from "@/lib/auth";
import { can } from "@/lib/permissions";

type TemplateVersion = { id: string; version: number; status: string; approved_at: string | null; created_at: string };

export default async function TemplatesPage({ searchParams }: { searchParams: Promise<{ error?: string; message?: string; product_id?: string }> }) {
  const params = await searchParams;
  const [ctx, supabase] = await Promise.all([getAppContext(), createClient()]);
  // Samma roller som createContractTemplateVersion släpper in. Formuläret
  // visades för alla, också säljare, som fick ett nej efter att ha skrivit klart.
  const mayAuthor = can(ctx.role, "contracts.manage_templates");
  const [{ data: templates }, { data: legalEntities }, { data: products }] = await Promise.all([
    ok(supabase.from("contract_templates").select("id,name,contract_type,audience,active,current_version_id,legal_entity_id,product_id,contract_template_versions!contract_template_versions_tenant_id_template_id_fkey(id,version,status,approved_at,created_at)").order("name")),
    ok(supabase.from("tenant_legal_entities").select("id,legal_name,organization_number,is_default").eq("active", true).order("is_default", { ascending: false }).order("legal_name")),
    ok(supabase.from("products").select("id,name").eq("active", true).order("name")),
  ]);
  const productName = new Map((products ?? []).map((product) => [product.id, product.name]));
  // En produkt har ett avtal. De som redan har ett visas men går inte att välja.
  const taken = new Set((templates ?? []).filter((template) => template.active && template.product_id).map((template) => template.product_id as string));
  const preselected = params.product_id && productName.has(params.product_id) && !taken.has(params.product_id) ? params.product_id : "";

  return <>
    <PageHeader title="Avtal" description="Varje avtal hör till en produkt. Säljaren väljer produkten och får avtalet med kundens uppgifter ifyllda." />
    {params.error ? <p className="form-error">{params.error}</p> : null}
    {params.message ? <div className="notice">{params.message}</div> : null}
    <div className="split-layout">
      <Card>
        <CardHeader><h2><ScrollText size={17} /> Mallar</h2><Badge>{templates?.length ?? 0}</Badge></CardHeader>
        <CardContent style={{ padding: 0 }}>
          {/* En rad per mall, inte per version. Versionerna hör hemma inne i
              mallen -- listan svarar på "vilka mallar finns och går de att
              använda", inte på "vilken historik har de". */}
          <DataTable headers={["Avtal", "Produkt", "Målgrupp", "Status"]}>
            {templates?.map((template) => {
              const versions = ((template.contract_template_versions ?? []) as TemplateVersion[])
                .slice().sort((a, b) => b.version - a.version);
              const current = versions.find((version) => version.id === template.current_version_id) ?? null;
              const latest = versions[0] ?? null;
              return <tr key={template.id}>
                <td>
                  <Link href={`/app/templates/${template.id}`}><strong>{template.name}</strong></Link>
                  <br /><span className="muted">{versions.length} version{versions.length === 1 ? "" : "er"}{latest ? ` · senast ändrad ${formatDate(latest.created_at)}` : ""}</span>
                </td>
                <td>{template.product_id ? productName.get(template.product_id) ?? "Inaktiv produkt" : <span className="muted">Ingen — kan inte väljas</span>}</td>
                <td>{template.audience}</td>
                <td>
                  {!template.product_id
                    ? <Badge className="badge-warning">Koppla till produkt</Badge>
                    : current
                      ? <Badge className="badge-success">Godkänd v{current.version}</Badge>
                      : <Badge className="badge-warning">Utkast — kan inte användas</Badge>}
                </td>
              </tr>;
            })}
          </DataTable>
          {!templates?.length ? <p className="muted" style={{ padding: 16 }}>Inga avtal än. Skapa det första i formuläret bredvid.</p> : null}
        </CardContent>
      </Card>
      {mayAuthor ? <Card>
        <CardHeader><h2>Nytt avtal för en produkt</h2></CardHeader>
        <CardContent>
          {!legalEntities?.length ? <div className="notice warning">Skapa först ett juridiskt avsändarbolag under Administration.</div> : null}
          {!products?.length ? <div className="notice warning">Skapa först en produkt under <Link href="/app/products">Produkter</Link>. Avtalet läggs i produkten.</div> : null}
          {/* Ändra en befintlig mall gör man inne i mallen, med dess text
              förifylld. Att välja den här i en rullgardin och skriva om allt
              från början var det enda sättet tidigare. */}
          <form action={createContractTemplateVersion} className="form-stack">
            <SelectField label="Produkt" name="product_id" defaultValue={preselected} required>
              <option value="">Välj produkt</option>
              {products?.map((product) => <option key={product.id} value={product.id} disabled={taken.has(product.id)}>{product.name}{taken.has(product.id) ? " · har redan ett avtal" : ""}</option>)}
            </SelectField>
            <Field label="Avtalets namn" name="name" placeholder="Elavtal rörligt" defaultValue={preselected ? productName.get(preselected) : undefined} required />
            <Field label="Avtalstyp" name="contract_type" placeholder="abonnemang" required />
            <SelectField label="Målgrupp" name="audience" defaultValue="B2B" required>
              <option value="B2B">Företag</option><option value="B2C">Privatperson</option><option value="BOTH">Båda</option>
            </SelectField>
            <SelectField label="Juridiskt avsändarbolag" name="legal_entity_id" defaultValue={legalEntities?.find((entity) => entity.is_default)?.id ?? ""} required>
              <option value="">Välj bolag</option>
              {legalEntities?.map((entity) => <option key={entity.id} value={entity.id}>{entity.legal_name}{entity.organization_number ? ` · ${entity.organization_number}` : ""}</option>)}
            </SelectField>
            <TextareaField label="Beskrivning" name="description" />
            <Field label="Dynamisk avtalstitel" name="title_template" defaultValue="{{contract.title}}" required />
            <ContractTemplateDocumentUpload target="body_template" label="Ladda upp avtalet (.docx)" />
            <TextareaField label="Avtalstext" name="body_template" defaultValue={"Avtal mellan {{seller.legal_name}} och {{customer.display_name}}.\n\nAvtalet avser {{product.name}}. Månadspris: {{price.recurring_fee?}} {{price.currency?}}."} required />
            <ContractTemplateDocumentUpload target="terms_template" label="Ladda upp villkoren (.docx)" />
            <TextareaField label="Fullständiga villkor" name="terms_template" defaultValue={"Bindningstid: {{price.binding_months?ingen}}. Uppsägningstid: {{price.notice_months?ingen}}. Avtalet upprättades {{today}}.\n\nHär ska era juridiskt granskade fullständiga villkor anges."} required />
            <TemplateFieldButtons />
            <TemplateFieldReference />
            <button className="button button-primary" disabled={!legalEntities?.length || !products?.length}>Spara som utkast</button>
          </form>
        </CardContent>
      </Card> : <Card><CardContent><p className="muted">Avtal läggs in av teamledare, avtalsansvarig, administratör eller ägare. Du använder dem genom att välja produkten när du skapar ett avtal.</p></CardContent></Card>}
    </div>
  </>;
}
