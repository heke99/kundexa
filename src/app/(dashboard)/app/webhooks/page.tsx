import { Webhook } from "@/components/icons";
import { createClient } from "@/lib/supabase/server";
import { createWebhookEndpoint } from "@/app/actions/admin";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { Badge } from "@/components/ui/badge";
import { Field } from "@/components/ui/form-field";
import { formatDate } from "@/lib/utils";

const events = ["customer.created", "customer.updated", "customer.blocked", "call.answered", "call.completed", "contract.created", "contract.sent", "contract.accepted", "contract.signed", "contract.declined", "contract.expired"];

export default async function WebhooksPage({ searchParams }: { searchParams: Promise<{ error?: string; secret?: string }> }) {
  const params = await searchParams;
  const supabase = await createClient();
  const [{ data: endpoints }, { data: deliveries }] = await Promise.all([
    supabase.from("webhook_endpoints").select("*").order("created_at", { ascending: false }),
    supabase.from("webhook_deliveries").select("*").order("created_at", { ascending: false }).limit(50),
  ]);
  return <>
    <PageHeader title="Webhooks" description="Signerade utgående events med deduplicering, HTTPS-krav, återförsök och leveranslogg." />
    {params.error ? <p className="form-error">{params.error}</p> : null}
    {params.secret ? <div className="notice warning"><strong>Spara signeringshemligheten nu:</strong> <code>{params.secret}</code><br />Den visas bara en gång.</div> : null}
    <div className="grid grid-2" style={{ marginTop: 16 }}>
      <Card>
        <CardHeader><h2><Webhook size={17} /> Endpoints</h2><Badge>{endpoints?.length ?? 0}</Badge></CardHeader>
        <CardContent style={{ padding: 0 }}>
          <DataTable headers={["Namn", "URL", "Events", "Status"]}>
            {endpoints?.map((endpoint) => <tr key={endpoint.id}><td><strong>{endpoint.name}</strong></td><td>{endpoint.url}</td><td>{endpoint.subscribed_events.length}</td><td><Badge className={endpoint.active ? "badge-success" : ""}>{endpoint.active ? "Aktiv" : "Av"}</Badge></td></tr>)}
          </DataTable>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><h2>Ny endpoint</h2></CardHeader>
        <CardContent>
          <form action={createWebhookEndpoint} className="form-stack">
            <Field label="Namn" name="name" required />
            <Field label="Publik HTTPS-URL" name="url" type="url" placeholder="https://example.com/webhooks/kundexa" required />
            <div className="field"><span>Events</span>{events.map((event) => <label key={event}><input type="checkbox" name="events" value={event} /> <code>{event}</code></label>)}</div>
            <button className="button button-primary" type="submit">Skapa endpoint</button>
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><h2>Leveranser</h2><Badge>{deliveries?.length ?? 0}</Badge></CardHeader>
        <CardContent>
          {deliveries?.map((delivery) => <div className="activity-line" key={delivery.id}><span className="activity-dot"><Webhook size={14} /></span><div><strong>{delivery.event_type}</strong><p>{delivery.status} · HTTP {delivery.response_status ?? "—"}</p></div><time>{formatDate(delivery.created_at)}</time></div>)}
        </CardContent>
      </Card>
    </div>
  </>;
}
