import Link from "next/link";
import { Plus, Search, Users } from "@/components/icons";
import { createClient } from "@/lib/supabase/server";
import { getAppContext } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { createCustomer } from "@/app/actions/customers";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { Badge } from "@/components/ui/badge";
import { Field, SelectField } from "@/components/ui/form-field";
import { EmptyState } from "@/components/ui/empty-state";
import { formatDate } from "@/lib/utils";
import { lifecycleLabel } from "@/lib/ui/labels";

const PAGE_SIZE = 50;

export default async function CustomersPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string; error?: string }> }) {
  const params = await searchParams;
  const page = Math.max(1, Number(params.page ?? 1) || 1);
  const [supabase, context] = await Promise.all([createClient(), getAppContext()]);
  // `customers.read` opens this page; `customers.write` is what the action
  // requires. Four roles could reach the form and none of them could use it —
  // and with no error boundary the refusal was a crash rather than a message.
  const mayCreate = can(context.role, "customers.write");
  // Sidindelad query med totalantal i stället för hård 100-postersgräns.
  let query = supabase.from("customers")
    .select("id,display_name,customer_type,lifecycle,email,phone_e164,city,call_attempts,last_contact_at,customer_statuses(label,color)", { count: "exact" })
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
  if (params.q) query = query.ilike("display_name", `%${params.q}%`);
  const { data, count } = await query;
  const total = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pageHref = (target: number) => `/app/customers?${new URLSearchParams({ ...(params.q ? { q: params.q } : {}), page: String(target) })}`;
  return <>
    <PageHeader title="Kunder" description="Sök en kund eller lägg till en ny." />
    <div className="split-layout">
      <Card>
        <CardHeader>
          <form className="toolbar-left"><div className="global-search" style={{ width: 340 }}><Search size={16} /><input name="q" defaultValue={params.q} placeholder="Sök namn, företag eller nummer" /></div><button className="button button-secondary button-sm">Sök</button></form>
          <Badge>{total} poster</Badge>
        </CardHeader>
        <CardContent style={{ padding: 0 }}>
          {data?.length ? <DataTable headers={["Kund", "Status", "Telefon", "Ort", "Senast kontakt"]}>
            {data.map((c) => {
              const status = Array.isArray(c.customer_statuses) ? c.customer_statuses[0] : c.customer_statuses;
              return <tr key={c.id}><td><Link href={`/app/customers/${c.id}`}><strong>{c.display_name}</strong></Link></td><td><Badge>{status?.label ?? lifecycleLabel(c.lifecycle)}</Badge></td><td>{c.phone_e164 ?? c.email ?? "—"}</td><td>{c.city ?? "—"}</td><td>{formatDate(c.last_contact_at)}</td></tr>;
            })}
          </DataTable> : <EmptyState icon={Users} title="Inga kunder ännu" description="Skapa den första kunden eller importera en lista." />}
        </CardContent>
        {totalPages > 1 ? <div className="toolbar-left" style={{ padding: 12 }}>
          {page > 1 ? <Link className="button button-secondary button-sm" href={pageHref(page - 1)}>Föregående</Link> : null}
          <span className="muted">Sida {page} av {totalPages}</span>
          {page < totalPages ? <Link className="button button-secondary button-sm" href={pageHref(page + 1)}>Nästa</Link> : null}
        </div> : null}
      </Card>
      <Card>
        <CardHeader><h2><Plus size={16} /> Ny kund</h2></CardHeader>
        <CardContent>
          {params.error ? <p className="form-error">{params.error}</p> : null}
          {mayCreate ? <details open={Boolean(params.error)}><summary className="button button-secondary" style={{ display: "inline-flex" }}><Plus size={16} /> Lägg till kund</summary><form action={createCustomer} className="form-stack" style={{ marginTop: 12 }}>
            <SelectField label="Kundtyp" name="customer_type" defaultValue="company"><option value="company">Företag</option><option value="person">Privatperson</option></SelectField>
            <Field label="Namn / företagsnamn" name="display_name" required />
            <Field label="Telefon" name="phone" placeholder="070-123 45 67" />
            <Field label="E-post" name="email" type="email" />
            <Field label="Ort" name="city" />
            <input type="hidden" name="lifecycle" value="prospect" />
            <button className="button button-primary"><Plus size={16} /> Skapa kund</button>
          </form></details> : <p className="muted">Din roll kan läsa kunder men inte skapa nya. Be en teamledare eller administratör att lägga upp kunden.</p>}
        </CardContent>
      </Card>
    </div>
  </>;
}
