import Link from "next/link";
import { FileSignature, Plus } from "@/components/icons";
import { createClient } from "@/lib/supabase/server";
import { createContract } from "@/app/actions/contracts";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { Field, SelectField } from "@/components/ui/form-field";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDate } from "@/lib/utils";

type TemplateRelation = {
  name: string;
  audience: string;
  active: boolean;
  current_version_id: string | null;
  legal_entity_id: string | null;
};

export default async function ContractsPage({ searchParams }: { searchParams: Promise<{ error?: string; customer?: string }> }) {
  const params = await searchParams;
  const supabase = await createClient();
  const [{ data: contracts }, { data: customers }, { data: products }, { data: versions }, { data: legalEntities }] = await Promise.all([
    supabase.from("contracts").select("id,contract_number,title,status,audience,value,currency,created_at,customers(display_name)").order("created_at", { ascending: false }).limit(100),
    supabase.from("customers").select("id,display_name,customer_type").is("deleted_at", null).order("display_name"),
    supabase.from("products").select("id,name").eq("active", true).order("name"),
    supabase.from("contract_template_versions").select("id,version,template_id,status,contract_templates(name,audience,active,current_version_id,legal_entity_id)").eq("status", "approved").order("created_at", { ascending: false }),
    supabase.from("tenant_legal_entities").select("id,legal_name,organization_number,is_default").eq("active", true).order("is_default", { ascending: false }).order("legal_name"),
  ]);

  const approvedVersions = (versions ?? []).filter((version) => {
    const relation = Array.isArray(version.contract_templates) ? version.contract_templates[0] : version.contract_templates;
    return relation?.active && relation.current_version_id === version.id;
  });

  return <>
    <PageHeader title="Avtal" description="Skapa avtal från en juridiskt godkänd mall, versionslås, skicka, följ och bevisa varje steg." />
    <div className="split-layout">
      <Card>
        <CardHeader><h2>Avtalsregister</h2><Badge>{contracts?.length ?? 0}</Badge></CardHeader>
        <CardContent style={{ padding: 0 }}>
          <DataTable headers={["Avtal", "Kund", "Typ", "Status", "Värde", "Skapat"]}>
            {contracts?.map((contract) => {
              const customer = Array.isArray(contract.customers) ? contract.customers[0] : contract.customers;
              return <tr key={contract.id}>
                <td><Link href={`/app/contracts/${contract.id}`}><strong>{contract.contract_number}</strong><br /><span className="muted">{contract.title}</span></Link></td>
                <td>{customer?.display_name ?? "—"}</td>
                <td>{contract.audience}</td>
                <td><Badge className={["signed", "active"].includes(contract.status) ? "badge-success" : contract.status === "draft" ? "" : "badge-info"}>{contract.status}</Badge></td>
                <td>{formatCurrency(Number(contract.value), contract.currency)}</td>
                <td>{formatDate(contract.created_at)}</td>
              </tr>;
            })}
          </DataTable>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><h2><Plus size={16} /> Skapa avtal</h2></CardHeader>
        <CardContent>
          {params.error ? <p className="form-error">{params.error}</p> : null}
          {!approvedVersions.length ? <div className="notice warning">Inget avtal kan skapas förrän en fullständig mallversion har skapats och godkänts under Avtalsmallar.</div> : null}
          {!legalEntities?.length ? <div className="notice warning">Organisationen saknar ett aktivt juridiskt avsändarbolag.</div> : null}
          <form action={createContract} className="form-stack">
            <SelectField label="Kund" name="customer_id" defaultValue={params.customer ?? ""} required>
              <option value="">Välj kund</option>
              {customers?.map((customer) => <option value={customer.id} key={customer.id}>{customer.display_name} · {customer.customer_type === "person" ? "B2C" : "B2B"}</option>)}
            </SelectField>
            <SelectField label="Juridiskt avsändarbolag" name="legal_entity_id" defaultValue={legalEntities?.find((entity) => entity.is_default)?.id ?? ""} required>
              <option value="">Välj juridiskt bolag</option>
              {legalEntities?.map((entity) => <option value={entity.id} key={entity.id}>{entity.legal_name}{entity.organization_number ? ` · ${entity.organization_number}` : ""}</option>)}
            </SelectField>
            <SelectField label="Godkänd avtalsmall" name="template_version_id" required>
              <option value="">Välj mall</option>
              {approvedVersions.map((version) => {
                const relation = (Array.isArray(version.contract_templates) ? version.contract_templates[0] : version.contract_templates) as TemplateRelation | null;
                return <option value={version.id} key={version.id}>{relation?.name ?? "Mall"} · {relation?.audience} · version {version.version}</option>;
              })}
            </SelectField>
            <SelectField label="Produkt" name="product_id">
              <option value="">Utan produkt</option>
              {products?.map((product) => <option value={product.id} key={product.id}>{product.name}</option>)}
            </SelectField>
            <Field label="Avtalstitel" name="title" placeholder="Företagsabonnemang" required />
            <SelectField label="Försäljningskanal" name="sales_channel" defaultValue="telephone">
              <option value="telephone">Telefonförsäljning</option><option value="web">Webb</option><option value="email">E-post</option>
              <option value="in_person">Fysiskt möte</option><option value="partner">Partner</option><option value="api">API</option><option value="other">Övrigt</option>
            </SelectField>
            <button className="button button-primary" disabled={!approvedVersions.length || !legalEntities?.length}><FileSignature size={16} /> Skapa låsbar version</button>
          </form>
        </CardContent>
      </Card>
    </div>
  </>;
}
