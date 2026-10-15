import { nativeSigningConfigured } from "@/lib/signing/orchestration";
import { prepareContractPreview } from "@/app/actions/contract-preview";
import { beginNativeContractSigning, resumeNativeContractSigning, cancelNativeContractSigning } from "@/app/actions/signing";
import { ok } from "@/lib/supabase/read";
import Link from "next/link";
import { ArrowLeft, Download, FileSignature, LockKeyhole, Phone, Send, Upload } from "@/components/icons";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { activateContract, cancelContract, cancelFutureContractReminders, deleteContract, extendContractExpiry, linkContractSourceCall, registerExternalContractCall, sendContract, sendContractReminder, uploadContractPdf } from "@/app/actions/contracts";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Field, SelectField, TextareaField } from "@/components/ui/form-field";
import { formatCurrency, formatDate } from "@/lib/utils";
import { getAppContext } from "@/lib/auth";
import { manualContractDispositions } from "@/lib/contracts/manual-dispositions";
import { contractEventLabel, contractStatusLabel, contractStatusTone, deliveryStatusLabel } from "@/lib/contracts/status-labels";
import { can, canAuthorContracts } from "@/lib/permissions";
import { isoToZonedLocalDateTime } from "@/lib/domain/time";
import { createAdminClient } from "@/lib/supabase/admin";
import { contractAcceptanceModes, contractDeliveryBlocker } from "@/lib/contracts/delivery-readiness";
import { callDirectionLabel, dispositionLabel } from "@/lib/ui/labels";

const acceptanceMethodLabels: Record<string, string> = { sms: "SMS-svar", web: "Via länken", sms_otp: "SMS-kod", email_otp: "E-postkod", bankid: "BankID", external_esign: "E-signering" };



