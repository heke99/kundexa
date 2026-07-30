import { redirect } from "next/navigation";
import { Phone, Plug, ShieldCheck } from "@/components/icons";
import { ModuleOverview } from "@/components/module-overview";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Field, SelectField } from "@/components/ui/form-field";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPlatformContext, isPlatformAdmin } from "@/lib/auth";
import {
  allocatePlatformRinkelResource,
  configurePlatformRinkelWebhooks,
  revokePlatformRinkelResource,
  setPlatformRinkelPaused,
  syncPlatformRinkelDirectory,
  testPlatformRinkelConnection,
} from "@/app/actions/rinkel";

export default async function PlatformTelephonyPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; message?: string }>;
}) {
  const params = await searchParams;
  const context = await getPlatformContext();
  if (!isPlatformAdmin(context.platformRole)) redirect("/app/platform");
  const admin = createAdminClient();
  const [
    { data: integration },
    { data: users },
    { data: numbers },
    { data: userAllocations },
    { data: numberAllocations },
    { data: subscriptions },
    { data: conflicts },
    { data: tenants },
  ] = await Promise.all([
    admin.from("platform_integrations").select(
      "id,status,webhook_status,last_connection_test_at,last_verified_at,last_successful_sync_at,last_reconciled_at,webhook_last_received_at,last_error_code,last_error_message,capabilities",
    ).eq("provider", "rinkel").is("disabled_at", null).limit(1).maybeSingle(),
    admin.from("platform_rinkel_users").select(
      "id,external_user_id,display_name,email,external_device_id,active,last_synced_at",
    ).order("display_name"),
    admin.from("platform_rinkel_numbers").select(
      "id,external_number_id,phone_number_e164,display_name,provider_status,active,recording_enabled,last_synced_at",
    ).order("phone_number_e164"),
    admin.from("rinkel_user_allocations").select("id,rinkel_user_id,tenant_id,status,valid_from,valid_to").order("created_at", { ascending: false }),
    admin.from("rinkel_number_allocations").select("id,rinkel_number_id,tenant_id,status,valid_from,valid_to").order("created_at", { ascending: false }),
    admin.from("platform_rinkel_webhook_subscriptions").select("event_type,status,last_verified_at,last_received_at,last_error").order("event_type"),
    admin.from("platform_rinkel_conflicts").select("id,conflict_type,provider_resource_type,provider_resource_key,claimed_tenant_ids,status,created_at").eq("status", "open").order("created_at", { ascending: false }),
    admin.from("tenants").select("id,name,status").in("status", ["trial", "active"]).order("name"),
  ]);
  const tenantById = new Map((tenants ?? []).map((tenant) => [tenant.id, tenant.name]));
  const activeUserAllocation = new Map((userAllocations ?? []).filter((item) => item.status === "active" && !item.valid_to).map((item) => [item.rinkel_user_id, item]));
  const activeNumberAllocation = new Map((numberAllocations ?? []).filter((item) => item.status === "active" && !item.valid_to).map((item) => [item.rinkel_number_id, item]));
  const capabilities = (integration?.capabilities ?? {}) as Record<string, boolean>;
  const apiKeyConfigured = Boolean(process.env.RINKEL_API_KEY);

  return <ModuleOverview
    title="Central Rinkel-telefoni"
    description="En plattformsintegration, en serverhemlighet och historiserade resursallokeringar till isolerade tenants."
    icon={Phone}
    features={["Central katalog", "Tenantallokeringar", "Fem centrala webhookar", "Konfliktkö och reconciliation"]}
  >
    {params.error ? <p className="form-error">{params.error}</p> : null}
    {params.message ? <div className="notice">{params.message}</div> : null}
    <div className="grid grid-3">
      <Card><CardContent><strong>{apiKeyConfigured ? "Konfigurerad" : "Saknas"}</strong><p className="muted">RINKEL_API_KEY (värdet visas aldrig)</p></CardContent></Card>
      <Card><CardContent><strong>{integration?.status ?? "not_configured"}</strong><p className="muted">central anslutning</p></CardContent></Card>
      <Card><CardContent><strong>{integration?.webhook_status ?? "not_configured"}</strong><p className="muted">webhookhälsa</p></CardContent></Card>
    </div>
    <Card>
      <CardHeader><h2><Plug size={17} /> Drift och capabilities</h2><Badge className={integration?.status === "connected" ? "badge-success" : "badge-warning"}>{integration?.status ?? "saknas"}</Badge></CardHeader>
      <CardContent>
        <div className="notice">
          API: {capabilities.api_access ? "aktiv" : "ej verifierad"} · Dial: {capabilities.dial ? "aktiv" : "ej verifierad"} ·
          Webhookar: {capabilities.webhooks ? "aktiva" : "ej verifierade"} · Inspelning: {capabilities.recordings ? "upptäckt" : "ej upptäckt"}
          {integration?.last_error_code ? <><br /><strong>{integration.last_error_code}</strong>: {integration.last_error_message}</> : null}
        </div>
        <div className="grid grid-3" style={{ marginTop: 14 }}>
          <form action={testPlatformRinkelConnection}><button className="button button-secondary">Testa central anslutning</button></form>
          <form action={syncPlatformRinkelDirectory}><button className="button button-secondary">Synkronisera katalog</button></form>
          <form action={configurePlatformRinkelWebhooks}><button className="button button-secondary">Konfigurera webhookar</button></form>
        </div>
        <form action={setPlatformRinkelPaused} style={{ marginTop: 12 }}>
          <input type="hidden" name="paused" value={integration?.status === "disabled" ? "false" : "true"} />
          <button className={integration?.status === "disabled" ? "button button-primary" : "button button-ghost"}>
            {integration?.status === "disabled" ? "Återaktivera central telefoni" : "Pausa central telefoni"}
          </button>
        </form>
        <p className="muted" style={{ marginTop: 12 }}>Senaste synk: {integration?.last_successful_sync_at ?? "aldrig"} · senaste webhook: {integration?.webhook_last_received_at ?? "aldrig"} · senaste reconciliation: {integration?.last_reconciled_at ?? "aldrig"}</p>
      </CardContent>
    </Card>
    <div className="split-layout">
      <Card>
        <CardHeader><h2>Rinkel-användare</h2><Badge>{users?.length ?? 0}</Badge></CardHeader>
        <CardContent>{(users ?? []).map((user) => {
          const allocation = activeUserAllocation.get(user.id);
          return <div className="activity-line" key={user.id}><span className="activity-dot"><ShieldCheck size={14} /></span><div style={{ flex: 1 }}><strong>{user.display_name}</strong><p>{user.external_device_id ? "Device klar" : "Device saknas"} · {allocation ? tenantById.get(allocation.tenant_id) ?? allocation.tenant_id : "ledig"}</p></div><Badge className={user.active ? "badge-success" : "badge-warning"}>{user.active ? "aktiv" : "inaktiv"}</Badge>{allocation ? <form action={revokePlatformRinkelResource}><input type="hidden" name="resource_type" value="user" /><input type="hidden" name="allocation_id" value={allocation.id} /><input type="hidden" name="reason" value="Återkallad av plattformsadmin" /><button className="button button-ghost button-sm">Återkalla</button></form> : null}</div>;
        })}</CardContent>
      </Card>
      <Card>
        <CardHeader><h2>Rinkel-nummer</h2><Badge>{numbers?.length ?? 0}</Badge></CardHeader>
        <CardContent>{(numbers ?? []).map((number) => {
          const allocation = activeNumberAllocation.get(number.id);
          return <div className="activity-line" key={number.id}><span className="activity-dot"><Phone size={14} /></span><div style={{ flex: 1 }}><strong>{number.phone_number_e164}</strong><p>{number.display_name ?? "Utan etikett"} · {allocation ? tenantById.get(allocation.tenant_id) ?? allocation.tenant_id : "ledigt"}</p></div><Badge className={number.active ? "badge-success" : "badge-warning"}>{number.provider_status}</Badge>{allocation ? <form action={revokePlatformRinkelResource}><input type="hidden" name="resource_type" value="number" /><input type="hidden" name="allocation_id" value={allocation.id} /><input type="hidden" name="reason" value="Återkallad av plattformsadmin" /><button className="button button-ghost button-sm">Återkalla</button></form> : null}</div>;
        })}</CardContent>
      </Card>
    </div>
    <Card>
      <CardHeader><h2>Allokera eller flytta resurs</h2></CardHeader>
      <CardContent><form action={allocatePlatformRinkelResource} className="form-stack">
        <SelectField label="Resurstyp" name="resource_type" required><option value="number">Telefonnummer</option><option value="user">Rinkel-användare</option></SelectField>
        <SelectField label="Resurs" name="resource_id" required><option value="">Välj resurs</option><optgroup label="Nummer">{(numbers ?? []).filter((number) => number.active).map((number) => <option key={number.id} value={number.id}>{number.phone_number_e164}</option>)}</optgroup><optgroup label="Användare">{(users ?? []).filter((user) => user.active).map((user) => <option key={user.id} value={user.id}>{user.display_name}</option>)}</optgroup></SelectField>
        <SelectField label="Tenant" name="tenant_id" required><option value="">Välj tenant</option>{(tenants ?? []).map((tenant) => <option key={tenant.id} value={tenant.id}>{tenant.name}</option>)}</SelectField>
        <Field label="Anledning" name="reason" required />
        <button className="button button-primary">Allokera transaktionellt</button>
      </form></CardContent>
    </Card>
    <div className="split-layout">
      <Card><CardHeader><h2>Webhookar</h2><Badge>{subscriptions?.length ?? 0}/5</Badge></CardHeader><CardContent>{(subscriptions ?? []).map((subscription) => <div className="activity-line" key={subscription.event_type}><span className="activity-dot"><Plug size={14} /></span><div><strong>{subscription.event_type}</strong><p>Senast mottagen: {subscription.last_received_at ?? "aldrig"}</p></div><Badge className={subscription.status === "active" ? "badge-success" : "badge-warning"}>{subscription.status}</Badge></div>)}</CardContent></Card>
      <Card><CardHeader><h2>Öppna konflikter</h2><Badge className={(conflicts?.length ?? 0) ? "badge-warning" : "badge-success"}>{conflicts?.length ?? 0}</Badge></CardHeader><CardContent>{(conflicts ?? []).length ? conflicts!.map((conflict) => <div className="activity-line" key={conflict.id}><span className="activity-dot"><ShieldCheck size={14} /></span><div><strong>{conflict.conflict_type}</strong><p>{conflict.provider_resource_type} · {conflict.provider_resource_key}</p></div></div>) : <p>Inga öppna korrelations- eller allokeringskonflikter.</p>}</CardContent></Card>
    </div>
  </ModuleOverview>;
}
