import Link from "next/link";
import { FileSignature, Plus } from "@/components/icons";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { Field, SelectField } from "@/components/ui/form-field";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";

const statusLabel: Record<string, string> = {
  draft: "Utkast", ready: "Redo", sent: "Skickat", delivered: "Levererat", opened: "Öppnat",
  accepted: "Accepterat", declined: "Avstått", expired: "Utgånget", signed: "Dokumenterat", active: "Aktivt",
  cancelled: "Avbrutet", terminated: "Avslutat", superseded: "Ersatt",
};

type Search = {
  error?: string; message?: string; status?: string; call?: string; attention?: string; q?: string;
  owner_user_id?: string; team_id?: string; product_id?: string; date_from?: string; date_to?: string;
};

export default async function ContractsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams;
  const supabase = await createClient();
  const [{ data: members }, { data: teams }, { data: products }] = await Promise.all([
    supabase.from("tenant_memberships").select("user_id,profiles:user_id(full_name)").eq("status", "active").order("created_at"),
    supabase.from("teams").select("id,name").eq("status", "active").order("name"),
    supabase.from("products").select("id,name").eq("active", true).order("name"),
  ]);
  const ownerNames = new Map<string, string>();
  for (const member of members ?? []) {
    const profile = Array.isArray(member.profiles) ? member.profiles[0] : member.profiles;
    ownerNames.set(member.user_id, profile?.full_name ?? member.user_id);
  }
  const teamNames = new Map((teams ?? []).map((team) => [team.id, team.name]));

  let query = supabase.from("contracts")
    .select("id,contract_number,title,status,audience,source_call_id,owner_user_id,team_id,product_id,expires_at,created_at,updated_at,customers(display_name),products(name)")
    .order("updated_at", { ascending: false }).limit(500);
  if (params.status) query = query.eq("status", params.status);
  if (params.call === "missing") query = query.is("source_call_id", null);
  if (params.attention === "waiting") query = query.in("status", ["sent", "delivered", "opened"]);
  if (params.owner_user_id) query = query.eq("owner_user_id", params.owner_user_id);
  if (params.team_id) query = query.eq("team_id", params.team_id);
  if (params.product_id) query = query.eq("product_id", params.product_id);
  if (params.date_from) query = query.gte("created_at", `${params.date_from}T00:00:00.000Z`);
  if (params.date_to) query = query.lte("created_at", `${params.date_to}T23:59:59.999Z`);
  const { data: contracts } = await query;
  const ids = (contracts ?? []).map((contract) => contract.id);
  const [{ data: deliveries }, { data: reminders }] = ids.length ? await Promise.all([
    supabase.from("contract_deliveries").select("contract_id,status,channel,created_at,failure_message").in("contract_id", ids).order("created_at", { ascending: false }),
    supabase.from("contract_reminders").select("contract_id,status,scheduled_at").in("contract_id", ids),
  ]) : [{ data: [] }, { data: [] }];
  const latestDelivery = new Map<string, { status: string; channel: string; failure_message: string | null }>();
  for (const delivery of deliveries ?? []) if (!latestDelivery.has(delivery.contract_id)) latestDelivery.set(delivery.contract_id, delivery);
  const reminderStats = new Map<string, { sent: number; overdue: number }>();
  const now = Date.now();
  for (const reminder of reminders ?? []) {
    const current = reminderStats.get(reminder.contract_id) ?? { sent: 0, overdue: 0 };
    if (reminder.status === "sent") current.sent += 1;
    if (reminder.status === "scheduled" && new Date(reminder.scheduled_at).getTime() <= now) current.overdue += 1;
    reminderStats.set(reminder.contract_id, current);
  }
  const search = (params.q ?? "").trim().toLocaleLowerCase("sv-SE");
  const filteredContracts = (contracts ?? []).filter((contract) => {
    const delivery = latestDelivery.get(contract.id);
    const reminder = reminderStats.get(contract.id);
    const customer = Array.isArray(contract.customers) ? contract.customers[0] : contract.customers;
    if (params.attention === "delivery_error" && !["failed", "bounced", "complained", "suppressed", "dead_letter"].includes(delivery?.status ?? "")) return false;
    if (params.attention === "reminder_overdue" && (reminder?.overdue ?? 0) === 0) return false;
    if (search && !`${contract.contract_number} ${contract.title} ${customer?.display_name ?? ""}`.toLocaleLowerCase("sv-SE").includes(search)) return false;
    return true;
  }).slice(0, 200);

  return <>
    <PageHeader title="Avtal" description="Spårbara avtalsversioner med källsamtal, kanonisk PDF, leveransstatus och påminnelser." action={<Link href="/app/contracts/new" className="button button-primary"><Plus size={16} /> Nytt avtal</Link>} />
    {params.error ? <p className="form-error">{params.error}</p> : null}
    {params.message ? <p className="notice">{params.message}</p> : null}
    <Card style={{ marginBottom: 16 }}><CardContent><form method="get" className="form-stack">
      <div className="grid grid-2"><Field label="Sök avtal eller kund" name="q" defaultValue={params.q ?? ""} placeholder="Avtalsnummer, titel eller kund" />
        <SelectField label="Status" name="status" defaultValue={params.status ?? ""}><option value="">Alla statusar</option>{Object.entries(statusLabel).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</SelectField></div>
      <div className="grid grid-2">
        <SelectField label="Säljare" name="owner_user_id" defaultValue={params.owner_user_id ?? ""}><option value="">Alla säljare</option>{Array.from(ownerNames.entries()).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</SelectField>
        <SelectField label="Team" name="team_id" defaultValue={params.team_id ?? ""}><option value="">Alla team</option>{teams?.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</SelectField>
        <SelectField label="Produkt" name="product_id" defaultValue={params.product_id ?? ""}><option value="">Alla produkter</option>{products?.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}</SelectField>
        <SelectField label="Källsamtal" name="call" defaultValue={params.call ?? ""}><option value="">Alla</option><option value="missing">Saknar giltigt samtal</option></SelectField>
        <SelectField label="Behöver uppmärksamhet" name="attention" defaultValue={params.attention ?? ""}><option value="">Alla</option><option value="waiting">Väntar på kund</option><option value="delivery_error">Leveransfel</option><option value="reminder_overdue">Påminnelse förfallen</option></SelectField>
      </div>
      <div className="grid grid-2"><Field label="Skapad från" name="date_from" type="date" defaultValue={params.date_from ?? ""} /><Field label="Skapad till" name="date_to" type="date" defaultValue={params.date_to ?? ""} /></div>
      <div><button className="button button-secondary">Filtrera</button> <Link href="/app/contracts" className="button button-ghost">Rensa</Link></div>
    </form></CardContent></Card>
    <Card><CardHeader><h2><FileSignature size={17} /> Avtalsregister</h2><Badge>{filteredContracts.length}</Badge></CardHeader><CardContent style={{ padding: 0 }}>
      <DataTable headers={["Avtal", "Kund", "Produkt", "Säljare / team", "Källsamtal", "Status", "Senaste leverans", "Påminnelser", "Sista svar", "Senaste aktivitet"]}>
        {filteredContracts.map((contract) => {
          const customer = Array.isArray(contract.customers) ? contract.customers[0] : contract.customers;
          const product = Array.isArray(contract.products) ? contract.products[0] : contract.products;
          const delivery = latestDelivery.get(contract.id);
          const stats = reminderStats.get(contract.id) ?? { sent: 0, overdue: 0 };
          return <tr key={contract.id}>
            <td><Link href={`/app/contracts/${contract.id}`}><strong>{contract.contract_number}</strong><br /><span className="muted">{contract.title}</span></Link></td>
            <td>{customer?.display_name ?? "—"}</td><td>{product?.name ?? "—"}</td>
            <td>{contract.owner_user_id ? ownerNames.get(contract.owner_user_id) ?? contract.owner_user_id : "—"}<br /><span className="muted">{contract.team_id ? teamNames.get(contract.team_id) ?? "Team" : "Inget team"}</span></td>
            <td>{contract.source_call_id ? <Badge className="badge-success">Kopplat</Badge> : <Badge className="badge-warning">Saknas</Badge>}</td>
            <td><Badge className={["accepted", "signed", "active"].includes(contract.status) ? "badge-success" : ["declined", "expired", "cancelled"].includes(contract.status) ? "badge-warning" : "badge-info"}>{statusLabel[contract.status] ?? contract.status}</Badge></td>
            <td>{delivery ? <><span>{delivery.channel}</span><br /><Badge className={["failed", "bounced", "complained", "suppressed", "dead_letter"].includes(delivery.status) ? "badge-warning" : ""}>{delivery.status}</Badge></> : "—"}</td>
            <td>{stats.sent}{stats.overdue ? <><br /><Badge className="badge-warning">{stats.overdue} förfallen</Badge></> : null}</td>
            <td>{formatDate(contract.expires_at)}</td><td>{formatDate(contract.updated_at)}</td>
          </tr>;
        })}
      </DataTable>
    </CardContent></Card>
  </>;
}
