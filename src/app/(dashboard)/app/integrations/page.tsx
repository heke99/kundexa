import { KeyRound, Phone, Plug } from "@/components/icons";
import { createClient } from "@/lib/supabase/server";
import { addPhoneNumber, generateResendWebhookAddress, save46ElksIntegration, saveContractReminderPolicy, saveEmailIntegration, testResendIntegration } from "@/app/actions/admin";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { RinkelUserMappingForm } from "@/components/rinkel-user-mapping-form";
import { Field, SelectField } from "@/components/ui/form-field";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
import {
  saveRinkelCallerIdDefault,
  saveTelephonyPolicy,
} from "@/app/actions/rinkel";

type Config = Record<string, unknown>;
type TenantRinkelResources = {
  users: Array<{
    allocationId: string;
    userId: string;
    displayName: string;
    email: string | null;
    hasDevice: boolean;
    active: boolean;
    devices: Array<{ id: string; providerDeviceId: string; displayName: string | null; deviceType: string | null; status: string; active: boolean; lastSyncedAt: string }>;
  }>;
  numbers: Array<{ allocationId: string; numberId: string; number: string; displayName: string | null; recordingEnabled: boolean; active: boolean }>;
  mappings: Array<{ id: string; kundexaUserId: string; userAllocationId: string; numberAllocationId: string; selectedDeviceId: string | null; active: boolean }>;
  callerIdDefaults: {
    tenantDefaultAllocationId: string | null;
    teams: Array<{ id: string; name: string; numberAllocationId: string | null }>;
    lists: Array<{ id: string; name: string; numberAllocationId: string | null }>;
    campaigns: Array<{ id: string; name: string; numberAllocationId: string | null }>;
  };
  capabilities: {
    recordingDetected?: boolean;
    transcriptionSupported?: boolean;
    insightsSupported?: boolean;
    noteSyncSupported?: boolean;
    privateRecordingCopySupported?: boolean;
  };
};

