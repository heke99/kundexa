import Link from "next/link";
import { CalendarCheck2, PhoneCall } from "@/components/icons";
import { claimCallback, completeCallback, reassignCallback, snoozeCallback } from "@/app/actions/callbacks";
import { getAppContext } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
import { isoToZonedLocalDateTime } from "@/lib/domain/time";

export default async function CallbacksPage({ searchParams }: { searchParams: Promise<{ error?: string; saved?: string }> }) {
  const params = await searchParams;
  const context = await getAppContext();
  const supabase = await createClient();
  const canManage = ["owner", "admin", "team_lead"].includes(context.role);
  const [{ data }, { data: memberships }] = await Promise.all([
    supabase.from("activities").select("id,customer_id,list_id,title,description,callback_scope,due_at,snoozed_until,status,assigned_user_id,assigned_team_id,claimed_by,claim_expires_at,customers(display_name,phone_e164)").eq("type", "callback").in("status", ["open", "in_progress"]).order("due_at").limit(250),
    canManage ? supabase.from("tenant_memberships").select("user_id,role,profiles:user_id(full_name)").eq("status", "active").in("role", ["owner", "admin", "team_lead", "sales"]) : Promise.resolve({ data: [] }),
  ]);
  const now = Date.now();
  const defaultSnooze = isoToZonedLocalDateTime(new Date(now + 60 * 60 * 1000).toISOString(), context.tenantTimezone);
  return <>
    <PageHeader title="Återkomster" description="Personliga återkomster och en atomiskt låst global teamkö, sorterad efter utlovad kontakttid." />
    {params.error ? <p className="form-error">{params.error}</p> : null}
    {params.saved ? <div className="notice" style={{ marginBottom: 16 }}>Återkomsten är uppdaterad i alla vyer.</div> : null}
    <div className="grid grid-3" style={{ marginBottom: 18 }}><Card><CardContent><strong>{data?.length ?? 0}</strong><div className="muted">Öppna</div></CardContent></Card><Card><CardContent><strong>{data?.filter((item) => new Date(item.snoozed_until ?? item.due_at ?? 0).getTime() <= now).length ?? 0}</strong><div className="muted">Förfallna</div></CardContent></Card><Card><CardContent><strong>{data?.filter((item) => item.callback_scope === "global").length ?? 0}</strong><div className="muted">Globala</div></CardContent></Card></div>
    <Card><CardHeader><h2><CalendarCheck2 size={17} /> Återkomstkö</h2><Badge>{data?.length ?? 0}</Badge></CardHeader><CardContent style={{ padding: 0 }}><DataTable headers={["Kund", "Typ", "Tid", "Anteckning", "Status", "Åtgärder"]}>{data?.map((item) => {
      const customer = Array.isArray(item.customers) ? item.customers[0] : item.customers;
      const effectiveDue = item.snoozed_until ?? item.due_at;
      const due = effectiveDue ? new Date(effectiveDue).getTime() : Infinity;
      const claimedByMe = item.claimed_by === context.userId && (!item.claim_expires_at || new Date(item.claim_expires_at).getTime() > now);
      const personalOwner = item.callback_scope === "personal" && item.assigned_user_id === context.userId;
      const canHandle = claimedByMe || personalOwner || canManage;
      const manualHref = `/app/dialer?customer=${item.customer_id}&callback=${item.id}`;
      return <tr key={item.id}>
        <td><Link href={`/app/customers/${item.customer_id}`}><strong>{customer?.display_name ?? "Okänd kund"}</strong></Link><br /><span className="muted">{customer?.phone_e164 ?? "Telefon saknas"}</span></td>
        <td><Badge className={item.callback_scope === "global" ? "badge-info" : ""}>{item.callback_scope === "global" ? "Global" : "Personlig"}</Badge></td>
        <td><span className={due <= now ? "text-danger" : ""}>{formatDate(effectiveDue)}</span>{item.snoozed_until ? <><br /><small className="muted">Snoozad</small></> : null}</td>
        <td>{item.description ?? item.title}</td>
        <td>{item.status === "in_progress" ? claimedByMe ? "Låst av dig" : "Låst av annan" : "Öppen"}</td>
        <td><div className="callback-actions">
          {item.list_id ? <Link className="button button-secondary button-sm" href={`/app/dialer/lists/${item.list_id}`}><PhoneCall size={14} /> Hantera i lista</Link> : item.callback_scope === "global" && !claimedByMe ? <form action={claimCallback}><input type="hidden" name="callback_id" value={item.id} /><button className="button button-primary button-sm" disabled={item.status === "in_progress"}><PhoneCall size={14} /> Ta återkomst</button></form> : <Link className="button button-primary button-sm" href={manualHref}><PhoneCall size={14} /> Ring</Link>}
          {canHandle ? <details><summary>Fler val</summary><div className="callback-menu">
            <form action={snoozeCallback} className="form-stack"><input type="hidden" name="callback_id" value={item.id} /><label className="field"><span>Snooza till</span><input type="datetime-local" name="snoozed_until" defaultValue={defaultSnooze} required /></label><button className="button button-secondary button-sm">Snooza</button></form>
            <form action={completeCallback} className="form-stack"><input type="hidden" name="callback_id" value={item.id} /><label className="field"><span>Slutanteckning</span><input name="notes" /></label><button className="button button-secondary button-sm">Markera klar</button></form>
            {canManage ? <form action={reassignCallback} className="form-stack"><input type="hidden" name="callback_id" value={item.id} /><label className="field"><span>Omfördela</span><select name="user_id" required defaultValue=""><option value="" disabled>Välj säljare</option>{memberships?.map((member) => { const profile = Array.isArray(member.profiles) ? member.profiles[0] : member.profiles; return <option key={member.user_id} value={member.user_id}>{profile?.full_name ?? member.user_id} · {member.role}</option>; })}</select></label><button className="button button-secondary button-sm">Omfördela</button></form> : null}
          </div></details> : null}
        </div></td>
      </tr>;
    })}</DataTable></CardContent></Card>
  </>;
}
