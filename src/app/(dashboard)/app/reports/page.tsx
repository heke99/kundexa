import { BarChart3, FileCheck2, PhoneCall, Target, Users } from "@/components/icons";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/page-header";
import { StatCard } from "@/components/ui/stat-card";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { formatCurrency } from "@/lib/utils";

type ReportListRow = {
  id: string;
  name: string;
  status: string;
  dialingMode: string;
  attempts: number;
  contactRate: number;
  orders: number;
  revenue: number;
  callbacks: number;
  handledCallbacks: number;
  remaining: number;
};
type ReportCampaignRow = { id: string; name: string; status: string; maxAttempts: number };
type SalesOverview = {
  attempts: number;
  answered: number;
  callSeconds: number;
  sentContracts: number;
  signedContracts: number;
  lists: ReportListRow[];
  campaigns: ReportCampaignRow[];
};

const emptyOverview: SalesOverview = {
  attempts: 0, answered: 0, callSeconds: 0, sentContracts: 0, signedContracts: 0, lists: [], campaigns: [],
};

export default async function ReportsPage() {
  const supabase = await createClient();
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const { data, error } = await supabase.rpc("report_sales_overview", { p_since: since });
  const report = (!error && data ? data : emptyOverview) as unknown as SalesOverview;
  const contactRate = report.attempts ? Math.round(report.answered / report.attempts * 100) : 0;
  const signingRate = report.sentContracts ? Math.round(report.signedContracts / report.sentContracts * 100) : 0;

  return <>
    <PageHeader title="Rapporter" description="Händelsebaserad försäljning, kontaktgrad, ringlistor, återkomster och order de senaste 30 dagarna." />
    {error ? <p className="form-error">Rapporten kunde inte aggregeras. Kontrollera att senaste databasmigrationen är körd.</p> : null}
    <div className="grid grid-4">
      <StatCard icon={PhoneCall} label="Ringförsök" value={report.attempts} />
      <StatCard icon={Users} label="Kontaktgrad" value={`${contactRate}%`} />
      <StatCard icon={FileCheck2} label="Signeringsgrad" value={`${signingRate}%`} />
      <StatCard icon={Target} label="Samtalstid" value={`${Math.round(report.callSeconds / 60)} min`} />
    </div>
    <Card style={{ marginTop: 18 }}>
      <CardHeader><h2><BarChart3 size={17} /> List- och dialerresultat</h2></CardHeader>
      <CardContent style={{ padding: 0 }}>
        <DataTable headers={["Lista", "Läge", "Ringförsök", "Kontaktgrad", "Order", "Omsättning", "Återkomster", "Kvar"]}>
          {report.lists.map((row) => <tr key={row.id}>
            <td><strong>{row.name}</strong><br /><span className="muted">{row.status}</span></td>
            <td>{row.dialingMode === "automatic" ? "Automatisk" : "Manuell"}</td>
            <td>{row.attempts}</td><td>{row.contactRate}%</td><td>{row.orders}</td>
            <td>{formatCurrency(Number(row.revenue), "SEK")}</td>
            <td>{row.handledCallbacks} / {row.callbacks} hanterade</td><td>{row.remaining}</td>
          </tr>)}
        </DataTable>
      </CardContent>
    </Card>
    <Card style={{ marginTop: 18 }}>
      <CardHeader><h2><BarChart3 size={17} /> Kampanjöversikt</h2></CardHeader>
      <CardContent style={{ padding: 0 }}>
        <DataTable headers={["Kampanj", "Status", "Max försök", "Kopplad rapportering"]}>
          {report.campaigns.map((campaign) => <tr key={campaign.id}><td><strong>{campaign.name}</strong></td><td>{campaign.status}</td><td>{campaign.maxAttempts}</td><td>RLS-filtrerad SQL-aggregering</td></tr>)}
        </DataTable>
      </CardContent>
    </Card>
  </>;
}