export default async function IntegrationsPage({ searchParams }: { searchParams: Promise<{ error?: string; message?: string; webhookToken?: string; resendWebhook?: string }> }) {
  const params = await searchParams;
  const supabase = await createClient();
  const [
    { data: integrations },
    { data: numbers },
    { data: members },
    { data: features },
    { data: reminderPolicy },
    { data: rinkelResourceData },
    { data: telephonyPolicy },
  ] = await Promise.all([
    supabase.from("tenant_integrations").select("id,provider_type,provider,name,status,last_verified_at,configuration,credentials_ciphertext").order("created_at"),
    supabase.from("phone_numbers").select("*").order("number_e164"),
    supabase.from("tenant_memberships").select("user_id,role,profiles:user_id(full_name)").eq("status", "active"),
    supabase.from("tenant_features").select("feature_key,enabled").in("feature_key", ["outbound_email", "contract_delivery_email", "outbound_sms", "contract_delivery_sms"]),
    supabase.from("contract_reminder_policies").select("*").maybeSingle(),
    supabase.rpc("get_tenant_rinkel_resources"),
    supabase.from("telephony_policies").select("*").maybeSingle(),
  ]);
  const rinkelResources = (rinkelResourceData ?? {
    users: [], numbers: [], mappings: [],
    callerIdDefaults: { tenantDefaultAllocationId: null, teams: [], lists: [], campaigns: [] },
    capabilities: {},
  }) as TenantRinkelResources;
  const callerIdDefaults = rinkelResources.callerIdDefaults ?? { tenantDefaultAllocationId: null, teams: [], lists: [], campaigns: [] };
  const numberLabel = (allocationId: string | null) => rinkelResources.numbers.find((number) => number.allocationId === allocationId)?.number ?? "inte vald";
  const resend = integrations?.find((integration) => integration.provider === "resend") ?? null;
  const resendConfig = (resend?.configuration ?? {}) as Config;
  const featureMap = new Map((features ?? []).map((feature) => [feature.feature_key, feature.enabled]));
  const resendActive = resend?.status === "active";

  return <>
    <PageHeader title="Integrationer" description="Tenantseparerade leverantörsanslutningar för telefoni, SMS, e-post och avtalsleverans." />
    {params.error ? <p className="form-error">{params.error}</p> : null}
    {params.message ? <p className="notice">{params.message}</p> : null}
    {params.webhookToken ? <div className="notice warning"><strong>Spara 46elks callback-token nu:</strong> <code>{params.webhookToken}</code></div> : null}
    {params.resendWebhook ? <div className="notice warning"><strong>Resend-webhookadress:</strong><br /><code style={{ wordBreak: "break-all" }}>{params.resendWebhook}</code><br />Lägg in adressen i Resend och spara webhook signing secret i formuläret. Adressen visas efter skapande eller rotation.</div> : null}

    <div className="grid grid-2" style={{ marginTop: 16 }}>
      <Card><CardHeader><h2><Plug size={17} /> Anslutningar</h2><Badge>{integrations?.length ?? 0}</Badge></CardHeader><CardContent>{integrations?.map((integration) => {
        const isTelephony = integration.provider === "rinkel" || integration.provider_type === "voice" || integration.provider_type === "telephony";
        return <div className="activity-line" key={integration.id}><span className="activity-dot"><Plug size={14} /></span><div><strong>{isTelephony ? "Telefoni" : integration.name}</strong><p>{isTelephony ? "centralt hanterad" : `${integration.provider_type} · ${integration.provider}`}{integration.last_verified_at ? ` · verifierad ${formatDate(integration.last_verified_at)}` : ""}</p></div><Badge className={integration.status === "active" ? "badge-success" : integration.status === "error" ? "badge-warning" : "badge-info"}>{integration.status}</Badge></div>;
      })}</CardContent></Card>

      <Card><CardHeader><h2><Phone size={17} /> Telefoni</h2><Badge className="badge-info">Centralt hanterad</Badge></CardHeader><CardContent>
        <div className="notice">
          <strong>Telefoni tillhandahålls och administreras centralt av Kundexa.</strong><br />
          Företaget ansluter inget eget telefonikonto och lagrar ingen egen API-nyckel.
        </div>
        <p style={{ marginTop: 12 }}>Tilldelat: {rinkelResources.users.length} telefoni-användare och {rinkelResources.numbers.length} utgående nummer.</p>
      </CardContent></Card>

      <Card><CardHeader><h2>Säljarmappning för telefoni</h2><Badge>{rinkelResources.mappings.filter((mapping) => mapping.active).length}</Badge></CardHeader><CardContent>
        <RinkelUserMappingForm
          members={(members ?? []).map((member) => {
            const profile = Array.isArray(member.profiles) ? member.profiles[0] : member.profiles;
            return { userId: member.user_id, label: `${profile?.full_name ?? member.user_id} · ${member.role}` };
          })}
          users={rinkelResources.users}
          numbers={rinkelResources.numbers}
        />
        <div style={{ marginTop: 14 }}>{rinkelResources.mappings.filter((mapping) => mapping.active).map((mapping) => {
          const member = members?.find((item) => item.user_id === mapping.kundexaUserId);
          const profile = member && (Array.isArray(member.profiles) ? member.profiles[0] : member.profiles);
          const user = rinkelResources.users.find((item) => item.allocationId === mapping.userAllocationId);
          const number = rinkelResources.numbers.find((item) => item.allocationId === mapping.numberAllocationId);
          const device = user?.devices.find((item) => item.id === mapping.selectedDeviceId);
          return <div className="activity-line" key={mapping.id}><span className="activity-dot"><Phone size={13} /></span><div><strong>{profile?.full_name ?? mapping.kundexaUserId}</strong><p>{user?.displayName ?? "Telefoni-användare saknas"} · {device?.displayName ?? "Telefonienhet"} · {number?.number ?? "nummer saknas"}</p></div><Badge className="badge-success">Aktiv</Badge></div>;
        })}</div>
      </CardContent></Card>

      <Card><CardHeader><h2>Caller-ID-standarder</h2><Badge>Prioriterad resolver</Badge></CardHeader><CardContent>
        <p className="muted">Prioritet: explicit samtalsval → lista → kampanj → kundteam → säljarstandard → säljarteam → tenant → plattform.</p>
        <form action={saveRinkelCallerIdDefault} className="form-stack" style={{ marginTop: 12 }}>
          <SelectField label="Scope" name="scope_target" required>
            <option value="tenant">Tenantstandard · {numberLabel(callerIdDefaults.tenantDefaultAllocationId)}</option>
            <optgroup label="Team">{callerIdDefaults.teams.map((team) => <option key={team.id} value={`team:${team.id}`}>{team.name} · {numberLabel(team.numberAllocationId)}</option>)}</optgroup>
            <optgroup label="Ringlistor">{callerIdDefaults.lists.map((list) => <option key={list.id} value={`list:${list.id}`}>{list.name} · {numberLabel(list.numberAllocationId)}</option>)}</optgroup>
            <optgroup label="Kampanjer">{callerIdDefaults.campaigns.map((campaign) => <option key={campaign.id} value={`campaign:${campaign.id}`}>{campaign.name} · {numberLabel(campaign.numberAllocationId)}</option>)}</optgroup>
          </SelectField>
          <SelectField label="Utgående telefonnummer" name="number_allocation_id">
            <option value="">Rensa scope-standard</option>
            {rinkelResources.numbers.map((number) => <option key={number.allocationId} value={number.allocationId} disabled={!number.active}>{number.displayName ? `${number.displayName} · ` : ""}{number.number}</option>)}
          </SelectField>
          <button className="button button-secondary">Spara caller-ID-standard</button>
        </form>
      </CardContent></Card>

      <Card><CardHeader><h2>Telefonipolicy</h2><Badge>{telephonyPolicy?.recording_enabled ? "Inspelning aktiv" : "Inspelning av"}</Badge></CardHeader><CardContent>
        <form action={saveTelephonyPolicy} className="form-stack">
          <label><input type="checkbox" name="telephony_enabled" defaultChecked={telephonyPolicy?.telephony_enabled ?? false} /> Telefoni aktiv för företaget</label>
          <label><input type="checkbox" name="manual_dialer_enabled" defaultChecked={telephonyPolicy?.manual_dialer_enabled ?? true} /> Manuell dialer aktiv</label>
          <label><input type="checkbox" name="automatic_dialer_enabled" defaultChecked={telephonyPolicy?.automatic_dialer_enabled ?? false} /> Automatisk dialer aktiv när webhookhälsan är frisk</label>
          <label><input type="checkbox" name="recording_enabled" defaultChecked={telephonyPolicy?.recording_enabled ?? false} /> Inspelning ska vara aktiv enligt tenantpolicy</label>
          <SelectField label="Lagringsläge" name="recording_storage_mode" defaultValue="provider_only"><option value="provider_only">Endast hos telefonitjänsten</option></SelectField>
          <div className="notice">Privat Kundexa-kopia exponeras inte förrän den provideroberoende arkiveringskedjan är verifierad. UI:t sparar därför inte en kosmetisk inställning.</div>
          <div className="grid grid-2"><Field label="Retention, dagar" name="recording_retention_days" type="number" min={1} max={3650} defaultValue={telephonyPolicy?.recording_retention_days ?? 90} /><Field label="Råevent, dagar" name="raw_event_retention_days" type="number" min={1} max={365} defaultValue={telephonyPolicy?.raw_event_retention_days ?? 30} /></div>
          <div className="grid grid-2"><Field label="Tillåtet från" name="allowed_start_time" type="time" defaultValue={String(telephonyPolicy?.allowed_start_time ?? "09:00").slice(0, 5)} /><Field label="Tillåtet till" name="allowed_end_time" type="time" defaultValue={String(telephonyPolicy?.allowed_end_time ?? "18:00").slice(0, 5)} /></div>
          <Field label="Tidszon" name="timezone" defaultValue={telephonyPolicy?.timezone ?? "Europe/Stockholm"} />
          <label><input type="checkbox" name="transcription_enabled" disabled={!rinkelResources.capabilities.transcriptionSupported} defaultChecked={Boolean(rinkelResources.capabilities.transcriptionSupported && telephonyPolicy?.transcription_enabled)} /> Hämta transkribering {rinkelResources.capabilities.transcriptionSupported ? "" : "(ej verifierat stöd)"}</label>
          <label><input type="checkbox" name="ai_analysis_enabled" disabled={!rinkelResources.capabilities.insightsSupported} defaultChecked={Boolean(rinkelResources.capabilities.insightsSupported && telephonyPolicy?.ai_analysis_enabled)} /> Tillåt AI Insights {rinkelResources.capabilities.insightsSupported ? "" : "(ej verifierat stöd)"}</label>
          <div className="notice">Anteckningssynk till telefonitjänsten visas inte eftersom note-API-kapabiliteten ännu inte är verifierad. Kundexas CRM-anteckning är fortsatt primär.</div>
          <label><input type="checkbox" name="disposition_required" defaultChecked={telephonyPolicy?.disposition_required ?? true} /> Kräv samtalsresultat före nästa prospekt</label>
          <label><input type="checkbox" name="allow_seller_playback" defaultChecked={telephonyPolicy?.allow_seller_playback ?? false} /> Säljare får lyssna på egna inspelningar</label>
          <label><input type="checkbox" name="allow_team_leader_playback" defaultChecked={telephonyPolicy?.allow_team_leader_playback ?? false} /> Teamledare får lyssna på teamets inspelningar</label>
          <label><input type="checkbox" name="allow_tenant_admin_playback" defaultChecked={telephonyPolicy?.allow_tenant_admin_playback ?? true} /> Tenantadmin får lyssna</label>
          <label><input type="checkbox" name="delete_provider_recording_on_retention" defaultChecked={telephonyPolicy?.delete_provider_recording_on_retention ?? false} /> Radera även hos telefonitjänsten vid retention (extern destruktiv åtgärd)</label>
          <button className="button button-secondary">Spara telefonipolicy</button>
        </form>
      </CardContent></Card>

      <Card><CardHeader><h2>E-post och Resend</h2><Badge className={resendActive ? "badge-success" : "badge-warning"}>{resend?.status ?? "inte ansluten"}</Badge></CardHeader><CardContent>
        <div className="notice"><strong>Feature flags</strong><br />outbound_email: {featureMap.get("outbound_email") ? "aktiv" : "avstängd"}<br />contract_delivery_email: {featureMap.get("contract_delivery_email") ? "aktiv" : "avstängd"}</div>
        <form action={saveEmailIntegration} className="form-stack" style={{ marginTop: 14 }}>
          <SelectField label="Kontomodell" name="account_mode" defaultValue={String(resendConfig.account_mode ?? "tenant_owned")}><option value="tenant_owned">Tenantens eget Resend-konto</option><option value="platform_managed">Kundexas Resend-konto</option></SelectField>
          <Field label="Resend API-nyckel" name="api_key" type="password" placeholder={resend?.credentials_ciphertext ? "Sparad – lämna tomt för att behålla" : "re_..."} />
          <Field label="Avsändarnamn" name="from_name" defaultValue={String(resendConfig.from_name ?? "")} required />
          <Field label="Verifierad från-adress" name="from_address" type="email" defaultValue={String(resendConfig.from_address ?? resendConfig.from ?? "")} placeholder="avtal@utskick.foretag.se" required />
          <Field label="Reply-to" name="reply_to" type="email" defaultValue={String(resendConfig.reply_to ?? "")} placeholder="kundservice@foretag.se" />
          <Field label="Sändningsdomän" name="sending_domain" defaultValue={String(resendConfig.sending_domain ?? "")} placeholder="utskick.foretag.se" />
          <Field label="Testmottagare" name="test_recipient" type="email" defaultValue={String(resendConfig.test_recipient ?? "")} required />
          <Field label="Webhook signing secret" name="webhook_signing_secret" type="password" placeholder="Sparad – lämna tomt för att behålla" />
          <button className="button button-primary">Spara krypterat som väntande</button>
        </form>
        {resend ? <div className="grid grid-2" style={{ marginTop: 12 }}><form action={testResendIntegration}><input type="hidden" name="integration_id" value={resend.id} /><button className="button button-secondary">Testa anslutning</button></form><form action={generateResendWebhookAddress}><input type="hidden" name="integration_id" value={resend.id} /><button className="button button-ghost">Generera ny webhookadress</button></form></div> : null}
        <div className="notice warning" style={{ marginTop: 14 }}>Domänen måste vara verifierad i Resend. Sparad API-nyckel och signing secret visas aldrig igen. Senaste test: {String(resendConfig.last_test_status ?? "inte utfört")}{resendConfig.last_tested_at ? ` · ${formatDate(String(resendConfig.last_tested_at))}` : ""}{resendConfig.last_error ? <><br /><strong>Fel:</strong> {String(resendConfig.last_error)}</> : null}</div>
      </CardContent></Card>

      <Card><CardHeader><h2>Avtalspåminnelser</h2><Badge>{reminderPolicy?.enabled ? "Aktiva" : "Avstängda"}</Badge></CardHeader><CardContent><form action={saveContractReminderPolicy} className="form-stack"><label><input type="checkbox" name="enabled" defaultChecked={reminderPolicy?.enabled ?? true} /> Automatiska påminnelser aktiva</label><div className="grid grid-2"><Field label="Första efter timmar" name="first_reminder_after_hours" type="number" min={1} max={8760} defaultValue={reminderPolicy?.first_reminder_after_hours ?? 24} /><Field label="Andra efter timmar" name="second_reminder_after_hours" type="number" min={1} max={8760} defaultValue={reminderPolicy?.second_reminder_after_hours ?? 72} /></div><Field label="Sista före utgång, timmar" name="final_reminder_before_expiry_hours" type="number" min={1} max={8760} defaultValue={reminderPolicy?.final_reminder_before_expiry_hours ?? 24} /><Field label="Max automatiska påminnelser" name="max_automatic_reminders" type="number" min={0} max={10} defaultValue={reminderPolicy?.max_automatic_reminders ?? 3} /><SelectField label="Standardkanal" name="default_channel" defaultValue={reminderPolicy?.default_channel ?? "email"}><option value="email">E-post</option><option value="sms">SMS</option><option value="both">Båda</option></SelectField><div className="grid grid-2"><Field label="Tyst tid börjar" name="quiet_hours_start" type="time" defaultValue={String(reminderPolicy?.quiet_hours_start ?? "20:00").slice(0, 5)} /><Field label="Tyst tid slutar" name="quiet_hours_end" type="time" defaultValue={String(reminderPolicy?.quiet_hours_end ?? "08:00").slice(0, 5)} /></div><Field label="Tidszon" name="timezone" defaultValue={reminderPolicy?.timezone ?? "Europe/Stockholm"} /><label><input type="checkbox" name="attach_pdf" defaultChecked={reminderPolicy?.attach_pdf ?? true} /> Bifoga kanonisk PDF i e-postpåminnelser</label><button className="button button-secondary">Spara påminnelsepolicy</button></form></CardContent></Card>

      <Card><CardHeader><h2><KeyRound size={17} /> 46elks SMS</h2></CardHeader><CardContent><div className="notice warning">46elks används endast för befintlig SMS-trafik. All telefoni och click-to-call hanteras centralt av Kundexa.</div><form action={save46ElksIntegration} className="form-stack" style={{ marginTop: 14 }}><SelectField label="Kontomodell" name="account_mode"><option value="tenant_owned">Tenantens eget konto</option><option value="kundexa_subaccount">Kundexa-subkonto</option></SelectField><Field label="API-användarnamn" name="username" required /><Field label="API-lösenord" name="password" type="password" required /><button className="button button-primary">Kryptera och spara</button></form></CardContent></Card>

      <Card><CardHeader><h2><Phone size={17} /> Telefonnummer</h2><Badge>{numbers?.length ?? 0}</Badge></CardHeader><CardContent style={{ padding: 0 }}><DataTable headers={["Nummer", "Voice", "SMS", "MMS", "Status"]}>{numbers?.map((number) => <tr key={number.id}><td><strong>{number.number_e164}</strong></td><td>{number.supports_voice ? "Ja" : "Nej"}</td><td>{number.supports_sms ? "Ja" : "Nej"}</td><td>{number.supports_mms ? "Ja" : "Nej"}</td><td><Badge className={number.status === "active" ? "badge-success" : ""}>{number.status}</Badge></td></tr>)}</DataTable></CardContent></Card>
      <Card><CardHeader><h2>Lägg till SMS-nummer</h2></CardHeader><CardContent><form action={addPhoneNumber} className="form-stack"><Field label="E.164-nummer" name="number_e164" placeholder="+46700000000" required /><input type="hidden" name="voice" value="" /><label><input type="checkbox" name="sms" /> SMS-capability</label><button className="button button-secondary">Registrera nummer</button></form></CardContent></Card>
    </div>
  </>;
}
