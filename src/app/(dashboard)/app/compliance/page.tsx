import { ShieldCheck } from "@/components/icons";
import { createClient } from "@/lib/supabase/server";
import { getAppContext, isAdmin } from "@/lib/auth";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
import { configureNixProvider, createDataSubjectRequest, createLegalHold, executeDataSubjectErasure, executeDataSubjectRestriction, exportDataSubjectRequest, queueCustomerNixCheck, releaseLegalHold, setNixProviderStatus, verifyDataSubjectIdentity } from "@/app/actions/admin";

type SearchParams = Promise<{ message?: string; error?: string }>;

export default async function CompliancePage({ searchParams }: { searchParams: SearchParams }) {
  const context = await getAppContext();
  const admin = isAdmin(context.role);
  const params = await searchParams;
  const s = await createClient();
  const [blocks, configurations, jobs, checks, candidates, requests, holds] = await Promise.all([
    s.from("compliance_blocks").select("*,customers(display_name)").eq("active", true).order("created_at", { ascending: false }).limit(100),
    s.from("nix_provider_configurations").select("id,name,status,method,endpoint_template,allowed_domains,validity_days,updated_at").order("updated_at", { ascending: false }),
    s.from("nix_check_jobs").select("id,status,phone_e164,attempts,last_error,created_at,completed_at,customers(display_name)").order("created_at", { ascending: false }).limit(100),
    s.from("nix_checks").select("id,phone_e164,result,source,source_version,checked_at,valid_until,customers(display_name)").order("checked_at", { ascending: false }).limit(100),
    s.from("campaign_contact_candidates").select("campaign_id,customer_id,status,policy_reason,evaluated_at,campaigns(name),customers(display_name)").order("updated_at", { ascending: false }).limit(100),
    s.from("data_subject_requests").select("id,request_type,subject_reference,status,due_at,identity_verified_at,result_storage_path,processing_notes,created_at,customers(display_name)").order("created_at", { ascending: false }).limit(100),
    s.from("legal_holds").select("id,customer_id,reason,scope,active,starts_at,ends_at,customers(display_name)").eq("active", true).order("created_at", { ascending: false }).limit(100),
  ]);
  const data = blocks.data ?? [];
  return <>
    <PageHeader title="Spärrar och compliance" description="Central kontroll före samtal, SMS, e-post, kampanjtilldelning, automation och export." />
    {params.message ? <p className="notice success">{params.message}</p> : null}
    {params.error ? <p className="notice danger">{params.error}</p> : null}

    {admin ? <Card>
      <CardHeader><h2><ShieldCheck size={17} /> NIX-leverantör</h2><Badge>{configurations.data?.length ?? 0}</Badge></CardHeader>
      <CardContent>
        <form action={configureNixProvider} className="form-grid">
          <label>Namn<input name="name" required placeholder="NIX Telefon" /></label>
          <label>Metod<select name="method" defaultValue="GET"><option>GET</option><option>POST</option></select></label>
          <label className="span-2">Endpointmall<input name="endpoint_template" required placeholder="https://api.example.se/check/{{phone_e164}}" /></label>
          <label className="span-2">Tillåtna domäner<input name="allowed_domains" required placeholder="api.example.se" /></label>
          <label className="span-2">Tillåtna paths<input name="allowed_paths" placeholder="/check,/v1/nix" /></label>
          <label>API-nyckel<input name="api_key" type="password" autoComplete="new-password" /></label>
          <label>API-key header<input name="api_key_header" defaultValue="Authorization" /></label>
          <label>Resultatsökväg<input name="result_path" defaultValue="result" /></label>
          <label>Versionssökväg<input name="source_version_path" placeholder="version" /></label>
          <label className="span-2">Resultatmappning<textarea name="result_mapping" rows={3} defaultValue={'{"listed":"listed","not_listed":"not_listed","unknown":"unknown"}'} /></label>
          <label className="span-2">Request headers (JSON)<textarea name="request_headers" rows={2} defaultValue="{}" /></label>
          <label className="span-2">Query-parametrar (JSON)<textarea name="request_query" rows={2} defaultValue="{}" /></label>
          <label className="span-2">POST-body (JSON)<textarea name="request_body" rows={2} defaultValue={'{"phone_e164":"{{phone_e164}}"}'} /></label>
          <label>Giltighet, dagar<input name="validity_days" type="number" min="1" max="365" defaultValue="60" /></label>
          <label>Timeout, ms<input name="timeout_ms" type="number" min="1000" max="120000" defaultValue="15000" /></label>
          <label>Max återförsök<input name="max_retries" type="number" min="0" max="20" defaultValue="5" /></label>
          <div className="span-2"><button className="button" type="submit">Spara NIX-leverantör</button></div>
        </form>
        <DataTable headers={["Namn", "Status", "Metod", "Endpoint", "Giltighet", "Åtgärd"]}>
          {(configurations.data ?? []).map((configuration) => <tr key={configuration.id}>
            <td><strong>{configuration.name}</strong><div className="muted">{configuration.allowed_domains?.join(", ")}</div></td>
            <td><Badge>{configuration.status}</Badge></td><td>{configuration.method}</td><td>{configuration.endpoint_template}</td><td>{configuration.validity_days} dagar</td>
            <td><form action={setNixProviderStatus}><input type="hidden" name="id" value={configuration.id} /><input type="hidden" name="status" value={configuration.status === "active" ? "paused" : "active"} /><button className="button secondary" type="submit">{configuration.status === "active" ? "Pausa" : "Aktivera"}</button></form></td>
          </tr>)}
        </DataTable>
      </CardContent>
    </Card> : null}

    {admin ? <Card>
      <CardHeader><h2>Manuell NIX-kontroll</h2></CardHeader>
      <CardContent><form action={queueCustomerNixCheck} className="form-grid"><label className="span-2">Kund-ID<input name="customer_id" required placeholder="UUID för privatkund" /></label><label><input name="force" type="checkbox" /> Tvinga ny kontroll</label><div><button className="button" type="submit">Lägg i kö</button></div></form></CardContent>
    </Card> : null}

    {admin ? <Card>
      <CardHeader><h2>Integritetsbegäran och juridisk retention</h2><Badge>{requests.data?.length ?? 0}</Badge></CardHeader>
      <CardContent>
        <form action={createDataSubjectRequest} className="form-grid">
          <label>Kund-ID<input name="customer_id" required placeholder="UUID" /></label>
          <label>Typ<select name="request_type" defaultValue="access"><option value="access">Registerutdrag</option><option value="portability">Dataportabilitet</option><option value="rectification">Rättelse</option><option value="erasure">Radering</option><option value="restriction">Begränsning</option><option value="objection">Invändning</option></select></label>
          <label className="span-2">Ärendereferens<input name="subject_reference" required placeholder="Extern ärendereferens eller verifierad identitetsreferens" /></label>
          <label>Senast klart<input name="due_at" type="datetime-local" /></label><div><button className="button" type="submit">Skapa begäran</button></div>
        </form>
        <DataTable headers={["Kund / referens", "Typ", "Status", "Förfallo", "Resultat", "Åtgärder"]}>
          {(requests.data ?? []).map((request) => { const customer = Array.isArray(request.customers) ? request.customers[0] : request.customers; return <tr key={request.id}>
            <td><strong>{customer?.display_name ?? "–"}</strong><div className="muted">{request.subject_reference}</div></td><td>{request.request_type}</td><td><Badge>{request.status}</Badge></td><td>{formatDate(request.due_at)}</td><td>{request.result_storage_path ?? request.processing_notes ?? "–"}</td>
            <td><div className="button-row">
              {!request.identity_verified_at ? <form action={verifyDataSubjectIdentity}><input type="hidden" name="request_id" value={request.id} /><input type="hidden" name="verification_method" value="manual_admin_verification" /><button className="button secondary" type="submit">Verifiera identitet</button></form> : null}
              {request.identity_verified_at && ["access", "portability"].includes(request.request_type) && request.status !== "completed" ? <form action={exportDataSubjectRequest}><input type="hidden" name="request_id" value={request.id} /><button className="button secondary" type="submit">Skapa export</button></form> : null}
              {request.identity_verified_at && request.request_type === "erasure" && request.status !== "completed" ? <form action={executeDataSubjectErasure}><input type="hidden" name="request_id" value={request.id} /><button className="button danger" type="submit">Genomför radering</button></form> : null}
              {request.identity_verified_at && ["restriction", "objection"].includes(request.request_type) && request.status !== "completed" ? <form action={executeDataSubjectRestriction}><input type="hidden" name="request_id" value={request.id} /><button className="button danger" type="submit">Tillämpa spärr</button></form> : null}
            </div></td>
          </tr>; })}
        </DataTable>
        <h3>Juridisk spärr</h3>
        <form action={createLegalHold} className="form-grid"><label>Kund-ID<input name="customer_id" required placeholder="UUID" /></label><label>Omfattning<input name="scope" defaultValue="all" /></label><label className="span-2">Skäl<input name="reason" required /></label><div><button className="button" type="submit">Lägg juridisk spärr</button></div></form>
        <DataTable headers={["Kund", "Skäl", "Omfattning", "Start", "Åtgärd"]}>{(holds.data ?? []).map((hold) => { const customer = Array.isArray(hold.customers) ? hold.customers[0] : hold.customers; return <tr key={hold.id}><td>{customer?.display_name ?? hold.customer_id}</td><td>{hold.reason}</td><td>{hold.scope.join(", ")}</td><td>{formatDate(hold.starts_at)}</td><td><form action={releaseLegalHold}><input type="hidden" name="id" value={hold.id} /><button className="button secondary" type="submit">Frisläpp</button></form></td></tr>; })}</DataTable>
      </CardContent>
    </Card> : null}

    <Card><CardHeader><h2><ShieldCheck size={17} /> Aktiva spärrar</h2><Badge className="badge-danger">{data.length}</Badge></CardHeader><CardContent style={{ padding: 0 }}><DataTable headers={["Kund / kontakt", "Kanaler", "Orsak", "Källa", "Gäller till", "Skapad"]}>{data.map((b) => { const c = Array.isArray(b.customers) ? b.customers[0] : b.customers; return <tr key={b.id}><td><strong>{c?.display_name ?? b.phone_e164 ?? b.email ?? "Okänd"}</strong></td><td>{b.channels.join(", ")}</td><td>{b.reason}</td><td>{b.source}</td><td>{formatDate(b.expires_at)}</td><td>{formatDate(b.created_at)}</td></tr>; })}</DataTable></CardContent></Card>

    <Card><CardHeader><h2>NIX-jobb</h2><Badge>{jobs.data?.length ?? 0}</Badge></CardHeader><CardContent style={{ padding: 0 }}><DataTable headers={["Kund", "Telefon", "Status", "Försök", "Fel", "Skapad"]}>{(jobs.data ?? []).map((job) => { const customer = Array.isArray(job.customers) ? job.customers[0] : job.customers; return <tr key={job.id}><td>{customer?.display_name ?? "–"}</td><td>{job.phone_e164}</td><td><Badge>{job.status}</Badge></td><td>{job.attempts}</td><td>{job.last_error ?? "–"}</td><td>{formatDate(job.created_at)}</td></tr>; })}</DataTable></CardContent></Card>

    <Card><CardHeader><h2>Senaste NIX-resultat</h2><Badge>{checks.data?.length ?? 0}</Badge></CardHeader><CardContent style={{ padding: 0 }}><DataTable headers={["Kund", "Telefon", "Resultat", "Källa", "Kontrollerad", "Giltig till"]}>{(checks.data ?? []).map((check) => { const customer = Array.isArray(check.customers) ? check.customers[0] : check.customers; return <tr key={check.id}><td>{customer?.display_name ?? "–"}</td><td>{check.phone_e164}</td><td><Badge>{check.result}</Badge></td><td>{check.source}{check.source_version ? ` · ${check.source_version}` : ""}</td><td>{formatDate(check.checked_at)}</td><td>{formatDate(check.valid_until)}</td></tr>; })}</DataTable></CardContent></Card>

    <Card><CardHeader><h2>Kampanjgranskning</h2><Badge>{candidates.data?.length ?? 0}</Badge></CardHeader><CardContent style={{ padding: 0 }}><DataTable headers={["Kampanj", "Kund", "Status", "Orsak", "Utvärderad"]}>{(candidates.data ?? []).map((candidate) => { const campaign = Array.isArray(candidate.campaigns) ? candidate.campaigns[0] : candidate.campaigns; const customer = Array.isArray(candidate.customers) ? candidate.customers[0] : candidate.customers; return <tr key={`${candidate.campaign_id}:${candidate.customer_id}`}><td>{campaign?.name ?? "–"}</td><td>{customer?.display_name ?? "–"}</td><td><Badge>{candidate.status}</Badge></td><td>{candidate.policy_reason ?? "–"}</td><td>{formatDate(candidate.evaluated_at)}</td></tr>; })}</DataTable></CardContent></Card>
  </>;
}
