import Link from "next/link";
import { Plus, Search, Users } from "@/components/icons";
import { createClient } from "@/lib/supabase/server";
import { createCustomer } from "@/app/actions/customers";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { Badge } from "@/components/ui/badge";
import { Field, SelectField } from "@/components/ui/form-field";
import { EmptyState } from "@/components/ui/empty-state";
import { formatDate } from "@/lib/utils";

const PAGE_SIZE = 50;

export default async function CustomersPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string; error?: string }> }) {
  const params = await searchParams;
  const page = Math.max(1, Number(params.page ?? 1) || 1);
  const supabase = await createClient();
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
    <PageHeader title="Kunder" description="Gemensam kärna för kontaktuppgifter, samtal, avtal, aktiviteter och historik." />
    <div className="split-layout">
      <Card>
        <CardHeader>
          <form className="toolbar-left"><div className="global-search" style={{ width: 340 }}><Search size={16} /><input name="q" defaultValue={params.q} placeholder="Sök namn, företag eller nummer" /></div><button className="button button-secondary button-sm">Sök</button></form>
          <Badge>{total} poster</Badge>
        </CardHeader>
        <CardContent style={{ padding: 0 }}>
          {data?.length ? <DataTable headers={["Kund", "Typ", "Status", "Kontakt", "Ort", "Försök", "Senast kontakt"]}>
            {data.map((c) => {
              const status = Array.isArray(c.customer_statuses) ? c.customer_statuses[0] : c.customer_statuses;
              return <tr key={c.id}><td><Link href={`/app/customers/${c.id}`}><strong>{c.display_name}</strong></Link></td><td>{c.customer_type === "company" ? "Företag" : "Privatperson"}</td><td><Badge>{status?.label ?? c.lifecycle}</Badge></td><td>{c.phone_e164 ?? c.email ?? "—"}</td><td>{c.city ?? "—"}</td><td>{c.call_attempts}</td><td>{formatDate(c.last_contact_at)}</td></tr>;
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
          <form action={createCustomer} className="form-stack">
            <SelectField label="Kundtyp" name="customer_type" defaultValue="company"><option value="company">Företag</option><option value="person">Privatperson</option></SelectField>
            <Field label="Namn / företagsnamn" name="display_name" required />
            <Field label="Telefon" name="phone" placeholder="070-123 45 67" />
            <Field label="E-post" name="email" type="email" />
            <Field label="Ort" name="city" />
            <SelectField label="Livscykel" name="lifecycle" defaultValue="prospect"><option value="prospect">Prospekt</option><option value="lead">Lead</option><option value="customer">Kund</option></SelectField>
            <button className="button button-primary"><Plus size={16} /> Skapa kund</button>
          </form>
        </CardContent>
      </Card>
    </div>
  </>;
}
