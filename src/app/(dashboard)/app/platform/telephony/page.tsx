import Link from "next/link";
import { Phone, Plug, ShieldCheck } from "@/components/icons";
import { ModuleOverview } from "@/components/module-overview";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Field, SelectField } from "@/components/ui/form-field";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAppContext, isPlatformAdmin } from "@/lib/auth";
import {
  allocatePlatformRinkelResource,
  configurePlatformRinkelWebhooks,
  reprocessPlatformRinkelEvent,
  requeuePlatformRinkelJob,
  runPlatformRinkelReconciliation,
  runPlatformRinkelWorker,
  revokePlatformRinkelResource,
  setPlatformDefaultRinkelNumber,
  setPlatformRinkelPaused,
  syncPlatformRinkelDirectory,
  testPlatformRinkelConnection,
} from "@/app/actions/rinkel";

type UserAllocationRow = { id: string; rinkel_user_id: string; tenant_id: string; status: string; valid_to: string | null };
type NumberAllocationRow = { id: string; rinkel_number_id: string; tenant_id: string; status: string; valid_to: string | null };

const coreEvents = new Set(["incomingCall", "outgoingCall", "callStart", "callEnd"]);
const features = ["Central katalog", "Tenantallokeringar", "Fyra kärnwebhookar", "Beständig worker och CDR-reparation"];

