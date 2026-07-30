import { KeyRound, Phone, Plug } from "@/components/icons";
import { createClient } from "@/lib/supabase/server";
import { addPhoneNumber, generateResendWebhookAddress, save46ElksIntegration, saveContractReminderPolicy, saveEmailIntegration, testResendIntegration } from "@/app/actions/admin";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { Field, SelectField } from "@/components/ui/form-field";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
import {
  configureRinkelWebhooks,
  saveRinkelIntegration,
  saveRinkelUserMapping,
  saveTelephonyPolicy,
  syncRinkelDirectory,
  testRinkelConnection,
} from "@/app/actions/rinkel";

type Config = Record<string, unknown>;

export default async function IntegrationsPage({ searchParams }: { searchParams: Promise<{ error?: string; message?: string; webhookToken?: string; resendWebhook?: string }> }) {
  const params = await searchParams;
  const supabase = await createClient();
  const [
    { data: integrations },
    { data: numbers },
    { data: members },
    { data: features },
    { data: reminderPolicy },
    { data: rinkelUsers },
    { data: rinkelNumbers },
    { data: rinkelMappings },
    { data: telephonyPolicy },
    { data: rinkelCapabilities },
    { data: rinkelSubscriptions },
  ] = await Promise.all([
    supabase.from("tenant_integrations").select("id,provider_type,provider,name,status,last_verified_at,configuration,credentials_ciphertext").order("created_at"),
    supabase.from("phone_numbers").select("*").order("number_e164"),
    supabase.from("tenant_memberships").select("user_id,role,profiles:user_id(full_name)").eq("status", "active"),
    supabase.from("tenant_features").select("feature_key,enabled").in("feature_key", ["outbound_email", "contract_delivery_email", "outbound_sms", "contract_delivery_sms"]),
    supabase.from("contract_reminder_policies").select("*").maybeSingle(),
    supabase.from("rinkel_users").select("id,connection_id,external_user_id,external_device_id,email,display_name,active,last_synced_at").order("display_name"),
    supabase.from("rinkel_numbers").select("id,connection_id,external_number_id,phone_number_e164,display_name,active,recording_enabled,last_synced_at").order("phone_number_e164"),
    supabase.from("rinkel_user_mappings").select("id,kundexa_user_id,rinkel_user_id,default_number_id,active,updated_at"),
    supabase.from("telephony_policies").select("*").maybeSingle(),
    supabase.from("rinkel_capabilities").select("*").maybeSingle(),
    supabase.from("rinkel_webhook_subscriptions").select("event_type,status,last_verified_at,last_error").order("event_type"),
  ]);
  const resend = integrations?.find((integration) => integration.provider === "resend") ?? null;
  const rinkel = integrations?.find((integration) => integration.provider === "rinkel") ?? null;
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
      <Card><CardHeader><h2><Plug size={17} /> Anslutningar</h2><Badge>{integrations?.length ?? 0}</Badge></CardHeader><CardContent>{integrations?.map((integration) => <div className="activity-line" key={integration.id}><span className="activity-dot"><Plug size={14} /></span><div><strong>{integration.name}</strong><p>{integration.provider_type} · {integration.provider}{integration.last_verified_at ? ` · verifierad ${formatDate(integration.last_verified_at)}` : ""}</p></div><Badge className={integration.status === "active" ? "badge-success" : integration.status === "error" ? "badge-warning" : "badge-info"}>{integration.status}</Badge></div>)}</CardContent></Card>

      <Card><CardHeader><h2><Phone size={17} /> Rinkel telefoni</h2><Badge className={["connected", "active"].includes(rinkel?.status ?? "") ? "badge-success" : "badge-warning"}>{rinkel?.status ?? "inte ansluten"}</Badge></CardHeader><CardContent>
        <form action={saveRinkelIntegration} className="form-stack">
          <Field label="Rinkel API-nyckel" name="api_key" type="password" placeholder={rinkel?.credentials_ciphertext ? "Sparad – lämna tomt för att behålla" : "Rinkel API key"} />
          <button className="button button-primary">Spara krypterat</button>
        </form>
        {rinkel ? <div className="grid grid-3" style={{ marginTop: 12 }}>
          <form action={testRinkelConnection}><button className="button button-secondary">Testa anslutning</button></form>
          <form action={syncRinkelDirectory}><button className="button button-secondary">Synkronisera katalog</button></form>
          <form action={configureRinkelWebhooks}><button className="button button-secondary">Konfigurera webhookar</button></form>
        </div> : null}
        <div className="notice" style={{ marginTop: 14 }}>
          <strong>Capabilities</strong><br />
          API: {rinkelCapabilities?.api_access ? "aktiv" : "ej verifierad"} · Dial: {rinkelCapabilities?.dial ? "aktiv" : "ej verifierad"}<br />
          Webhookar: {rinkelCapabilities?.webhooks ? "aktiv" : "ej tillgänglig"} · Inspelning: {rinkelCapabilities?.recordings ? "aktiv hos minst ett nummer" : "ej verifierad"}<br />
          Transkribering: {rinkelCapabilities?.transcription ? "tillgänglig" : "ej verifierad"} · AI Insights: {rinkelCapabilities?.ai_insights ? "tillgänglig" : "ej verifierad"}
        </div>
        {rinkelSubscriptions?.length ? <div style={{ marginTop: 12 }}>{rinkelSubscriptions.map((subscription) => <div className="activity-line" key={subscription.event_type}><span className="activity-dot"><Plug size={13} /></span><div><strong>{subscription.event_type}</strong><p>{subscription.last_verified_at ? formatDate(subscription.last_verified_at) : "inte verifierad"}</p></div><Badge className={subscription.status === "active" ? "badge-success" : "badge-warning"}>{subscription.status}</Badge></div>)}</div> : null}
      </CardContent></Card>

      <Card><CardHeader><h2>Rinkel-säljarmappning</h2><Badge>{rinkelMappings?.filter((mapping) => mapping.active).length ?? 0}</Badge></CardHeader><CardContent>
        <form action={saveRinkelUserMapping} className="form-stack">
          <SelectField label="Kundexa-användare" name="kundexa_user_id" required><option value="">Välj användare</option>{members?.map((member) => { const profile = Array.isArray(member.profiles) ? member.profiles[0] : member.profiles; return <option key={member.user_id} value={member.user_id}>{profile?.full_name ?? member.user_id} · {member.role}</option>; })}</SelectField>
          <SelectField label="Rinkel-användare och enhet" name="rinkel_user_id" required><option value="">Välj Rinkel-användare</option>{rinkelUsers?.map((user) => <option key={user.id} value={user.id} disabled={!user.active || !user.external_device_id}>{user.display_name} · {user.external_device_id ? "enhet klar" : "enhet saknas"}{user.active ? "" : " · inaktiv"}</option>)}</SelectField>
          <SelectField label="Standardnummer" name="default_number_id" required><option value="">Välj Rinkel-nummer</option>{rinkelNumbers?.map((number) => <option key={number.id} value={number.id} disabled={!number.active}>{number.display_name ? `${number.display_name} · ` : ""}{number.phone_number_e164}{number.active ? "" : " · inaktivt"}</option>)}</SelectField>
          <button className="button button-primary">Spara mappning</button>
        </form>
        <div style={{ marginTop: 14 }}>{rinkelMappings?.filter((mapping) => mapping.active).map((mapping) => {
          const member = members?.find((item) => item.user_id === mapping.kundexa_user_id);
          const profile = member && (Array.isArray(member.profiles) ? member.profiles[0] : member.profiles);
          const user = rinkelUsers?.find((item) => item.id === mapping.rinkel_user_id);
          const number = rinkelNumbers?.find((item) => item.id === mapping.default_number_id);
          return <div className="activity-line" key={mapping.id}><span className="activity-dot"><Phone size={13} /></span><div><strong>{profile?.full_name ?? mapping.kundexa_user_id}</strong><p>{user?.display_name ?? "Rinkel-användare saknas"} · {number?.phone_number_e164 ?? "nummer saknas"}</p></div><Badge className="badge-success">Aktiv</Badge></div>;
        })}</div>
      </CardContent></Card>

      <Card><CardHeader><h2>Telefonipolicy</h2><Badge>{telephonyPolicy?.recording_enabled ? "Inspelning aktiv" : "Inspelning av"}</Badge></CardHeader><CardContent>
        <form action={saveTelephonyPolicy} className="form-stack">
          <label><input type="checkbox" name="recording_enabled" defaultChecked={telephonyPolicy?.recording_enabled ?? false} /> Inspelning ska vara aktiv enligt tenantpolicy</label>
          <SelectField label="Lagringsläge" name="recording_storage_mode" defaultValue={telephonyPolicy?.recording_storage_mode ?? "provider_only"}><option value="provider_only">Endast hos Rinkel</option><option value="kundexa_private_copy">Privat kopia i Kundexa</option></SelectField>
          <div className="grid grid-2"><Field label="Retention, dagar" name="recording_retention_days" type="number" min={1} max={3650} defaultValue={telephonyPolicy?.recording_retention_days ?? 90} /><Field label="Råevent, dagar" name="raw_event_retention_days" type="number" min={1} max={365} defaultValue={telephonyPolicy?.raw_event_retention_days ?? 30} /></div>
          <div className="grid grid-2"><Field label="Tillåtet från" name="allowed_start_time" type="time" defaultValue={String(telephonyPolicy?.allowed_start_time ?? "09:00").slice(0, 5)} /><Field label="Tillåtet till" name="allowed_end_time" type="time" defaultValue={String(telephonyPolicy?.allowed_end_time ?? "18:00").slice(0, 5)} /></div>
          <Field label="Tidszon" name="timezone" defaultValue={telephonyPolicy?.timezone ?? "Europe/Stockholm"} />
          <label><input type="checkbox" name="transcription_enabled" defaultChecked={telephonyPolicy?.transcription_enabled ?? false} /> Hämta transkribering</label>
          <label><input type="checkbox" name="ai_analysis_enabled" defaultChecked={telephonyPolicy?.ai_analysis_enabled ?? false} /> Tillåt Kundexa AI-förslag</label>
          <label><input type="checkbox" name="sync_notes_to_rinkel" defaultChecked={telephonyPolicy?.sync_notes_to_rinkel ?? false} /> Synkronisera anteckningar till Rinkel</label>
          <label><input type="checkbox" name="disposition_required" defaultChecked={telephonyPolicy?.disposition_required ?? true} /> Kräv samtalsresultat före nästa prospekt</label>
          <label><input type="checkbox" name="allow_seller_playback" defaultChecked={telephonyPolicy?.allow_seller_playback ?? false} /> Säljare får lyssna på egna inspelningar</label>
          <label><input type="checkbox" name="allow_team_leader_playback" defaultChecked={telephonyPolicy?.allow_team_leader_playback ?? false} /> Teamledare får lyssna på teamets inspelningar</label>
          <label><input type="checkbox" name="allow_tenant_admin_playback" defaultChecked={telephonyPolicy?.allow_tenant_admin_playback ?? true} /> Tenantadmin får lyssna</label>
          <label><input type="checkbox" name="delete_provider_recording_on_retention" defaultChecked={telephonyPolicy?.delete_provider_recording_on_retention ?? false} /> Radera även hos Rinkel vid retention (extern destruktiv åtgärd)</label>
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

      <Card><CardHeader><h2><KeyRound size={17} /> 46elks SMS</h2></CardHeader><CardContent><div className="notice warning">46elks används endast för befintlig SMS-trafik. All telefoni och click-to-call går via tenantens Rinkel-anslutning.</div><form action={save46ElksIntegration} className="form-stack" style={{ marginTop: 14 }}><SelectField label="Kontomodell" name="account_mode"><option value="tenant_owned">Tenantens eget konto</option><option value="kundexa_subaccount">Kundexa-subkonto</option></SelectField><Field label="API-användarnamn" name="username" required /><Field label="API-lösenord" name="password" type="password" required /><button className="button button-primary">Kryptera och spara</button></form></CardContent></Card>

      <Card><CardHeader><h2><Phone size={17} /> Telefonnummer</h2><Badge>{numbers?.length ?? 0}</Badge></CardHeader><CardContent style={{ padding: 0 }}><DataTable headers={["Nummer", "Voice", "SMS", "MMS", "Status"]}>{numbers?.map((number) => <tr key={number.id}><td><strong>{number.number_e164}</strong></td><td>{number.supports_voice ? "Ja" : "Nej"}</td><td>{number.supports_sms ? "Ja" : "Nej"}</td><td>{number.supports_mms ? "Ja" : "Nej"}</td><td><Badge className={number.status === "active" ? "badge-success" : ""}>{number.status}</Badge></td></tr>)}</DataTable></CardContent></Card>
      <Card><CardHeader><h2>Lägg till SMS-nummer</h2></CardHeader><CardContent><form action={addPhoneNumber} className="form-stack"><Field label="E.164-nummer" name="number_e164" placeholder="+46700000000" required /><input type="hidden" name="voice" value="" /><label><input type="checkbox" name="sms" /> SMS-capability</label><button className="button button-secondary">Registrera nummer</button></form></CardContent></Card>
    </div>
  </>;
}
