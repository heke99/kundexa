import { Activity, FileSignature, PhoneCall, Target, TrendingUp, Users } from "@/components/icons";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/page-header";
import { StatCard } from "@/components/ui/stat-card";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDate } from "@/lib/utils";

type DashboardOverview = {
  customers: number; callsToday: number; pendingContracts: number;
  openActivities: number; openDeals: number; wonDealValue: number;
};

export default async function DashboardPage() {
  const supabase = await createClient();
  // Alla nyckeltal aggregeras i databasen i ett anrop; inga obegränsade rådatamängder hämtas.
  const [{ data: overviewData }, recentContracts] = await Promise.all([
    supabase.rpc("dashboard_overview"),
    supabase.from("contracts").select("id,contract_number,title,status,value,currency,created_at,customers(display_name)").order("created_at", { ascending: false }).limit(6),
  ]);
  const overview = (overviewData ?? { customers: 0, callsToday: 0, pendingContracts: 0, openActivities: 0, openDeals: 0, wonDealValue: 0 }) as DashboardOverview;
  return <>
    <PageHeader title="Dashboard" description="Realtidsbild av försäljning, aktiviteter och avtal." />
    <div className="grid grid-4">
      <StatCard icon={Users} label="Kunder och prospekt" value={overview.customers} detail="Aktiva poster" />
      <StatCard icon={PhoneCall} label="Samtal idag" value={overview.callsToday} detail="In- och utgående" />
      <StatCard icon={FileSignature} label="Avtal väntar" value={overview.pendingContracts} detail="Skickade eller öppnade" />
      <StatCard icon={TrendingUp} label="Vunnet värde" value={formatCurrency(Number(overview.wonDealValue))} detail="Alla vunna affärer" />
    </div>
    <div className="grid grid-2" style={{ marginTop: 18 }}>
      <Card>
        <CardHeader><h2>Senaste avtal</h2><Badge>{recentContracts.data?.length ?? 0} st</Badge></CardHeader>
        <CardContent style={{ padding: 0 }}>
          <DataTable headers={["Avtal", "Kund", "Status", "Värde", "Skapat"]}>
            {(recentContracts.data ?? []).map((c) => {
              const customer = Array.isArray(c.customers) ? c.customers[0] : c.customers;
              return <tr key={c.id}><td><strong>{c.contract_number}</strong><br /><span className="muted">{c.title}</span></td><td>{customer?.display_name ?? "—"}</td><td><Badge className={c.status === "signed" ? "badge-success" : "badge-info"}>{c.status}</Badge></td><td>{formatCurrency(Number(c.value), c.currency)}</td><td>{formatDate(c.created_at)}</td></tr>;
            })}
          </DataTable>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><h2>Arbetsläge</h2><Target size={18} /></CardHeader>
        <CardContent>
          <div className="grid grid-2">
            <StatCard icon={Activity} label="Öppna aktiviteter" value={overview.openActivities} />
            <StatCard icon={Target} label="Öppna affärer" value={overview.openDeals} />
          </div>
          <div className="notice" style={{ marginTop: 16 }}>Kundexa stoppar samtal, SMS och e-post innan utskick när kunden har en aktiv spärr eller invändning.</div>
        </CardContent>
      </Card>
    </div>
  </>;
}
