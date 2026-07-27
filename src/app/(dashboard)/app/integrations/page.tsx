import { KeyRound, Phone, Plug } from "@/components/icons";
import { createClient } from "@/lib/supabase/server";
import { addPhoneNumber, addVoiceClient, generateResendWebhookAddress, save46ElksIntegration, saveContractReminderPolicy, saveEmailIntegration, testResendIntegration } from "@/app/actions/admin";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { Field, SelectField } from "@/components/ui/form-field";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";

type Config = Record<string, unknown>;

export default async function IntegrationsPage({ searchParams }: { searchParams: Promise<{ error?: string; message?: string; webhookToken?: string; resendWebhook?: string }> }) {
  const params = await searchParams;
  const supabase = await createClient();
  const [{ data: integrations }, { data: numbers }, { data: members }, { data: voiceClients }, { data: features }, { data: reminderPolicy }] = await Promise.all([
    supabase.from("tenant_integrations").select("id,provider_type,provider,name,status,last_verified_at,configuration,credentials_ciphertext").order("created_at"),
    supabase.from("phone_numbers").select("*").order("number_e164"),
    supabase.from("tenant_memberships").select("user_id,role,profiles:user_id(full_name)").eq("status", "active"),
    supabase.from("voice_clients").select("id,assigned_user_id,client_number_e164,status"),
    supabase.from("tenant_features").select("feature_key,enabled").in("feature_key", ["outbound_email", "contract_delivery_email", "outbound_sms", "contract_delivery_sms"]),
    supabase.from("contract_reminder_policies").select("*").maybeSingle(),
  ]);
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
      <Card><CardHeader><h2><Plug size={17} /> Anslutningar</h2><Badge>{integrations?.length ?? 0}</Badge></CardHeader><CardContent>{integrations?.map((integration) => <div className="activity-line" key={integration.id}><span className="activity-dot"><Plug size={14} /></span><div><strong>{integration.name}</strong><p>{integration.provider_type} · {integration.provider}{integration.last_verified_at ? ` · verifierad ${formatDate(integration.last_verified_at)}` : ""}</p></div><Badge className={integration.status === "active" ? "badge-success" : integration.status === "error" ? "badge-warning" : "badge-info"}>{integration.status}</Badge></div>)}</CardContent></Card>

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

      <Card><CardHeader><h2><KeyRound size={17} /> 46elks-konto</h2></CardHeader><CardContent><form action={save46ElksIntegration} className="form-stack"><SelectField label="Kontomodell" name="account_mode"><option value="tenant_owned">Tenantens eget konto</option><option value="kundexa_subaccount">Kundexa-subkonto</option></SelectField><Field label="API-användarnamn" name="username" required /><Field label="API-lösenord" name="password" type="password" required /><button className="button button-primary">Kryptera och spara</button></form></CardContent></Card>

      <Card><CardHeader><h2><Phone size={17} /> Telefonnummer</h2><Badge>{numbers?.length ?? 0}</Badge></CardHeader><CardContent style={{ padding: 0 }}><DataTable headers={["Nummer", "Voice", "SMS", "MMS", "Status"]}>{numbers?.map((number) => <tr key={number.id}><td><strong>{number.number_e164}</strong></td><td>{number.supports_voice ? "Ja" : "Nej"}</td><td>{number.supports_sms ? "Ja" : "Nej"}</td><td>{number.supports_mms ? "Ja" : "Nej"}</td><td><Badge className={number.status === "active" ? "badge-success" : ""}>{number.status}</Badge></td></tr>)}</DataTable></CardContent></Card>
      <Card><CardHeader><h2>Lägg till nummer</h2></CardHeader><CardContent><form action={addPhoneNumber} className="form-stack"><Field label="E.164-nummer" name="number_e164" placeholder="+46700000000" required /><label><input type="checkbox" name="voice" /> Voice-capability</label><label><input type="checkbox" name="sms" /> SMS-capability</label><button className="button button-secondary">Registrera nummer</button></form></CardContent></Card>
      <Card><CardHeader><h2>WebRTC-klienter</h2><Badge>{voiceClients?.length ?? 0}</Badge></CardHeader><CardContent>{voiceClients?.map((client) => <div className="activity-line" key={client.id}><span className="activity-dot"><Phone size={14} /></span><div><strong>{client.client_number_e164}</strong><p>Tilldelad användare · {client.status}</p></div></div>)}</CardContent></Card>
      <Card><CardHeader><h2>Tilldela WebRTC-klient</h2></CardHeader><CardContent><form action={addVoiceClient} className="form-stack"><SelectField label="Användare" name="user_id" required><option value="">Välj användare</option>{members?.map((member) => { const profile = Array.isArray(member.profiles) ? member.profiles[0] : member.profiles; return <option key={member.user_id} value={member.user_id}>{profile?.full_name ?? member.user_id} · {member.role}</option>; })}</SelectField><Field label="Klientnummer E.164" name="client_number_e164" placeholder="+4600100100" required /><Field label="SIP-användarnamn" name="sip_username" required /><Field label="SIP/WebRTC-lösenord" name="sip_password" type="password" required /><button className="button button-primary">Kryptera och tilldela</button></form></CardContent></Card>
    </div>
  </>;
}
