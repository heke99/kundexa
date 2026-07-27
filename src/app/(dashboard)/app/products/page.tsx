import { Package, Plus } from "@/components/icons";
import { createClient } from "@/lib/supabase/server";
import { createProduct } from "@/app/actions/products";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { Field, SelectField, TextareaField } from "@/components/ui/form-field";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/utils";

export default async function ProductsPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const params = await searchParams;
  const supabase = await createClient();
  const { data } = await supabase.from("products")
    .select("id,name,sku,product_type,active,product_price_versions(setup_fee,recurring_fee,variable_fees,binding_months,notice_months,payment_terms_days,version)")
    .order("created_at", { ascending: false });

  return <>
    <PageHeader title="Produkter och priser" description="Versionshanterad produktkatalog som låses in i varje avtalsversion." />
    <div className="split-layout">
      <Card><CardHeader><h2>Produkter</h2><Badge>{data?.length ?? 0}</Badge></CardHeader><CardContent style={{ padding: 0 }}>
        <DataTable headers={["Produkt", "SKU", "Typ", "Startavgift", "Månadspris", "Rörligt", "Bindning", "Betalning", "Status"]}>
          {data?.map((product) => {
            const prices = Array.isArray(product.product_price_versions) ? product.product_price_versions : [];
            const price = prices.sort((a, b) => b.version - a.version)[0];
            const variableFees = Array.isArray(price?.variable_fees) ? price.variable_fees : [];
            const variableTotal = variableFees.reduce((sum, row) => sum + Number((row as Record<string, unknown>)?.amount ?? 0), 0);
            return <tr key={product.id}>
              <td><strong>{product.name}</strong></td><td>{product.sku ?? "—"}</td><td>{product.product_type}</td>
              <td>{formatCurrency(Number(price?.setup_fee))}</td><td>{formatCurrency(Number(price?.recurring_fee))}</td>
              <td>{formatCurrency(variableTotal)}</td><td>{price?.binding_months ? `${price.binding_months} mån` : "—"}</td>
              <td>{price?.payment_terms_days ?? 30} dagar</td><td><Badge className={product.active ? "badge-success" : ""}>{product.active ? "Aktiv" : "Inaktiv"}</Badge></td>
            </tr>;
          })}
        </DataTable>
      </CardContent></Card>
      <Card><CardHeader><h2><Plus size={16} /> Ny produkt</h2></CardHeader><CardContent>
        {params.error ? <p className="form-error">{params.error}</p> : null}
        <form action={createProduct} className="form-stack">
          <Field label="Namn" name="name" required /><Field label="SKU" name="sku" />
          <SelectField label="Typ" name="product_type"><option value="service">Tjänst</option><option value="product">Produkt</option><option value="package">Paket</option></SelectField>
          <TextareaField label="Beskrivning" name="description" />
          <div className="form-grid">
            <Field label="Startavgift" name="setup_fee" type="number" step="0.01" min="0" defaultValue="0" />
            <Field label="Månadsavgift" name="recurring_fee" type="number" step="0.01" min="0" defaultValue="0" />
            <Field label="Rörlig avgift" name="variable_fee" type="number" step="0.01" min="0" defaultValue="0" />
            <Field label="Benämning rörlig avgift" name="variable_fee_label" placeholder="per användare" />
            <Field label="Bindningstid (mån)" name="binding_months" type="number" min="0" />
            <Field label="Uppsägningstid (mån)" name="notice_months" type="number" min="0" />
            <Field label="Betalningsvillkor (dagar)" name="payment_terms_days" type="number" min="0" max="365" defaultValue="30" />
          </div>
          <TextareaField label="Prisversionens särskilda villkor" name="terms" />
          <button className="button button-primary"><Package size={16} /> Skapa produkt och prisversion</button>
        </form>
      </CardContent></Card>
    </div>
  </>;
}
