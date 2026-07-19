import Link from "next/link";
import { Building2, Search } from "@/components/icons";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/utils";

const PAGE_SIZE = 50;

export default async function CompaniesPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  const params = await searchParams;
  const page = Math.max(1, Number(params.page ?? 1) || 1);
  const supabase = await createClient();
  // Sidindelad, kolumnspecifik query i stället för obegränsad select *.
  let query = supabase.from("customers")
    .select("id,display_name,organization_number,industry,sni_code,city,revenue,employee_count,lifecycle", { count: "exact" })
    .eq("customer_type", "company").is("deleted_at", null)
    .order("display_name")
    .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
  if (params.q) query = query.ilike("display_name", `%${params.q}%`);
  const { data, count } = await query;
  const total = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pageHref = (target: number) => `/app/companies?${new URLSearchParams({ ...(params.q ? { q: params.q } : {}), page: String(target) })}`;
  return <>
    <PageHeader title="Företag" description="Företagskunder och prospekt med organisation, SNI, ekonomi och kontaktpersoner." />
    <Card>
      <CardHeader>
        <form className="toolbar-left"><div className="global-search" style={{ width: 320 }}><Search size={16} /><input name="q" defaultValue={params.q} placeholder="Sök företagsnamn" /></div><button className="button button-secondary button-sm">Sök</button></form>
        <Badge>{total} företag</Badge>
      </CardHeader>
      <CardContent style={{ padding: 0 }}>
        <DataTable headers={["Företag", "Org.nr", "Bransch / SNI", "Ort", "Omsättning", "Anställda", "Status"]}>
          {data?.map((c) => <tr key={c.id}><td><Link href={`/app/customers/${c.id}`}><strong>{c.display_name}</strong></Link></td><td>{c.organization_number ?? "—"}</td><td>{[c.industry, c.sni_code].filter(Boolean).join(" / ") || "—"}</td><td>{c.city ?? "—"}</td><td>{c.revenue ? formatCurrency(Number(c.revenue)) : "—"}</td><td>{c.employee_count ?? "—"}</td><td><Badge>{c.lifecycle}</Badge></td></tr>)}
        </DataTable>
        {!data?.length ? <div className="empty-state"><Building2 size={30} /><h3>Inga företag på denna sida</h3><p>Justera sökningen eller importera företag.</p></div> : null}
      </CardContent>
    </Card>
    {totalPages > 1 ? <div className="toolbar-left" style={{ marginTop: 12 }}>
      {page > 1 ? <Link className="button button-secondary button-sm" href={pageHref(page - 1)}>Föregående</Link> : null}
      <span className="muted">Sida {page} av {totalPages}</span>
      {page < totalPages ? <Link className="button button-secondary button-sm" href={pageHref(page + 1)}>Nästa</Link> : null}
    </div> : null}
  </>;
}
