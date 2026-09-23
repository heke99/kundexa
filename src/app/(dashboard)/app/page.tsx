import { ok } from "@/lib/supabase/read";
import { Activity, FileSignature, PhoneCall, Target, TrendingUp, Users } from "@/components/icons";
import { createClient } from "@/lib/supabase/server";
import { getAppContext } from "@/lib/auth";
import { PageHeader } from "@/components/ui/page-header";
import { StatCard } from "@/components/ui/stat-card";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDate } from "@/lib/utils";
import { CONTRACT_ANSWER_EVENTS, contractEventLabel, contractStatusLabel, contractStatusTone } from "@/lib/contracts/status-labels";
import Link from "next/link";

type DashboardOverview = {
  customers: number; callsToday: number; pendingContracts: number;
  openActivities: number; openDeals: number; wonDealValue: number;
};

export default async function DashboardPage() {
  const [supabase, context] = await Promise.all([createClient(), getAppContext()]);
  const dashboardCopy: Record<string, { title: string; description: string; customerLabel: string }> = {
    sales: { title: "Min dashboard", description: "Dina kunder, samtal, aktiviteter och avtal inom ditt aktuella access-scope.", customerLabel: "Mina kunder och prospekt" },
    team_lead: { title: "Teamdashboard", description: "Resultat och arbetsläge för de team du faktiskt leder.", customerLabel: "Teamets kunder och prospekt" },
    contract_manager: { title: "Avtalsdashboard", description: "Avtal, aktiviteter och kundärenden inom ditt avtals-scope.", customerLabel: "Kunder i avtalsflödet" },
    quality: { title: "Kvalitetsdashboard", description: "Samtal, kvalitet och avtal som din roll får granska.", customerLabel: "Behöriga kundposter" },
    finance: { title: "Ekonomidashboard", description: "Kommersiell överblick inom din behörighet.", customerLabel: "Behöriga kundposter" },
  };
  const copy = dashboardCopy[context.role] ?? { title: "Dashboard", description: "Tenantens försäljning, aktiviteter och avtal inom ditt behörighetsscope.", customerLabel: "Kunder och prospekt" };
  // Alla nyckeltal aggregeras i databasen i ett anrop; inga obegränsade rådatamängder hämtas.
  const answeredSince = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const [{ data: overviewData }, recentContracts, { data: answers }] = await Promise.all([
    ok(supabase.rpc("dashboard_overview")),
    supabase.from("contracts").select("id,contract_number,title,status,value,currency,created_at,customers(display_name)").order("created_at", { ascending: false }).limit(6),
    // Kundens svar på skickade avtal. Säljaren fick annars veta att kunden
    // godkänt eller avböjt först när hen själv öppnade avtalet.
    ok(supabase.from("contract_events").select("id,event_type,occurred_at,contract_id,contracts(contract_number,title,customers(display_name))")
      .in("event_type", [...CONTRACT_ANSWER_EVENTS]).gte("occurred_at", answeredSince)
      .order("occurred_at", { ascending: false }).limit(8)),
  ]);
  const overview = (overviewData ?? { customers: 0, callsToday: 0, pendingContracts: 0, openActivities: 0, openDeals: 0, wonDealValue: 0 }) as DashboardOverview;
  return <>
    <PageHeader title={copy.title} description={copy.description} />
    <div className="grid grid-4">
      <StatCard icon={Users} label={copy.customerLabel} value={overview.customers} detail="Aktiva poster" />
      <StatCard icon={PhoneCall} label="Samtal idag" value={overview.callsToday} detail="In- och utgående" />
      <StatCard icon={FileSignature} label="Avtal väntar" value={overview.pendingContracts} detail="Skickade eller öppnade" />
      <StatCard icon={TrendingUp} label="Vunnet värde" value={formatCurrency(Number(overview.wonDealValue))} detail="Alla vunna affärer" />
    </div>
    {answers?.length ? <Card style={{ marginTop: 18 }}>
      <CardHeader><h2>Kundsvar senaste veckan</h2><Badge>{answers.length} st</Badge></CardHeader>
      <CardContent>{answers.map((answer) => {
        const contract = Array.isArray(answer.contracts) ? answer.contracts[0] : answer.contracts;
        const customer = contract ? (Array.isArray(contract.customers) ? contract.customers[0] : contract.customers) : null;
        const yes = answer.event_type.startsWith("contract.accepted");
        return <div className="activity-line" key={answer.id}>
          <span className="activity-dot"><FileSignature size={14} /></span>
          <div><Link href={`/app/contracts/${answer.contract_id}`}><strong>{customer?.display_name ?? contract?.contract_number ?? "Avtal"}</strong></Link>
            <p><Badge className={yes ? "badge-success" : answer.event_type === "contract.declined" ? "badge-danger" : "badge-warning"}>{contractEventLabel(answer.event_type)}</Badge> {contract?.title ?? ""}</p></div>
          <time>{formatDate(answer.occurred_at)}</time>
        </div>;
      })}</CardContent>
    </Card> : null}
    <div className="grid grid-2" style={{ marginTop: 18 }}>
      <Card>
        <CardHeader><h2>Senaste avtal</h2><Badge>{recentContracts.data?.length ?? 0} st</Badge></CardHeader>
        <CardContent style={{ padding: 0 }}>
          <DataTable headers={["Avtal", "Kund", "Status", "Värde", "Skapat"]}>
            {(recentContracts.data ?? []).map((c) => {
              const customer = Array.isArray(c.customers) ? c.customers[0] : c.customers;
              return <tr key={c.id}><td><strong>{c.contract_number}</strong><br /><span className="muted">{c.title}</span></td><td>{customer?.display_name ?? "—"}</td><td><Badge className={contractStatusTone(c.status)}>{contractStatusLabel(c.status)}</Badge></td><td>{formatCurrency(Number(c.value), c.currency)}</td><td>{formatDate(c.created_at)}</td></tr>;
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