function AccessDenied({ platformRole }: { platformRole: string | null }) {
  return <ModuleOverview
    title="Central Rinkel-telefoni"
    description="Den här sidan finns, men kräver en aktiv plattformsroll med administrativ behörighet."
    icon={Phone}
    features={features}
  >
    <Card>
      <CardHeader><h2>Plattformsbehörighet krävs</h2><Badge className="badge-warning">Åtkomst nekad</Badge></CardHeader>
      <CardContent>
        <p>Din nuvarande plattformsroll är <strong>{platformRole ?? "inte tilldelad"}</strong>. Tenantrollen owner/admin ger inte automatiskt åtkomst till Kundexas centrala Rinkel-konto.</p>
        <div style={{ display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap" }}>
          <Link href="/app" className="button button-secondary">Till dashboard</Link>
          <Link href="/app/integrations" className="button button-ghost">Tenantens integrationer</Link>
        </div>
      </CardContent>
    </Card>
  </ModuleOverview>;
}

function time(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString("sv-SE", { timeZone: "Europe/Stockholm" }) : "aldrig";
}

export default async function PlatformTelephonyPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; message?: string }>;
}) {
  const params = await searchParams;
  const context = await getAppContext();
  if (!isPlatformAdmin(context.platformRole)) return <AccessDenied platformRole={context.platformRole} />;

  const admin = createAdminClient();
  const integrationResult = await admin.from("platform_integrations").select(
    "id,status,webhook_status,last_connection_test_at,last_verified_at,last_successful_sync_at,last_reconciled_at,webhook_last_received_at,last_error_code,last_error_message,last_error_at,capabilities",
  ).eq("provider", "rinkel").eq("is_canonical", true).single();

  if (integrationResult.error || !integrationResult.data) {
    const queryError = integrationResult.error
      ? `${integrationResult.error.code ?? "DB_ERROR"}: ${integrationResult.error.message}`
      : "RINKEL_PLATFORM_NOT_CONFIGURED: En kanonisk Rinkel-integration saknas.";
    return <ModuleOverview title="Central Rinkel-telefoni" description="Databasen saknar eller blockerar den kanoniska Rinkel-modellen." icon={Phone} features={features}>
      <Card><CardHeader><h2>Databassynk krävs</h2><Badge className="badge-warning">Inte redo</Badge></CardHeader><CardContent>
        <p>Kör väntande migrationer och generera därefter om Supabase-typerna.</p>
        <pre style={{ marginTop: 12, whiteSpace: "pre-wrap" }}>{queryError}</pre>
      </CardContent></Card>
    </ModuleOverview>;
  }

  const integration = integrationResult.data;
  const results = await Promise.all([
    admin.from("platform_rinkel_capabilities").select("*").eq("platform_integration_id", integration.id).maybeSingle(),
    admin.from("platform_rinkel_users").select("id,external_user_id,display_name,email,active,last_synced_at").eq("platform_integration_id", integration.id).order("display_name"),
    admin.from("platform_rinkel_devices").select("id,platform_rinkel_user_id,provider_device_id,display_name,device_type,provider_status,active,last_seen_at,last_synced_at").eq("platform_integration_id", integration.id).order("display_name"),
    admin.from("platform_rinkel_numbers").select("id,external_number_id,phone_number_e164,display_name,provider_status,active,recording_enabled,is_platform_default,last_synced_at").eq("platform_integration_id", integration.id).order("phone_number_e164"),
    admin.from("rinkel_user_allocations").select("id,rinkel_user_id,tenant_id,status,valid_from,valid_to").order("created_at", { ascending: false }),
    admin.from("rinkel_number_allocations").select("id,rinkel_number_id,tenant_id,status,valid_from,valid_to").order("created_at", { ascending: false }),
    admin.from("platform_rinkel_webhook_subscriptions").select("event_type,required,status,provider_active,target_url_redacted,registered_at,test_requested_at,test_received_at,last_verified_at,last_received_at,last_processed_at,last_http_status,received_count,processed_count,failed_count,last_error_code,last_error_message").eq("platform_integration_id", integration.id).order("event_type"),
    admin.from("platform_rinkel_conflicts").select("id,event_id,conflict_type,provider_resource_type,provider_resource_key,claimed_tenant_ids,status,created_at").eq("status", "open").order("created_at", { ascending: false }),
    admin.from("tenants").select("id,name,status").in("status", ["trial", "active"]).order("name"),
    admin.from("platform_worker_heartbeats").select("*").eq("worker_key", "rinkel-platform-worker").maybeSingle(),
    admin.from("platform_rinkel_jobs").select("id,job_type,status,attempts,max_attempts,available_at,locked_at,locked_by,last_error_code,last_error_message,dead_lettered_at,created_at").order("created_at", { ascending: true }).limit(250),
  ]);

  const queryErrors = results.flatMap((result) => result.error ? [`${result.error.code ?? "DB_ERROR"}: ${result.error.message}`] : []);
  if (queryErrors.length) {
    return <ModuleOverview title="Central Rinkel-telefoni" description="Databasen saknar eller blockerar den kanoniska Rinkel-modellen." icon={Phone} features={features}>
      <Card><CardHeader><h2>Databassynk krävs</h2><Badge className="badge-warning">Inte redo</Badge></CardHeader><CardContent>
        <p>Kör väntande migrationer och generera därefter om Supabase-typerna.</p>
        <pre style={{ marginTop: 12, whiteSpace: "pre-wrap" }}>{queryErrors.join("\n")}</pre>
      </CardContent></Card>
    </ModuleOverview>;
  }

  const [capabilityResult, usersResult, devicesResult, numbersResult, userAllocationsResult, numberAllocationsResult, subscriptionsResult, conflictsResult, tenantsResult, heartbeatResult, jobsResult] = results;
  const capability = capabilityResult.data;
  const users = usersResult.data ?? [];
  const devices = devicesResult.data ?? [];
  const numbers = numbersResult.data ?? [];
  const canonicalUserIds = new Set(users.map((user) => user.id));
  const canonicalNumberIds = new Set(numbers.map((number) => number.id));
  const userAllocations = ((userAllocationsResult.data ?? []) as UserAllocationRow[]).filter((item) => canonicalUserIds.has(item.rinkel_user_id));
  const numberAllocations = ((numberAllocationsResult.data ?? []) as NumberAllocationRow[]).filter((item) => canonicalNumberIds.has(item.rinkel_number_id));
  const subscriptions = subscriptionsResult.data ?? [];
  const conflicts = conflictsResult.data ?? [];
  const tenants = tenantsResult.data ?? [];
  const heartbeat = heartbeatResult.data;
  const jobs = jobsResult.data ?? [];

  const tenantById = new Map(tenants.map((tenant) => [tenant.id, tenant.name]));
  const activeUserAllocation = new Map(userAllocations.filter((item) => item.status === "active" && !item.valid_to).map((item) => [item.rinkel_user_id, item]));
  const activeNumberAllocation = new Map(numberAllocations.filter((item) => item.status === "active" && !item.valid_to).map((item) => [item.rinkel_number_id, item]));
  const devicesByUser = new Map<string, typeof devices>();
  for (const device of devices) devicesByUser.set(device.platform_rinkel_user_id, [...(devicesByUser.get(device.platform_rinkel_user_id) ?? []), device]);
  const coreVerified = subscriptions.filter((item) => coreEvents.has(item.event_type) && item.status === "verified").length;
  const insights = subscriptions.find((item) => item.event_type === "callInsights");
  const jobCounts = new Map<string, number>();
  for (const job of jobs) jobCounts.set(job.status, (jobCounts.get(job.status) ?? 0) + 1);
  const oldestPending = jobs.find((job) => ["pending", "failed"].includes(job.status));
  const failedJobs = jobs.filter((job) => ["failed", "dead_letter"].includes(job.status)).slice(0, 20);
  const workerHealthy = Boolean(heartbeat?.last_success_at && Date.now() - Date.parse(heartbeat.last_success_at) < 3 * 60_000);
  const staleLockCutoff = Date.now() - 5 * 60_000;
  const staleLocks = jobs.filter((job) => job.status === "processing" && job.locked_at && Date.parse(job.locked_at) < staleLockCutoff).length;
  const apiKeyConfigured = Boolean(process.env.RINKEL_API_KEY);

  return <ModuleOverview
    title="Central Rinkel-telefoni"
    description="En central API-nyckel, explicit verifierade capabilities och historiserade tenantallokeringar."
    icon={Phone}
    features={features}
  >
    {params.error ? <p className="form-error">{params.error}</p> : null}
    {params.message ? <div className="notice">{params.message}</div> : null}

    <div className="grid grid-3">
      <Card><CardContent><strong>{apiKeyConfigured ? "Konfigurerad" : "Saknas"}</strong><p className="muted">RINKEL_API_KEY (visas aldrig)</p></CardContent></Card>
      <Card><CardContent><strong>{integration?.status ?? "not_configured"}</strong><p className="muted">central anslutning</p></CardContent></Card>
      <Card><CardContent><strong>{coreVerified}/4</strong><p className="muted">verifierade kärnwebhookar</p></CardContent></Card>
    </div>

    <Card>
      <CardHeader><h2><Plug size={17} /> Drift och verifierade capabilities</h2><Badge className={integration?.status === "connected" ? "badge-success" : "badge-warning"}>{integration?.status ?? "saknas"}</Badge></CardHeader>
      <CardContent>
        <div className="notice">
          API: {capability?.api_access ? "verifierat" : "ej verifierat"} · Användarkatalog: {capability?.users_catalog ? "verifierad" : "ej verifierad"} · Nummer­katalog: {capability?.numbers_catalog ? "verifierad" : "ej verifierad"}<br />
          Dialkonfiguration: {capability?.dial_configured ? "komplett" : "ofullständig"} · Verkligt testsamtal: {capability?.dial_test_succeeded ? "verifierat" : "ej verifierat"} · Dialendpoint: {capability?.dial_endpoint_reachable ? "verifierad" : "ej aktivt testad"}<br />
          Kärnwebhookar: {coreVerified}/4 · Insights: {insights?.status === "unsupported" ? "stöds inte av kontot" : insights?.status ?? "ej konfigurerad"} · Inspelning: {capability?.recording_detected ? "upptäckt" : "ej upptäckt"}
          {integration?.last_error_code ? <><br /><strong>{integration.last_error_code}</strong>: {integration.last_error_message} ({time(integration.last_error_at)})</> : null}
        </div>
        <div className="grid grid-3" style={{ marginTop: 14 }}>
          <form action={testPlatformRinkelConnection}><button className="button button-secondary">Testa API och katalog</button></form>
          <form action={syncPlatformRinkelDirectory}><button className="button button-secondary">Synkronisera katalog</button></form>
          <form action={configurePlatformRinkelWebhooks}><button className="button button-secondary">Registrera och testa webhookar</button></form>
        </div>
        <form action={setPlatformRinkelPaused} style={{ marginTop: 12 }}>
          <input type="hidden" name="paused" value={integration?.status === "disabled" ? "false" : "true"} />
          <button className={integration?.status === "disabled" ? "button button-primary" : "button button-ghost"}>
            {integration?.status === "disabled" ? "Återaktivera för ny verifiering" : "Pausa central telefoni"}
          </button>
        </form>
        <p className="muted" style={{ marginTop: 12 }}>Senaste API-test: {time(integration?.last_connection_test_at)} · katalogsynk: {time(integration?.last_successful_sync_at)} · webhook: {time(integration?.webhook_last_received_at)} · CDR: {time(integration?.last_reconciled_at)}</p>
      </CardContent>
    </Card>

    <Card>
      <CardHeader><h2>Worker och CDR-avstämning</h2><Badge className={workerHealthy ? "badge-success" : "badge-warning"}>{workerHealthy ? "Frisk" : "Inte frisk"}</Badge></CardHeader>
      <CardContent>
        <div className="grid grid-3">
          <div><strong>{time(heartbeat?.started_at)}</strong><p className="muted">senaste körning startad</p></div>
          <div><strong>{time(heartbeat?.last_success_at)}</strong><p className="muted">senaste lyckade körning</p></div>
          <div><strong>{jobCounts.get("pending") ?? 0} / {jobCounts.get("processing") ?? 0}</strong><p className="muted">pending / processing</p></div>
          <div><strong>{jobCounts.get("failed") ?? 0} / {jobCounts.get("dead_letter") ?? 0}</strong><p className="muted">failed / dead letter · stale locks {staleLocks} · äldst {time(oldestPending?.created_at)}</p></div>
        </div>
        <div className="toolbar-left" style={{ marginTop: 14 }}>
          <form action={runPlatformRinkelWorker}><button className="button button-secondary">Kör worker nu</button></form>
          <form action={runPlatformRinkelReconciliation}><button className="button button-secondary">Kör CDR-avstämning</button></form>
        </div>
      </CardContent>
    </Card>

    <div className="split-layout">
      <Card><CardHeader><h2>Rinkel-användare och enheter</h2><Badge>{users.length}</Badge></CardHeader><CardContent>{users.map((user) => {
        const allocation = activeUserAllocation.get(user.id);
        const userDevices = devicesByUser.get(user.id) ?? [];
        return <div className="activity-line" key={user.id}><span className="activity-dot"><ShieldCheck size={14} /></span><div style={{ flex: 1 }}><strong>{user.display_name}</strong><p>{userDevices.filter((device) => device.active).length} aktiva enheter · {allocation ? tenantById.get(allocation.tenant_id) ?? allocation.tenant_id : "ledig"}</p>{userDevices.map((device) => <p className="muted" key={device.id}>{device.display_name ?? device.provider_device_id} · {device.provider_status} · synk {time(device.last_synced_at)}</p>)}</div><Badge className={user.active ? "badge-success" : "badge-warning"}>{user.active ? "aktiv" : "inaktiv"}</Badge>{allocation ? <form action={revokePlatformRinkelResource}><input type="hidden" name="resource_type" value="user" /><input type="hidden" name="allocation_id" value={allocation.id} /><input type="hidden" name="reason" value="Återkallad av plattformsadmin" /><button className="button button-ghost button-sm">Återkalla</button></form> : null}</div>;
      })}</CardContent></Card>
      <Card><CardHeader><h2>Rinkel-nummer</h2><Badge>{numbers.length}</Badge></CardHeader><CardContent>{numbers.map((number) => {
        const allocation = activeNumberAllocation.get(number.id);
        return <div className="activity-line" key={number.id}><span className="activity-dot"><Phone size={14} /></span><div style={{ flex: 1 }}><strong>{number.phone_number_e164}</strong><p>{number.display_name ?? "Utan etikett"} · {allocation ? tenantById.get(allocation.tenant_id) ?? allocation.tenant_id : "ledigt"}{number.is_platform_default ? " · plattformsstandard" : ""}</p></div><Badge className={number.active ? "badge-success" : "badge-warning"}>{number.provider_status}</Badge>{number.active && !number.is_platform_default ? <form action={setPlatformDefaultRinkelNumber}><input type="hidden" name="number_id" value={number.id} /><button className="button button-ghost button-sm">Sätt reservstandard</button></form> : null}{allocation ? <form action={revokePlatformRinkelResource}><input type="hidden" name="resource_type" value="number" /><input type="hidden" name="allocation_id" value={allocation.id} /><input type="hidden" name="reason" value="Återkallad av plattformsadmin" /><button className="button button-ghost button-sm">Återkalla</button></form> : null}</div>;
      })}</CardContent></Card>
    </div>

    <Card><CardHeader><h2>Allokera eller flytta resurs</h2></CardHeader><CardContent><form action={allocatePlatformRinkelResource} className="form-stack">
      <SelectField label="Resurstyp" name="resource_type" required><option value="number">Telefonnummer</option><option value="user">Rinkel-användare</option></SelectField>
      <SelectField label="Resurs" name="resource_id" required><option value="">Välj resurs</option><optgroup label="Nummer">{numbers.filter((number) => number.active).map((number) => <option key={number.id} value={number.id}>{number.phone_number_e164}</option>)}</optgroup><optgroup label="Användare">{users.filter((user) => user.active).map((user) => <option key={user.id} value={user.id}>{user.display_name}</option>)}</optgroup></SelectField>
      <SelectField label="Tenant" name="tenant_id" required><option value="">Välj tenant</option>{tenants.map((tenant) => <option key={tenant.id} value={tenant.id}>{tenant.name}</option>)}</SelectField>
      <Field label="Anledning" name="reason" required />
      <button className="button button-primary">Allokera transaktionellt</button>
    </form></CardContent></Card>

    <div className="split-layout">
      <Card><CardHeader><h2>Webhookar</h2><Badge>{coreVerified}/4 kärnevent</Badge></CardHeader><CardContent>{subscriptions.map((subscription) => <div className="activity-line" key={subscription.event_type}><span className="activity-dot"><Plug size={14} /></span><div style={{ flex: 1 }}><strong>{subscription.event_type}</strong><p>{subscription.required ? "Obligatorisk" : "Valfri"} · provider {subscription.provider_active ? "aktiv" : "ej aktiv"} · HTTP {subscription.last_http_status ?? "–"}</p><p className="muted">Registrerad {time(subscription.registered_at)} · test begärt {time(subscription.test_requested_at)} · mottaget {time(subscription.test_received_at)} · processat {time(subscription.last_processed_at)} · events {subscription.received_count}/{subscription.processed_count}/{subscription.failed_count} mottagna/processade/fel</p>{subscription.last_error_code ? <p className="form-error">{subscription.last_error_code}: {subscription.last_error_message}</p> : null}</div><Badge className={subscription.status === "verified" ? "badge-success" : subscription.status === "unsupported" ? "" : "badge-warning"}>{subscription.status}</Badge></div>)}</CardContent></Card>
      <Card><CardHeader><h2>Öppna konflikter</h2><Badge className={conflicts.length ? "badge-warning" : "badge-success"}>{conflicts.length}</Badge></CardHeader><CardContent>{conflicts.length ? conflicts.map((conflict) => <div className="activity-line" key={conflict.id}><span className="activity-dot"><ShieldCheck size={14} /></span><div style={{ flex: 1 }}><strong>{conflict.conflict_type}</strong><p>{conflict.provider_resource_type} · {conflict.provider_resource_key}</p></div>{conflict.event_id ? <form action={reprocessPlatformRinkelEvent}><input type="hidden" name="conflict_id" value={conflict.id} /><button className="button button-ghost button-sm">Återbehandla</button></form> : null}</div>) : <p>Inga öppna korrelations- eller allokeringskonflikter.</p>}</CardContent></Card>
    </div>

    <Card><CardHeader><h2>Återköbara workerjobb</h2><Badge className={failedJobs.length ? "badge-warning" : "badge-success"}>{failedJobs.length}</Badge></CardHeader><CardContent>{failedJobs.length ? failedJobs.map((job) => <div className="activity-line" key={job.id}><div style={{ flex: 1 }}><strong>{job.job_type}</strong><p>{job.status} · försök {job.attempts}/{job.max_attempts} · {job.last_error_code ?? "utan felkod"}</p><p className="muted">{job.last_error_message ?? "–"}</p></div><form action={requeuePlatformRinkelJob}><input type="hidden" name="job_id" value={job.id} /><input type="hidden" name="reason" value="Manuellt återköat från telefonidriften" /><button className="button button-ghost button-sm">Återköa</button></form></div>) : <p>Inga failed- eller dead-letter-jobb i det hämtade driftfönstret.</p>}</CardContent></Card>
  </ModuleOverview>;
}
