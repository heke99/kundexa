import { ScrollText } from "@/components/icons";
import { createClient } from "@/lib/supabase/server";
import { getAppContext } from "@/lib/auth";
import { createContractTemplateVersion, approveContractTemplateVersion } from "@/app/actions/templates";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { Badge } from "@/components/ui/badge";
import { Field, SelectField, TextareaField } from "@/components/ui/form-field";
import { formatDate } from "@/lib/utils";

type TemplateVersion = {
  id: string;
  version: number;
  status: string;
  approved_at: string | null;
  created_at: string;
};

export default async function TemplatesPage({ searchParams }: { searchParams: Promise<{ error?: string; message?: string }> }) {
  const params = await searchParams;
  const [ctx, supabase] = await Promise.all([getAppContext(), createClient()]);
  const [{ data: templates }, { data: legalEntities }] = await Promise.all([
    supabase.from("contract_templates").select("id,name,contract_type,audience,active,current_version_id,legal_entity_id,contract_template_versions(id,version,status,approved_at,created_at)").order("name"),
    supabase.from("tenant_legal_entities").select("id,legal_name,organization_number,is_default").eq("active", true).order("is_default", { ascending: false }).order("legal_name"),
  ]);

  return <>
    <PageHeader title="Avtalsmallar" description="Juridiska mallar versionshanteras som utkast och måste godkännas innan de kan användas i ett avtal." />
    {params.error ? <p className="form-error">{params.error}</p> : null}
    {params.message ? <div className="notice">{params.message}</div> : null}
    <div className="split-layout">
      <Card>
        <CardHeader><h2><ScrollText size={17} /> Mallar och versioner</h2><Badge>{templates?.length ?? 0}</Badge></CardHeader>
        <CardContent style={{ padding: 0 }}>
          <DataTable headers={["Mall", "Typ", "Målgrupp", "Version", "Status", "Åtgärd"]}>
            {templates?.flatMap((template) => {
              const versions = (template.contract_template_versions ?? []) as TemplateVersion[];
              return versions.sort((a, b) => b.version - a.version).map((version) => <tr key={version.id}>
                <td><strong>{template.name}</strong><br /><span className="muted">{template.current_version_id === version.id ? "Aktuell godkänd version" : "Historisk/utkast"}</span></td>
                <td>{template.contract_type}</td>
                <td>{template.audience}</td>
                <td>v{version.version}<br /><span className="muted">{formatDate(version.created_at)}</span></td>
                <td><Badge className={version.status === "approved" ? "badge-success" : version.status === "draft" ? "badge-warning" : ""}>{version.status}</Badge></td>
                <td>{version.status === "draft" && ["owner", "admin"].includes(ctx.role) ? <form action={approveContractTemplateVersion}><input type="hidden" name="version_id" value={version.id} /><button className="button button-secondary">Godkänn version</button></form> : "—"}</td>
              </tr>);
            })}
          </DataTable>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><h2>Skapa ny mallversion</h2></CardHeader>
        <CardContent>
          {!legalEntities?.length ? <div className="notice warning">Skapa först ett juridiskt avsändarbolag under Administration.</div> : null}
          <form action={createContractTemplateVersion} className="form-stack">
            <SelectField label="Befintlig mall (valfritt)" name="template_id">
              <option value="">Skapa ny mall</option>
              {templates?.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
            </SelectField>
            <Field label="Mallnamn" name="name" placeholder="Standardavtal företag" required />
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
            <TextareaField label="Avtalstext" name="body_template" defaultValue={"Avtal mellan {{seller.legal_name}}, organisationsnummer {{seller.organization_number}}, och {{customer.display_name}}. Avtalet avser {{product.name}}. Månadspris: {{price.recurring_fee}} {{price.currency}}. Startavgift: {{price.setup_fee}} {{price.currency}}."} required />
            <TextareaField label="Fullständiga villkor" name="terms_template" defaultValue={"Bindningstid: {{price.binding_months}} månader. Uppsägningstid: {{price.notice_months}} månader. Betalningsvillkor: {{price.payment_terms_days}} dagar. Avtalet upprättades {{today}}. Här ska tenantens juridiskt granskade fullständiga villkor anges innan versionen godkänns."} required />
            <button className="button button-primary" disabled={!legalEntities?.length}>Spara som nytt utkast</button>
          </form>
          <div className="notice" style={{ marginTop: 16 }}>
            Tillåtna variabler: <code>{"{{seller.*}}"}</code>, <code>{"{{customer.*}}"}</code>, <code>{"{{product.*}}"}</code>, <code>{"{{price.*}}"}</code>, <code>{"{{contract.*}}"}</code> och <code>{"{{today}}"}</code>. Avtal skapas inte om ett obligatoriskt värde saknas.
          </div>
        </CardContent>
      </Card>
    </div>
  </>;
}
