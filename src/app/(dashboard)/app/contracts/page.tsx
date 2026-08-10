import Link from "next/link";
import { FileSignature, Plus } from "@/components/icons";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { Field, SelectField } from "@/components/ui/form-field";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
import type { RuntimeDatabase } from "@/lib/supabase/runtime-database.types";

type ContractStatus = RuntimeDatabase["public"]["Enums"]["contract_status"];

const statusLabel: Record<ContractStatus, string> = {
  draft: "Utkast", ready: "Redo", sent: "Skickat", delivered: "Levererat", opened: "Öppnat",
  signing: "Signering pågår", accepted: "Accepterat", declined: "Avstått", expired: "Utgånget", signed: "Dokumenterat", active: "Aktivt",
  cancelled: "Avbrutet", terminated: "Avslutat", superseded: "Ersatt",
};

function isContractStatus(value: string): value is ContractStatus {
  return Object.prototype.hasOwnProperty.call(statusLabel, value);
}

type Search = {
  error?: string; message?: string; status?: string; call?: string; attention?: string; q?: string; page?: string;
  owner_user_id?: string; team_id?: string; product_id?: string; date_from?: string; date_to?: string;
};

type ContractRegistryRow = {
  id: string; contract_number: string; title: string; status: ContractStatus; audience: string; source_call_id: string | null;
  owner_user_id: string | null; team_id: string | null; product_id: string | null; expires_at: string | null; created_at: string; updated_at: string;
  customer_name: string; product_name: string | null; latest_delivery_status: string | null; latest_delivery_channel: string | null;
  latest_delivery_failure: string | null; reminders_sent: number; reminders_overdue: number;
};

const PAGE_SIZE = 100;

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

  const page = Math.max(1, Number.parseInt(params.page ?? "1", 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;
  const { data: registryData, error: registryError } = await supabase.rpc("contract_registry_page", {
    p_search: params.q?.trim() || null,
    p_status: params.status && isContractStatus(params.status) ? params.status : null,
    p_call_missing: params.call === "missing",
    p_attention: params.attention || null,
    p_owner_user_id: params.owner_user_id || null,
    p_team_id: params.team_id || null,
    p_product_id: params.product_id || null,
    p_date_from: params.date_from || null,
    p_date_to: params.date_to || null,
    p_limit: PAGE_SIZE + 1,
    p_offset: offset,
  });
  if (registryError) throw registryError;
  const registryRows = (registryData ?? []) as ContractRegistryRow[];
  const hasNext = registryRows.length > PAGE_SIZE;
  const filteredContracts = registryRows.slice(0, PAGE_SIZE);

  const filterParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (key !== "page" && value) filterParams.set(key, value);
  const pageHref = (nextPage: number) => {
    const next = new URLSearchParams(filterParams);
    next.set("page", String(nextPage));
    return `/app/contracts?${next.toString()}`;
  };
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
          const stats = { sent: Number(contract.reminders_sent ?? 0), overdue: Number(contract.reminders_overdue ?? 0) };
          return <tr key={contract.id}>
            <td><Link href={`/app/contracts/${contract.id}`}><strong>{contract.contract_number}</strong><br /><span className="muted">{contract.title}</span></Link></td>
            <td>{contract.customer_name ?? "—"}</td><td>{contract.product_name ?? "—"}</td>
            <td>{contract.owner_user_id ? ownerNames.get(contract.owner_user_id) ?? contract.owner_user_id : "—"}<br /><span className="muted">{contract.team_id ? teamNames.get(contract.team_id) ?? "Team" : "Inget team"}</span></td>
            <td>{contract.source_call_id ? <Badge className="badge-success">Kopplat</Badge> : <Badge className="badge-warning">Saknas</Badge>}</td>
            <td><Badge className={["accepted", "signed", "active"].includes(contract.status) ? "badge-success" : ["declined", "expired", "cancelled"].includes(contract.status) ? "badge-warning" : "badge-info"}>{statusLabel[contract.status] ?? contract.status}</Badge></td>
            <td>{contract.latest_delivery_status ? <><span>{contract.latest_delivery_channel ?? "—"}</span><br /><Badge className={["failed", "bounced", "complained", "suppressed", "dead_letter"].includes(contract.latest_delivery_status) ? "badge-warning" : ""}>{contract.latest_delivery_status}</Badge>{contract.latest_delivery_failure ? <div className="form-error">{contract.latest_delivery_failure}</div> : null}</> : "—"}</td>
            <td>{stats.sent}{stats.overdue ? <><br /><Badge className="badge-warning">{stats.overdue} förfallen</Badge></> : null}</td>
            <td>{formatDate(contract.expires_at)}</td><td>{formatDate(contract.updated_at)}</td>
          </tr>;
        })}
      </DataTable>
      <div className="toolbar-left" style={{ padding: 14 }}>
        {page > 1 ? <Link className="button button-ghost button-sm" href={pageHref(page - 1)}>Föregående</Link> : null}
        <span className="muted">Sida {page}</span>
        {hasNext ? <Link className="button button-ghost button-sm" href={pageHref(page + 1)}>Nästa</Link> : null}
      </div>
    </CardContent></Card>
  </>;
}
