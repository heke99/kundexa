import { ok } from "@/lib/supabase/read";
import { KeyRound, Phone, Plug } from "@/components/icons";
import { createClient } from "@/lib/supabase/server";
import { addPhoneNumber, generateResendWebhookAddress, saveSmsIntegration, saveContractReminderPolicy, saveEmailIntegration, testResendIntegration } from "@/app/actions/admin";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { Field, SelectField } from "@/components/ui/form-field";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
import { saveCallerIdDefault, saveTelephonyPolicy } from "@/app/actions/telephony";
import { getAppContext } from "@/lib/auth";
import { describeResendSendingDomain } from "@/lib/email/resend-domains";

type Config = Record<string, unknown>;

export default async function IntegrationsPage({ searchParams }: { searchParams: Promise<{ error?: string; message?: string; webhookToken?: string; resendWebhook?: string }> }) {
  const params = await searchParams;
  const supabase = await createClient();
  // Avsändarnamnet visas, det skrivs inte in. Samma källa som utskicket
  // använder, så det som står här är det som faktiskt hamnar i mottagarens
  // inkorg.
  const { tenantLegalName } = await getAppContext();
  // Hämtat från leverantören, inte påstått. Se `describeResendSendingDomain`.
  const sendingDomain = await describeResendSendingDomain();
  const [
    { data: integrations },
    { data: numbers },
    { data: members },
    { data: features },
    { data: reminderPolicy },
    { data: telephonyPolicy },
  ] = await Promise.all([
    ok(supabase.from("tenant_integrations").select("id,provider_type,provider,name,status,last_verified_at,configuration,credentials_ciphertext").order("created_at")),
    ok(supabase.from("phone_numbers").select("*").order("number_e164")),
    ok(supabase.from("tenant_memberships").select("user_id,role,profiles:user_id(full_name)").eq("status", "active")),
    ok(supabase.from("tenant_features").select("feature_key,enabled").in("feature_key", ["outbound_email", "contract_delivery_email", "outbound_sms", "contract_delivery_sms"])),
    ok(supabase.from("contract_reminder_policies").select("*").maybeSingle()),
    ok(supabase.from("telephony_policies").select("*").maybeSingle()),
  ]);
  // Bara nummer som är aktiva och bär röst kan visas för en mottagare. Att
  // erbjuda de andra i listan vore att låta någon välja ett val som sedan får
  // varje samtal att avvisas.
  const voiceNumbers = (numbers ?? []).filter((number) => number.status === "active" && number.supports_voice);
  const resend = integrations?.find((integration) => integration.provider === "resend") ?? null;
  const resendConfig = (resend?.configuration ?? {}) as Config;
  const featureMap = new Map((features ?? []).map((feature) => [feature.feature_key, feature.enabled]));
  const resendActive = resend?.status === "active";

  return <>
    <PageHeader title="Integrationer" description="Tenantseparerade leverantörsanslutningar för telefoni, SMS, e-post och avtalsleverans." />
    {params.error ? <p className="form-error">{params.error}</p> : null}
    {params.message ? <p className="notice">{params.message}</p> : null}
    {params.webhookToken ? <div className="notice warning"><strong>Spara numrets callback-token nu:</strong> <code>{params.webhookToken}</code></div> : null}
    {params.resendWebhook ? <div className="notice warning"><strong>Resend-webhookadress:</strong><br /><code style={{ wordBreak: "break-all" }}>{params.resendWebhook}</code><br />Lägg in adressen i Resend och spara webhook signing secret i formuläret. Adressen visas efter skapande eller rotation.</div> : null}

    <div className="grid grid-2" style={{ marginTop: 16 }}>
      <Card><CardHeader><h2><Plug size={17} /> Anslutningar</h2><Badge>{integrations?.length ?? 0}</Badge></CardHeader><CardContent>{integrations?.map((integration) => {
        const isTelephony = integration.provider_type === "voice" || integration.provider_type === "telephony";
        return <div className="activity-line" key={integration.id}><span className="activity-dot"><Plug size={14} /></span><div><strong>{isTelephony ? "Telefoni" : integration.name}</strong><p>{isTelephony ? "centralt hanterad" : `${integration.provider_type} · ${integration.provider}`}{integration.last_verified_at ? ` · verifierad ${formatDate(integration.last_verified_at)}` : ""}</p></div><Badge className={integration.status === "active" ? "badge-success" : integration.status === "error" ? "badge-warning" : "badge-info"}>{integration.status}</Badge></div>;
      })}</CardContent></Card>

      <Card><CardHeader><h2><Phone size={17} /> Telefoni</h2><Badge className="badge-info">Centralt hanterad</Badge></CardHeader><CardContent>
        <p className="muted">Samtalen kopplas i säljarens webbläsare. Ingen säljare behöver konto eller enhet hos telefonitjänsten — det räcker att hon är inloggad i Kundexa.</p>
        <p style={{ marginTop: 12 }}>{voiceNumbers.length} nummer kan användas som utgående nummer.</p>
      </CardContent></Card>

      <Card><CardHeader><h2>Utgående nummer</h2><Badge>{voiceNumbers.length}</Badge></CardHeader><CardContent>
        <p className="muted">Numret mottagaren ser. Det mest specifika valet vinner: lista, kampanj, team, företagets förval.</p>
        {voiceNumbers.length === 0
          ? <div className="notice warning" style={{ marginTop: 12 }}>Företaget har inget aktivt nummer med rösttrafik. Utan ett sådant kan inga samtal ringas — lägg till ett nummer nedan först.</div>
          : <form action={saveCallerIdDefault} className="form-stack" style={{ marginTop: 12 }}>
            <input type="hidden" name="scope" value="tenant" />
            <SelectField label="Företagets förvalda nummer" name="phone_number_id" defaultValue={telephonyPolicy?.default_caller_id_phone_number_id ?? ""}>
              <option value="">Inget valt</option>
              {voiceNumbers.map((number) => <option key={number.id} value={number.id}>{number.number_e164}</option>)}
            </SelectField>
            <button className="button button-secondary">Spara utgående nummer</button>
          </form>}
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
          <div className="grid grid-2"><Field label="Tillåtet från" name="allowed_start_time" type="time" defaultValue={String(telephonyPolicy?.allowed_start_time ?? "08:00").slice(0, 5)} /><Field label="Tillåtet till" name="allowed_end_time" type="time" defaultValue={String(telephonyPolicy?.allowed_end_time ?? "21:00").slice(0, 5)} /></div>
          <fieldset className="form-stack" style={{ border: 0, padding: 0 }}>
            <legend className="muted">Veckodagar då samtal får ringas</legend>
            {[[1,"Måndag"],[2,"Tisdag"],[3,"Onsdag"],[4,"Torsdag"],[5,"Fredag"],[6,"Lördag"],[7,"Söndag"]].map(([day, label]) =>
              <label key={String(day)}><input type="checkbox" name={`allowed_day_${day}`} defaultChecked={(telephonyPolicy?.allowed_days ?? [1,2,3,4,5,6,7]).includes(Number(day))} /> {label}</label>)}
          </fieldset>
          <Field label="Tidszon" name="timezone" defaultValue={telephonyPolicy?.timezone ?? "Europe/Stockholm"} />
          <label><input type="checkbox" name="disposition_required" defaultChecked={telephonyPolicy?.disposition_required ?? true} /> Kräv samtalsresultat före nästa prospekt</label>
          <label><input type="checkbox" name="allow_seller_playback" defaultChecked={telephonyPolicy?.allow_seller_playback ?? false} /> Säljare får lyssna på egna inspelningar</label>
          <label><input type="checkbox" name="allow_team_leader_playback" defaultChecked={telephonyPolicy?.allow_team_leader_playback ?? false} /> Teamledare får lyssna på teamets inspelningar</label>
          <label><input type="checkbox" name="allow_tenant_admin_playback" defaultChecked={telephonyPolicy?.allow_tenant_admin_playback ?? true} /> Tenantadmin får lyssna</label>
          <label><input type="checkbox" name="delete_provider_recording_on_retention" defaultChecked={telephonyPolicy?.delete_provider_recording_on_retention ?? false} /> Radera även hos telefonitjänsten vid retention (extern destruktiv åtgärd)</label>
          <button className="button button-secondary">Spara telefonipolicy</button>
        </form>
      </CardContent></Card>

      <Card><CardHeader><h2>E-post och Resend</h2><Badge className={resendActive ? "badge-success" : "badge-warning"}>{resend?.status ?? "inte ansluten"}</Badge></CardHeader><CardContent>
        <div className="notice"><strong>Feature flags</strong><br />outbound_email: {featureMap.get("outbound_email") ? "aktiv" : "avstängd"}<br />contract_delivery_email: {featureMap.get("contract_delivery_email") ? "aktiv" : "avstängd"}<br />outbound_sms: {featureMap.get("outbound_sms") ? "aktiv" : "avstängd"}<br />contract_delivery_sms: {featureMap.get("contract_delivery_sms") ? "aktiv" : "avstängd"}</div>
        <form action={saveEmailIntegration} className="form-stack" style={{ marginTop: 14 }}>
          <div className="notice">
            Avtalspost skickas från Kundexas e-postkonto och verifierade domän — <code>{sendingDomain.domain || "ej konfigurerad"}</code>.
            <br />Avsändarnamnet är <strong>{tenantLegalName}</strong>, hämtat från företaget. Svarsadressen tas från det bolag som ställer ut avtalet, under Juridiska avsändarbolag — saknas den sätts ingen svarsadress. Inget av det fylls i här, och inget behöver testas innan ni skickar: kontot är detsamma för alla företag.
          </div>
          <Field label="Webhook signing secret" name="webhook_signing_secret" type="password" placeholder="Sparad – lämna tomt för att behålla" />
          <button className="button button-primary">Spara krypterat som väntande</button>
        </form>
        {resend ? <div className="grid grid-2" style={{ marginTop: 12 }}><form action={testResendIntegration}><input type="hidden" name="integration_id" value={resend.id} /><button className="button button-secondary">Skicka testmeddelande</button><p className="muted" style={{ marginTop: 6 }}>Frivilligt. Går till din egen inloggningsadress — utskick fungerar utan det.</p></form><form action={generateResendWebhookAddress}><input type="hidden" name="integration_id" value={resend.id} /><button className="button button-ghost">Generera ny webhookadress</button></form></div> : null}
        <div className={`notice ${sendingDomain.kind === "verified" ? "" : "warning"}`} style={{ marginTop: 14 }}>
          <strong>Avsändardomän hos Resend:</strong> {sendingDomain.message}
        </div>
        <div className="notice warning" style={{ marginTop: 10 }}>Sparad signeringshemlighet visas aldrig igen. Senaste test: {String(resendConfig.last_test_status ?? "inte utfört")}{resendConfig.last_tested_at ? ` · ${formatDate(String(resendConfig.last_tested_at))}` : ""}{resendConfig.last_error ? <><br /><strong>Fel:</strong> {String(resendConfig.last_error)}</> : null}</div>
      </CardContent></Card>

      <Card><CardHeader><h2>Avtalspåminnelser</h2><Badge>{reminderPolicy?.enabled ? "Aktiva" : "Avstängda"}</Badge></CardHeader><CardContent><form action={saveContractReminderPolicy} className="form-stack"><label><input type="checkbox" name="enabled" defaultChecked={reminderPolicy?.enabled ?? true} /> Automatiska påminnelser aktiva</label><div className="grid grid-2"><Field label="Första efter timmar" name="first_reminder_after_hours" type="number" min={1} max={8760} defaultValue={reminderPolicy?.first_reminder_after_hours ?? 24} /><Field label="Andra efter timmar" name="second_reminder_after_hours" type="number" min={1} max={8760} defaultValue={reminderPolicy?.second_reminder_after_hours ?? 72} /></div><Field label="Sista före utgång, timmar" name="final_reminder_before_expiry_hours" type="number" min={1} max={8760} defaultValue={reminderPolicy?.final_reminder_before_expiry_hours ?? 24} /><Field label="Max automatiska påminnelser" name="max_automatic_reminders" type="number" min={0} max={10} defaultValue={reminderPolicy?.max_automatic_reminders ?? 3} /><SelectField label="Standardkanal" name="default_channel" defaultValue={reminderPolicy?.default_channel ?? "email"}><option value="email">E-post</option><option value="sms">SMS</option><option value="both">Båda</option></SelectField><div className="grid grid-2"><Field label="Tyst tid börjar" name="quiet_hours_start" type="time" defaultValue={String(reminderPolicy?.quiet_hours_start ?? "20:00").slice(0, 5)} /><Field label="Tyst tid slutar" name="quiet_hours_end" type="time" defaultValue={String(reminderPolicy?.quiet_hours_end ?? "08:00").slice(0, 5)} /></div><Field label="Tidszon" name="timezone" defaultValue={reminderPolicy?.timezone ?? "Europe/Stockholm"} /><label><input type="checkbox" name="attach_pdf" defaultChecked={reminderPolicy?.attach_pdf ?? true} /> Bifoga kanonisk PDF i e-postpåminnelser</label><button className="button button-secondary">Spara påminnelsepolicy</button></form></CardContent></Card>

      <Card><CardHeader><h2><KeyRound size={17} /> SMS</h2></CardHeader><CardContent><div className="notice">SMS bär avtalsutskick och kundsvar, och går via Kundexas konto. Det som skiljer era meddelanden från andras är avsändarnumret.</div><form action={saveSmsIntegration} className="form-stack" style={{ marginTop: 14 }}><SelectField label="Region" name="region"><option value="eu">EU</option><option value="us">US</option></SelectField><button className="button button-primary">Spara</button></form></CardContent></Card>

      <Card><CardHeader><h2><Phone size={17} /> Telefonnummer</h2><Badge>{numbers?.length ?? 0}</Badge></CardHeader><CardContent style={{ padding: 0 }}><DataTable headers={["Nummer", "Voice", "SMS", "MMS", "Status"]}>{numbers?.map((number) => <tr key={number.id}><td><strong>{number.number_e164}</strong></td><td>{number.supports_voice ? "Ja" : "Nej"}</td><td>{number.supports_sms ? "Ja" : "Nej"}</td><td>{number.supports_mms ? "Ja" : "Nej"}</td><td><Badge className={number.status === "active" ? "badge-success" : ""}>{number.status}</Badge></td></tr>)}</DataTable></CardContent></Card>
      <Card><CardHeader><h2><Phone size={17} /> Nya nummer</h2></CardHeader><CardContent>
        <div className="notice">Nummer beställs av Kundexa. De hyrs i Kundexas leverantörskonto och faktureras Kundexa, så de går inte att hyra härifrån — kontakta oss så läggs numret upp på företaget.</div>
      </CardContent></Card>

      <Card><CardHeader><h2>Lägg till ett nummer ni redan har</h2></CardHeader><CardContent>
        <p className="muted" style={{ marginBottom: 12 }}>
          För nummer som är köpta någon annanstans. Ett nummer som hyrs här ovanför läggs in automatiskt.
        </p>
        <form action={addPhoneNumber} className="form-stack">
          <Field label="E.164-nummer" name="number_e164" placeholder="+46700000000" required />
          <label><input type="checkbox" name="voice" /> Kan bära samtal</label>
          <label><input type="checkbox" name="sms" /> Kan bära SMS</label>
          <button className="button button-secondary">Registrera nummer</button>
        </form>
      </CardContent></Card>
    </div>
  </>;
}