export default async function ContractDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; message?: string }> }) {
  const { id } = await params;
  const query = await searchParams;
  const ctx = await getAppContext();
  // Eight different actions live on this page and they do not share one
  // permission. `contracts.read` opens the page, so kvalitet, ekonomi and
  // viewer reached all eight; a säljare reached förlängning and aktivering
  // they cannot perform, and backoffice reached utskick and påminnelser.
  // Each block below is now shown only to a role the action will accept.
  const mayWrite = can(ctx.role, "contracts.write");
  // Ett eget dokument ersätter texten från produktens avtal, och det är
  // författande. Kortet visades för alla som fick skriva och nekades sedan för
  // säljaren efter uppladdningen.
  const mayUploadDocument = canAuthorContracts(ctx.role, ctx.platformRole);
  const mayRegisterCall = can(ctx.role, "calls.create");
  const maySend = can(ctx.role, "contracts.send");
  const mayRemind = can(ctx.role, "contracts.remind");
  const mayExtend = can(ctx.role, "contracts.manage_expiry");
  const mayActivate = can(ctx.role, "contracts.activate");
  // Same two acts as the register offers, so the card and the list agree about
  // what is possible rather than each having its own half.
  const mayDelete = ["owner", "admin"].includes(ctx.role);
  const concluded = ["accepted", "signed", "active", "terminated", "superseded"];
  const supabase = await createClient();
  // Every datetime-local field below is read back by an action that parses it with
  // `zonedLocalDateTimeToIso(..., ctx.tenantTimezone)`. Pre-filling from the
  // server's own UTC offset, which is zero on Vercel, made the two disagree by the
  // whole offset — on the contract's response deadline among other things.
  const localDateTime = (value?: string | null) => isoToZonedLocalDateTime(value ?? null, ctx.tenantTimezone);
  const [{ data: contract }, { data: versions }, { data: documents }, { data: deliveries }, { data: events }, { data: acceptances }, { data: requests }, { data: reminders }, { data: evidence }] = await Promise.all([
    ok(supabase.from("contracts").select("*,customers(display_name,email,phone_e164),products(name),tenant_legal_entities(legal_name,organization_number)").eq("id", id).single()),
    ok(supabase.from("contract_versions").select("*").eq("contract_id", id).order("version", { ascending: false })),
    ok(supabase.from("contract_documents").select("*").eq("contract_id", id).order("created_at", { ascending: false })),
    ok(supabase.from("contract_deliveries").select("*,contract_recipients(full_name,email,phone_e164)").eq("contract_id", id).order("created_at", { ascending: false })),
    ok(supabase.from("contract_events").select("*").eq("contract_id", id).order("occurred_at", { ascending: false })),
    ok(supabase.from("contract_acceptances").select("*").eq("contract_id", id).order("created_at", { ascending: false })),
    ok(supabase.from("contract_acceptance_requests").select("*").eq("contract_id", id).order("created_at", { ascending: false })),
    ok(supabase.from("contract_reminders").select("*").eq("contract_id", id).order("scheduled_at", { ascending: true })),
    ok(supabase.from("evidence_packages").select("*").eq("contract_id", id).order("created_at", { ascending: false })),
  ]);
  if (!contract) notFound();
  const customer = Array.isArray(contract.customers) ? contract.customers[0] : contract.customers;
  const product = Array.isArray(contract.products) ? contract.products[0] : contract.products;
  const legalEntity = Array.isArray(contract.tenant_legal_entities) ? contract.tenant_legal_entities[0] : contract.tenant_legal_entities;
  const activeVersion = versions?.find((version) => version.id === contract.active_version_id);
  const { data: signingTemplate } = activeVersion?.template_version_id ? await supabase.from("contract_template_versions").select("signature_policy").eq("tenant_id", ctx.tenantId).eq("id", activeVersion.template_version_id).maybeSingle() : { data: null };
  const signaturePolicy = (activeVersion?.signature_policy_snapshot ?? signingTemplate?.signature_policy) as { method?: string } | null;
  const externalSigning = signaturePolicy?.method === "external_esign";
  const signingServiceConfigured = externalSigning && nativeSigningConfigured();
  const { data: signingEnvelope } = externalSigning ? await supabase.from("signing_envelopes").select("id,status,created_at").eq("tenant_id", ctx.tenantId).eq("contract_id", id).order("created_at", { ascending: false }).limit(1).maybeSingle() : { data: null };
  const activeRequest = requests?.find((request) => request.status === "pending") ?? null;
  const { data: sourceCall } = contract.source_call_id ? await supabase.from("calls").select("id,started_at,answered_at,ended_at,duration_seconds,direction,disposition,notes,user_id,metadata").eq("id", contract.source_call_id).maybeSingle() : { data: null };
  const { data: eligibleRaw } = await ok(supabase.rpc("resolve_contract_eligible_calls", { p_customer_id: contract.customer_id }));
  const eligibleCalls = (eligibleRaw ?? []) as Array<{ id: string; ended_at: string; disposition: string; duration_seconds: number; registered_manually: boolean }>;
  // Samma regel som registreringen i databasen, inte ringlistornas utfall.
  const dispositions = await manualContractDispositions(supabase, ctx.tenantId);
  const latestDelivery = deliveries?.[0] ?? null;
  const canonicalDocument = documents?.find((document) => document.contract_version_id === contract.active_version_id && ["generated_pdf", "source_pdf"].includes(document.document_type) && (document.metadata as Record<string, unknown> | null)?.canonical === true) ?? null;
  const accepted = acceptances?.[0] ?? null;
  const reminderSentCount = reminders?.filter((reminder) => reminder.status === "sent").length ?? 0;
  const now = new Date();
  const start = new Date(now.getTime() - 5 * 60_000);
  // Ett utgånget avtal skickas med en ny sista svarsdag, inte den som passerat --
  // annars nekades omutskicket vid första klicket.
  const defaultExpiry = contract.expires_at && new Date(contract.expires_at) > now ? contract.expires_at : new Date(now.getTime() + 7 * 86400000).toISOString();
  // Ett oklart SMS-svar på den öppna begäran: säljaren ska se det och ringa kunden.
  const unclearReplies = activeRequest ? (events ?? []).filter((event) => event.event_type === "contract.reply_needs_review"
    && (event.payload as Record<string, unknown> | null)?.request_id === activeRequest.id) : [];
  // Vilka kanaler som faktiskt går att skicka på. Förvalet var "E-post och SMS",
  // som stoppades för varje företag utan SMS -- säljaren fick ett fel på första
  // försöket och fick gissa sig till att byta kanal (FAILURE-0118).
  let channelBlockers: Record<"email" | "sms", string | null> = { email: null, sms: null };
  if (maySend || mayRemind) {
    try {
      const admin = createAdminClient();
      const [emailBlocker, smsBlocker, modes, smsNumber] = await Promise.all([
        contractDeliveryBlocker(admin, ctx.tenantId, "email"),
        contractDeliveryBlocker(admin, ctx.tenantId, "sms"),
        contractAcceptanceModes(admin, ctx.tenantId),
        admin.from("phone_numbers").select("id").eq("tenant_id", ctx.tenantId).eq("supports_sms", true).eq("status", "active").limit(1).maybeSingle(),
      ]);
      if (smsNumber.error) throw smsNumber.error;
      channelBlockers = {
        email: emailBlocker?.message ?? (!externalSigning && !modes.web ? "Godkännande via länken är avstängt, så ett mejl kan inte besvaras." : null),
        sms: smsBlocker?.message
          ?? (!smsNumber.data ? "Företaget har inget nummer som kan skicka SMS." : null)
          ?? (!modes.web && !modes.sms ? "Varken svar via länken eller via SMS är påslaget." : null),
      };
    } catch {
      const message = "Kanalens tillgänglighet kunde inte kontrolleras. Ladda om sidan innan du skickar.";
      channelBlockers = { email: message, sms: message };
    }
  }
  const { data: reminderRecipient, error: reminderRecipientError } = activeRequest && mayRemind
    ? await supabase.from("contract_recipients").select("email,phone_e164").eq("id", activeRequest.recipient_id).eq("contract_id", id).maybeSingle()
    : { data: null, error: null };
  const sendBlockers = { ...channelBlockers, sms: channelBlockers.sms ?? (!customer?.phone_e164 ? "Kunden saknar telefonnummer. Uppdatera kundkortet före SMS-utskick." : null) };
  const reminderBlockers = {
    email: channelBlockers.email ?? (reminderRecipientError ? "Påminnelsens mottagare kunde inte kontrolleras. Ladda om sidan." : !reminderRecipient?.email ? "Den aktiva acceptbegäran saknar e-postmottagare." : null),
    sms: channelBlockers.sms ?? (reminderRecipientError ? "Påminnelsens mottagare kunde inte kontrolleras. Ladda om sidan." : !reminderRecipient?.phone_e164 ? "Den aktiva acceptbegäran saknar SMS-mottagare." : null),
  };
  const optionsFor = (blockers: Record<"email" | "sms", string | null>) => [
    { value: "both", label: "E-post och SMS", blocker: blockers.email ?? blockers.sms },
    { value: "email", label: "E-post", blocker: blockers.email },
    { value: "sms", label: "SMS", blocker: blockers.sms },
  ];
  const channelOptions = optionsFor(sendBlockers);
  const reminderChannelOptions = optionsFor(reminderBlockers);
  const defaultChannel = channelOptions.find((option) => !option.blocker)?.value ?? "email";
  const defaultReminderChannel = reminderChannelOptions.find((option) => !option.blocker)?.value ?? "email";
  const noSendChannel = channelOptions.every((option) => Boolean(option.blocker));
  const noReminderChannel = reminderChannelOptions.every((option) => Boolean(option.blocker));

  return <>
    <Link href="/app/contracts" className="muted" style={{ display: "inline-flex", gap: 6, alignItems: "center", marginBottom: 16 }}><ArrowLeft size={15} /> Till avtal</Link>
    <PageHeader title={`${contract.contract_number} · ${contract.title}`} description={`${customer?.display_name ?? "Okänd kund"} · ${product?.name ?? "Fristående avtal"}`} action={<Badge className={contractStatusTone(contract.status)}>{contractStatusLabel(contract.status)}</Badge>} />
    {query.error ? <p className="form-error">{query.error}</p> : null}{query.message ? <p className="notice">{query.message}</p> : null}
    {!contract.source_call_id ? <div className="notice warning"><strong>Utskick blockerat:</strong> avtalet saknar ett giltigt tidigare kundsamtal. Utkastet kan granskas och kompletteras, men versionen låses inte förrän samtalet är länkat.</div> : null}
    {unclearReplies.length ? <div className="notice warning"><strong>Kunden svarade något som inte är ett besked:</strong> {unclearReplies.map((event) => `"${String((event.payload as Record<string, unknown> | null)?.raw_response ?? "")}"`).join(", ")}. Avtalet väntar fortfarande på svar – kontakta kunden.</div> : null}
    {latestDelivery && ["failed", "bounced", "complained", "suppressed", "dead_letter"].includes(latestDelivery.status) ? <div className="notice warning"><strong>Leveransfel:</strong> {latestDelivery.failure_message ?? deliveryStatusLabel(latestDelivery.status)}. Automatiska e-postpåminnelser stoppas vid permanent bounce, complaint eller suppression.</div> : null}

    <div className="split-layout" style={{ marginTop: 16 }}>
      <div className="grid">
        <Card><CardHeader><h2>Avtal</h2><LockKeyhole size={18} /></CardHeader><CardContent><dl className="key-value"><dt>Status</dt><dd>{contractStatusLabel(contract.status)}</dd><dt>Juridiskt bolag</dt><dd>{legalEntity?.legal_name ?? "—"}{legalEntity?.organization_number ? ` · ${legalEntity.organization_number}` : ""}</dd><dt>Kund</dt><dd>{customer?.display_name ?? "—"}</dd><dt>Produkt</dt><dd>{product?.name ?? "—"}</dd><dt>Värde</dt><dd>{formatCurrency(Number(contract.value), contract.currency)}</dd><dt>Start</dt><dd>{formatDate(contract.starts_on)}</dd><dt>Slut</dt><dd>{formatDate(contract.ends_on)}</dd><dt>Bindningstid</dt><dd>{contract.binding_months ? `${contract.binding_months} månader` : "—"}</dd><dt>Uppsägningstid</dt><dd>{contract.notice_months ? `${contract.notice_months} månader` : "—"}</dd><dt>Sista svarsdatum</dt><dd>{formatDate(contract.expires_at)}</dd><dt>Skapat</dt><dd>{formatDate(contract.created_at)}</dd></dl></CardContent></Card>
        {/* Bara den senaste versionen visas; äldre ligger ihopfällda. Hashar är
            bevisuppgifter för avtalsansvariga, inte något säljaren ska läsa. */}
        {versions?.map((version, index) => index > 0 ? <Card key={version.id}><CardContent><details><summary className="muted">Tidigare version {version.version}{version.locked_at ? " · låst" : ""}</summary><h3>{version.title}</h3><p style={{ lineHeight: 1.7, whiteSpace: "pre-wrap" }}>{version.rendered_body}</p>{version.rendered_terms ? <><h4>Villkor</h4><p style={{ lineHeight: 1.7, whiteSpace: "pre-wrap" }}>{version.rendered_terms}</p></> : null}</details></CardContent></Card> : <Card key={version.id}><CardHeader><h2>Version {version.version}</h2><Badge className={version.locked_at ? "badge-success" : ""}>{version.locked_at ? "Låst" : "Redigerbar"}</Badge></CardHeader><CardContent><h3>{version.title}</h3><p style={{ lineHeight: 1.7, whiteSpace: "pre-wrap" }}>{version.rendered_body}</p>{version.rendered_terms ? <><h4>Villkor</h4><p style={{ lineHeight: 1.7, whiteSpace: "pre-wrap" }}>{version.rendered_terms}</p></> : null}{mayUploadDocument ? <div className="notice"><strong>Snapshot SHA-256</strong><br /><code>{version.snapshot_hash ?? version.document_hash}</code></div> : null}</CardContent></Card>)}
        {maySend ? <Card><CardHeader><h2>Förhandsgranska avtalet</h2></CardHeader><CardContent>
          {canonicalDocument ? <iframe title="Ifyllt avtal" src={`/api/v1/contracts/${id}/documents/${canonicalDocument.id}?preview=1`} style={{ width: "100%", height: 650, border: "1px solid #d7e1dc" }} /> : <form action={prepareContractPreview}><input type="hidden" name="contract_id" value={id} /><p>Skapa PDF med avtalets sparade uppgifter och kontrollera innehållet före utskick.</p><button className="button button-secondary">Visa ifyllt avtal</button></form>}
        </CardContent></Card> : null}
        <Card><CardHeader><h2>Dokument</h2><Badge>{documents?.length ?? 0}</Badge></CardHeader><CardContent>{documents?.length ? documents.map((document) => <div className="activity-line" key={document.id}><span className="activity-dot"><FileSignature size={14} /></span><div><strong>{document.file_name}</strong><p>{(document.metadata as Record<string, unknown> | null)?.canonical === true ? "Avtalets PDF" : document.document_type}{mayUploadDocument ? ` · SHA ${document.sha256.slice(0, 16)}…` : ""}</p></div><Link className="button button-ghost" href={`/api/v1/contracts/${id}/documents/${document.id}`}><Download size={14} /> Hämta</Link></div>) : <p className="muted">Avtalets PDF skapas vid utskick eller väljs från en uppladdad PDF.</p>}</CardContent></Card>
        <Card><CardHeader><h2>Händelser</h2><Badge>{events?.length ?? 0}</Badge></CardHeader><CardContent>{events?.map((event) => <div className="activity-line" key={event.id}><span className="activity-dot"><FileSignature size={14} /></span><div><strong>{contractEventLabel(event.event_type)}</strong></div><time>{formatDate(event.occurred_at)}</time></div>)}</CardContent></Card>
      </div>

      <div className="grid">
        <Card><CardHeader><h3><Phone size={16} /> Källsamtal</h3>{sourceCall ? <Badge className="badge-success">Kopplat</Badge> : <Badge className="badge-warning">Saknas</Badge>}</CardHeader><CardContent>{sourceCall ? <dl className="key-value"><dt>Avslutat</dt><dd>{formatDate(sourceCall.ended_at)}</dd><dt>Riktning</dt><dd>{callDirectionLabel(sourceCall.direction)}</dd><dt>Utfall</dt><dd>{dispositionLabel(sourceCall.disposition)}</dd><dt>Längd</dt><dd>{sourceCall.duration_seconds ?? 0} sekunder</dd><dt>Typ</dt><dd>{(sourceCall.metadata as Record<string, unknown> | null)?.registered_manually === true ? "Externt, manuellt registrerat" : "Kundexa-samtal"}</dd><dt>Anteckning</dt><dd>{sourceCall.notes ?? "—"}</dd></dl> : <>
          {mayWrite && eligibleCalls.length ? <form action={linkContractSourceCall} className="form-stack"><input type="hidden" name="contract_id" value={id} /><SelectField label="Giltigt tidigare samtal" name="source_call_id" required><option value="">Välj samtal</option>{eligibleCalls.map((call) => <option key={call.id} value={call.id}>{formatDate(call.ended_at)} · {call.disposition} · {call.duration_seconds}s{call.registered_manually ? " · manuellt" : ""}</option>)}</SelectField><button className="button button-secondary">Länka samtal</button></form> : <p className="muted">{mayWrite ? "Inget avtalsgrundande samtal hittades." : "Din roll kan inte länka källsamtal till avtalet."}</p>}
          {mayRegisterCall ? <details style={{ marginTop: 14 }}><summary><strong>Registrera tidigare samtal</strong></summary><form action={registerExternalContractCall} className="form-stack" style={{ marginTop: 12 }}><input type="hidden" name="contract_id" value={id} /><input type="hidden" name="customer_id" value={contract.customer_id} /><Field label="Telefonnummer" name="phone_e164" defaultValue={customer?.phone_e164 ?? ""} required /><SelectField label="Riktning" name="direction"><option value="outbound">Utgående</option><option value="inbound">Inkommande</option></SelectField><Field label="Start" name="started_at" type="datetime-local" defaultValue={localDateTime(start.toISOString())} required /><Field label="Slut" name="ended_at" type="datetime-local" defaultValue={localDateTime(now.toISOString())} required /><SelectField label="Samtalsutfall" name="disposition" required><option value="">Välj</option>{dispositions?.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}</SelectField><TextareaField label="Anteckning" name="note" required /><Field label="Extern referens" name="external_reference" /><label><input type="checkbox" name="confirmed" required /> Jag bekräftar att samtalet genomfördes.</label><button className="button button-secondary">Registrera och länka</button></form></details> : null}
        </>}</CardContent></Card>

        {externalSigning && contract.status === "signed" && mayActivate ? <Card><CardHeader><h3><LockKeyhole size={16} /> Avtalet är signerat</h3></CardHeader><CardContent><p>Slutdokumentet och bevisen är sparade. Aktivering sker efter den separata kontrollen.</p><form action={activateContract}><input type="hidden" name="contract_id" value={id} /><button className="button button-primary">Aktivera efter beviskontroll</button></form></CardContent></Card> : null}
        {maySend && externalSigning ? <Card><CardHeader><h3><FileSignature size={16} /> Granska och skicka för underskrift</h3></CardHeader><CardContent>{!signingServiceConfigured ? <p className="notice warning">Företagets e-postutskick behöver konfigureras innan signeringsinbjudan kan skickas.</p> : null}{signingEnvelope ? <p>Signering: {({ creating: "Kontrollerar skapandet", draft: "Förbereds", sent: "Inväntar underskrift", partially_signed: "Delvis signerad", completed: "Signerad", declined: "Avböjd", expired: "Utgången", cancelled: "Avbruten", failed: "Behöver kontrolleras" } as Record<string, string>)[signingEnvelope.status] ?? "Behöver kontrolleras"}</p> : null}{signingEnvelope && ["sent", "partially_signed"].includes(signingEnvelope.status) ? <><form action={resumeNativeContractSigning}><input type="hidden" name="envelope_id" value={signingEnvelope.id} /><button className="button button-secondary">Kontrollera signeringsstatus</button></form>{mayWrite ? <form action={cancelNativeContractSigning}><input type="hidden" name="envelope_id" value={signingEnvelope.id} /><button className="button button-ghost">Avbryt signeringen</button></form> : null}</> : null}{signingEnvelope?.status === "creating" ? <form action={resumeNativeContractSigning}><input type="hidden" name="envelope_id" value={signingEnvelope.id} /><p className="muted">Kontrollera samma försök. Ett oklart utfall skapar aldrig en ny signering automatiskt.</p><button className="button button-secondary">Återuppta signering</button></form> : <form action={beginNativeContractSigning} className="form-stack"><input type="hidden" name="contract_id" value={id} /><input type="hidden" name="idempotency_key" value={crypto.randomUUID()} /><Field label="Mottagarens namn" name="recipient_name" defaultValue={String((contract.counterparty_snapshot as Record<string, unknown> | null)?.display_name ?? "")} readOnly required /><Field label="Mottagarens e-post" name="recipient_email" type="email" defaultValue={String((contract.counterparty_snapshot as Record<string, unknown> | null)?.email ?? "")} readOnly required /><Field label="Sista svarsdatum" name="expires_at" type="datetime-local" defaultValue={localDateTime(defaultExpiry)} required /><p className="muted">Den granskade PDF:en låses och skickas för underskrift. Kunden kan endast fylla i signaturfälten.</p>{channelBlockers.email ? <p className="notice warning">{channelBlockers.email}</p> : null}<button className="button button-primary" disabled={!signingServiceConfigured || Boolean(channelBlockers.email) || !sourceCall || !["ready", "sent", "delivered", "opened"].includes(contract.status) || Boolean(signingEnvelope && ["sent", "partially_signed", "completed"].includes(signingEnvelope.status))}>Lås och skicka för underskrift</button></form>}</CardContent></Card> : null}
        {maySend && !externalSigning ? <Card><CardHeader><h3><Send size={16} /> Granska och skicka</h3></CardHeader><CardContent><form action={sendContract} className="form-stack"><input type="hidden" name="contract_id" value={id} /><Field label="Mottagarens namn" name="recipient_name" defaultValue={customer?.display_name ?? ""} required /><Field label="Mottagarens e-post" name="recipient_email" type="email" defaultValue={customer?.email ?? ""} /><p className="muted">SMS-mottagare: {customer?.phone_e164 ?? "saknas"}. Numret hämtas från kundkortet.</p><SelectField label="Kanal" name="channel" defaultValue={defaultChannel}>{channelOptions.map((option) => <option key={option.value} value={option.value} disabled={Boolean(option.blocker)}>{option.label}{option.blocker ? " – går inte just nu" : ""}</option>)}</SelectField>{sendBlockers.sms ? <p className="muted" style={{ marginTop: -6 }}>SMS: {sendBlockers.sms}</p> : null}{channelBlockers.email ? <p className="muted" style={{ marginTop: -6 }}>E-post: {channelBlockers.email}</p> : null}<TextareaField label="Personlig introduktion" name="introduction" placeholder="Tack för samtalet. Här kommer avtalet vi gick igenom." /><Field label="Sista svarsdatum" name="expires_at" type="datetime-local" defaultValue={localDateTime(defaultExpiry)} required /><div className="notice warning"><strong>Låser avtalet och skickar det till kunden.</strong>{contract.status === "expired" ? <><br />Den gamla länken har löpt ut — ett nytt utskick ger en ny.</> : null}<br />Källsamtal: {sourceCall ? formatDate(sourceCall.ended_at) : "saknas"}</div><button className="button button-primary" disabled={noSendChannel || !sourceCall || !["ready", "sent", "delivered", "opened", "expired"].includes(contract.status)}><Send size={16} /> Lås och skicka</button></form></CardContent></Card> : null}

        {mayUploadDocument ? <Card><CardHeader><h3><Upload size={16} /> Ladda upp PDF</h3></CardHeader><CardContent><form action={uploadContractPdf} className="form-stack"><input type="hidden" name="contract_id" value={id} /><label className="field"><span>PDF-fil, högst 20 MB</span><input type="file" name="file" accept="application/pdf" required /></label><SelectField label="Användning" name="document_mode" defaultValue="attachment"><option value="attachment">Använd endast som bilaga</option><option value="canonical">Använd som avtalets PDF</option></SelectField><button className="button button-secondary"><Upload size={16} /> Ladda upp PDF</button></form></CardContent></Card> : null}

        <Card><CardHeader><h3>Utskick</h3><Badge>{deliveries?.length ?? 0}</Badge></CardHeader><CardContent>{deliveries?.map((delivery) => { const recipient = Array.isArray(delivery.contract_recipients) ? delivery.contract_recipients[0] : delivery.contract_recipients; return <div className="activity-line" key={delivery.id}><span className="activity-dot"><Send size={14} /></span><div><strong>{recipient?.full_name ?? "Mottagare"}</strong><p>{delivery.channel === "sms" ? "SMS" : "E-post"} · {deliveryStatusLabel(delivery.status)}</p>{delivery.failure_message ? <p className="form-error">{delivery.failure_message}</p> : null}</div><time>{formatDate(delivery.sent_at ?? delivery.created_at)}</time></div>; })}</CardContent></Card>

        <Card><CardHeader><h3>Påminnelser</h3><Badge>{reminderSentCount} skickade</Badge></CardHeader><CardContent>{reminders?.map((reminder) => <div className="activity-line" key={reminder.id}><span className="activity-dot"><Send size={14} /></span><div><strong>{reminder.kind === "automatic" ? `Automatisk ${reminder.sequence_number}` : "Manuell"}</strong><p>{reminder.channel} · {deliveryStatusLabel(reminder.status)}</p></div><time>{formatDate(reminder.sent_at ?? reminder.scheduled_at)}</time></div>)}{activeRequest && mayRemind ? <><form action={sendContractReminder} className="form-stack" style={{ marginTop: 14 }}><input type="hidden" name="contract_id" value={id} /><input type="hidden" name="idempotency_key" value={crypto.randomUUID()} /><p className="muted">Påminnelsen går till mottagaren i den aktiva acceptbegäran. E-post: {reminderRecipient?.email ?? "saknas"}. SMS: {reminderRecipient?.phone_e164 ?? "saknas"}.</p><SelectField label="Kanal" name="channel" defaultValue={defaultReminderChannel}>{reminderChannelOptions.map((option) => <option key={option.value} value={option.value} disabled={Boolean(option.blocker)}>{option.label}{option.blocker ? " – går inte just nu" : ""}</option>)}</SelectField>{reminderBlockers.email ? <p className="muted">E-post: {reminderBlockers.email}</p> : null}{reminderBlockers.sms ? <p className="muted">SMS: {reminderBlockers.sms}</p> : null}<TextareaField label="Personligt meddelande" name="personal_message" /><label><input type="checkbox" name="attach_pdf" defaultChecked /> Bifoga avtalets PDF i e-post</label><button className="button button-secondary" disabled={noReminderChannel}>Skicka påminnelse</button></form><form action={cancelFutureContractReminders} style={{ marginTop: 10 }}><input type="hidden" name="contract_id" value={id} /><button className="button button-ghost">Avbryt framtida påminnelser</button></form></> : <p className="muted">{activeRequest ? "Din roll kan inte skicka påminnelser." : "Ingen aktiv acceptbegäran."}</p>}</CardContent></Card>

        {activeRequest ? <Card><CardHeader><h3>Acceptans</h3><Badge>{deliveryStatusLabel(activeRequest.status)}</Badge></CardHeader><CardContent><dl className="key-value"><dt>Skapad</dt><dd>{formatDate(activeRequest.created_at)}</dd><dt>Öppnad</dt><dd>{formatDate(activeRequest.opened_at)}</dd><dt>Giltig till</dt><dd>{formatDate(activeRequest.expires_at)}</dd>{mayUploadDocument ? <><dt>Dokumenthash</dt><dd><code>{activeRequest.canonical_document_sha256?.slice(0, 24)}…</code></dd></> : null}</dl>{mayExtend ? <form action={extendContractExpiry} className="form-stack"><input type="hidden" name="contract_id" value={id} /><Field label="Förläng sista svarsdatum" name="expires_at" type="datetime-local" defaultValue={localDateTime(activeRequest.expires_at)} required /><button className="button button-secondary">Förläng svarsdatum</button></form> : null}</CardContent></Card> : null}
        {accepted ? <Card><CardHeader><h3><LockKeyhole size={16} /> {accepted.status === "declined" ? "Kunden avböjde" : "Dokumenterat godkännande"}</h3><Badge className={accepted.status === "declined" ? "badge-danger" : "badge-success"}>{deliveryStatusLabel(accepted.status)}</Badge></CardHeader><CardContent><dl className="key-value"><dt>Tidpunkt</dt><dd>{formatDate(accepted.accepted_at ?? accepted.created_at)}</dd><dt>Metod</dt><dd>{acceptanceMethodLabels[String(accepted.method)] ?? accepted.method}</dd><dt>Namn/fras</dt><dd>{accepted.acceptance_phrase ?? accepted.normalized_response ?? "—"}</dd>{mayUploadDocument ? <><dt>IP</dt><dd>{accepted.ip_address == null ? "—" : String(accepted.ip_address)}</dd><dt>Dokumenthash</dt><dd><code>{accepted.canonical_document_sha256?.slice(0, 24)}…</code></dd></> : null}</dl><p>Bevispaket: {evidence?.[0]?.status ?? "väntar"}</p>{contract.status === "accepted" && mayActivate ? <form action={activateContract}><input type="hidden" name="contract_id" value={id} /><button className="button button-primary"><LockKeyhole size={16} /> Aktivera efter beviskontroll</button></form> : null}</CardContent></Card> : null}
        {mayWrite && (!concluded.includes(contract.status) || (mayDelete && ["draft", "cancelled"].includes(contract.status)))
          ? <Card><CardHeader><h3>Avsluta avtalet</h3></CardHeader><CardContent>
              {!concluded.includes(contract.status) && contract.status !== "cancelled" && !(externalSigning && signingEnvelope && ["creating", "sent", "partially_signed"].includes(signingEnvelope.status))
                ? <><p className="muted">Avbryter avtalet och stänger kundens acceptlänk. Historiken ligger kvar.</p>
                    <form action={cancelContract}>
                      <input type="hidden" name="contract_id" value={id} />
                      <input type="hidden" name="return_to" value={`/app/contracts/${id}`} />
                      <button className="button button-secondary">Avbryt avtalet</button>
                    </form></>
                : null}
              {mayDelete && ["draft", "cancelled"].includes(contract.status)
                ? <><p className="muted" style={{ marginTop: 14 }}>
                      Radering går bara om avtalet aldrig skickat något. Har det utskick, acceptbegäran
                      eller bevispaket kopplat till sig stannar det kvar — den historiken får inte förstöras.
                    </p>
                    <form action={deleteContract}>
                      <input type="hidden" name="contract_id" value={id} />
                      <input type="hidden" name="return_to" value="/app/contracts" />
                      <button className="button button-danger">Radera avtalet</button>
                    </form></>
                : null}
            </CardContent></Card>
          : null}
      </div>
    </div>
  </>;
}
