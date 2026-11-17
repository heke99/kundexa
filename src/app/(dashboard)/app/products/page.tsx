import { randomUUID } from "node:crypto";
import Link from "next/link";
import { ok } from "@/lib/supabase/read";
import { Package, Plus } from "@/components/icons";
import { createClient } from "@/lib/supabase/server";
import { createProduct, reviseProductContractTerms } from "@/app/actions/products";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { Field, SelectField, TextareaField } from "@/components/ui/form-field";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/utils";
import { readJsonObject } from "@/lib/supabase/json";
import { getAppContext } from "@/lib/auth";
import { can } from "@/lib/permissions";

export default async function ProductsPage({ searchParams }: { searchParams: Promise<{ error?: string; message?: string }> }) {
  const params = await searchParams;
  const [context, supabase] = await Promise.all([getAppContext(), createClient()]);
  // Formuläret visades för alla och nekades sedan av createProduct för alla
  // utom ägare och administratör.
  const mayCreateProduct = can(context.role, "products.manage");
  const mayAddContract = can(context.role, "contracts.manage_templates");
  const [{ data }, { data: contracts }] = await Promise.all([
    ok(supabase.from("products")
      .select("id,name,sku,product_type,active,product_price_versions(id,active,valid_from,valid_to,setup_fee,recurring_fee,variable_fees,binding_months,notice_months,payment_terms_days,version)")
      .order("created_at", { ascending: false })),
    ok(supabase.from("contract_templates").select("id,product_id,current_version_id").eq("active", true).not("product_id", "is", null)),
  ]);
  // Avtalet ligger i produkten. Här syns det, och här läggs det till.
  const contractByProduct = new Map((contracts ?? []).map((contract) => [contract.product_id as string, contract]));

  return <>
    <PageHeader title="Produkter och priser" description="Varje produkt har sitt avtal. Säljaren väljer produkten, och avtalet följer med." />
    <p className="muted">Bindningstid, uppsägningstid och betalningsvillkor gäller per produkt och prisversion. Tomt betyder inte angivet; 0 månader är ett uttryckligt värde.</p>
    {params.error ? <p className="form-error">{params.error}</p> : null}
    {params.message ? <div className="notice">{params.message}</div> : null}
    <div className="split-layout">
      <Card><CardHeader><h2>Produkter</h2><Badge>{data?.length ?? 0}</Badge></CardHeader><CardContent style={{ padding: 0 }}>
        <DataTable headers={["Produkt", "Avtal", "Startavgift", "Månadspris", "Rörligt", "Bindning", "Uppsägning", "Betalning", "Status"]}>
          {data?.map((product) => {
            const prices = Array.isArray(product.product_price_versions) ? product.product_price_versions : [];
            const today = new Date().toISOString().slice(0, 10);
            const price = prices.filter(row => row.active && row.valid_from <= today && (!row.valid_to || row.valid_to >= today)).sort((a, b) => b.version - a.version)[0];
            const variableFees = Array.isArray(price?.variable_fees) ? price.variable_fees : [];
            const variableTotal = variableFees.reduce<number>((sum, row) => sum + Number(readJsonObject(row).amount ?? 0), 0);
            const contract = contractByProduct.get(product.id);
            return <tr key={product.id}>
              <td><strong>{product.name}</strong>{product.sku ? <><br /><span className="muted">{product.sku}</span></> : null}
              {price && mayCreateProduct ? <details style={{ marginTop: 8 }}><summary>Ändra produktens avtalstider</summary>
                <form action={reviseProductContractTerms} className="form-stack" style={{ marginTop: 10 }}>
                  <input type="hidden" name="product_id" value={product.id} />
                  <input type="hidden" name="expected_price_id" value={price.id} />
                  <input type="hidden" name="request_key" value={randomUUID()} />
                  <Field label="Bindningstid (mån)" name="binding_months" type="number" min="0" max="240" defaultValue={price.binding_months ?? ""} />
                  <Field label="Uppsägningstid (mån)" name="notice_months" type="number" min="0" max="120" defaultValue={price.notice_months ?? ""} />
                  <Field label="Betalningsvillkor (dagar)" name="payment_terms_days" type="number" min="0" max="365" required defaultValue={price.payment_terms_days} />
                  <small>Skapar en ny prisversion för {product.name}. Avgifter och befintliga avtal behåller sina värden.</small>
                  <button className="button button-secondary">Spara ny prisversion</button>
                </form>
              </details> : null}
              {!price ? <p className="muted">Saknar aktuellt pris</p> : null}</td>
              <td>{contract
                ? <Link href={`/app/templates/${contract.id}`}>{contract.current_version_id ? <Badge className="badge-success">Avtal godkänt</Badge> : <Badge className="badge-warning">Avtal väntar på godkännande</Badge>}</Link>
                : mayAddContract ? <Link href={`/app/templates?product_id=${product.id}`} className="button button-ghost" style={{ padding: "2px 8px" }}>Lägg till avtal</Link> : <span className="muted">Inget avtal</span>}</td>
              <td>{price ? formatCurrency(Number(price.setup_fee)) : "—"}</td><td>{price ? formatCurrency(Number(price.recurring_fee)) : "—"}</td>
              <td>{price ? formatCurrency(variableTotal) : "—"}</td><td>{price?.binding_months == null ? "Ej angivet" : `${price.binding_months} mån`}</td>
              <td>{price?.notice_months == null ? "Ej angivet" : `${price.notice_months} mån`}</td>
              <td>{price ? `${price.payment_terms_days} dagar` : "Ej angivet"}</td><td><Badge className={product.active ? "badge-success" : ""}>{product.active ? "Aktiv" : "Inaktiv"}</Badge></td>
            </tr>;
          })}
        </DataTable>
      </CardContent></Card>
      {mayCreateProduct ? <Card><CardHeader><h2><Plus size={16} /> Ny produkt</h2></CardHeader><CardContent>
        <form action={createProduct} className="form-stack">
          <Field label="Namn" name="name" required /><Field label="SKU" name="sku" />
          <SelectField label="Typ" name="product_type"><option value="service">Tjänst</option><option value="product">Produkt</option><option value="package">Paket</option></SelectField>
          <TextareaField label="Beskrivning" name="description" />
          <div className="form-grid">
            <Field label="Startavgift" name="setup_fee" type="number" step="0.01" min="0" defaultValue="0" />
            <Field label="Månadsavgift" name="recurring_fee" type="number" step="0.01" min="0" defaultValue="0" />
            <Field label="Rörlig avgift" name="variable_fee" type="number" step="0.01" min="0" defaultValue="0" />
            <Field label="Benämning rörlig avgift" name="variable_fee_label" placeholder="per användare" />
            <Field label="Bindningstid (mån)" name="binding_months" type="number" min="0" max="240" />
            <Field label="Uppsägningstid (mån)" name="notice_months" type="number" min="0" max="120" />
            <Field label="Betalningsvillkor (dagar)" name="payment_terms_days" type="number" min="0" max="365" defaultValue="30" />
          </div>
          <TextareaField label="Prisversionens särskilda villkor" name="terms" />
          <button className="button button-primary"><Package size={16} /> Skapa produkt och prisversion</button>
        </form>
      </CardContent></Card> : <Card><CardContent><p className="muted">Produkter läggs upp av ägare eller administratör.</p></CardContent></Card>}
    </div>
  </>;
}
