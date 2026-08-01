import { createClient } from "npm:@supabase/supabase-js@2.110.7";
import { decryptJson } from "../_shared/crypto.ts";
import { inQuietHours } from "../_shared/reminder-time.ts";
import { RinkelClient } from "../_shared/rinkel.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const encryptionKey = Deno.env.get("KUNDEXA_ENCRYPTION_KEY")!;
const appUrl = Deno.env.get("APP_URL")!;
const cronSecret = Deno.env.get("CRON_SECRET")!;
const globalResendKey = Deno.env.get("RESEND_API_KEY") ?? "";
const globalEmailFromAddress = Deno.env.get("DEFAULT_EMAIL_FROM_ADDRESS") ?? "";
const globalEmailFromName = Deno.env.get("DEFAULT_EMAIL_FROM_NAME") ?? "Kundexa";
const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

type Job = {
  id: string;
  tenant_id: string;
  job_type: string;
  aggregate_id: string | null;
  payload: Record<string, unknown>;
  attempts: number;
};
type ElksCredentials = { username: string; password: string };
type EmailCredentials = { apiKey?: string; from?: string; webhookSigningSecret?: string; webhookPathToken?: string };
type EmailAttachmentRef = { document_id: string; filename?: string; mime_type?: string };

function cleanHeaderName(value: string) {
  return value.replace(/[<>\r\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
}

async function getTenant(tenantId: string) {
  const { data, error } = await supabase.from("tenants").select("name,legal_name").eq("id", tenantId).single();
  if (error || !data) throw new Error("tenant_not_found");
  return data;
}

async function get46ElksCredentials(tenantId: string): Promise<ElksCredentials> {
  const { data, error } = await supabase.from("tenant_integrations")
    .select("credentials_ciphertext")
    .eq("tenant_id", tenantId)
    .eq("provider", "46elks")
    .eq("status", "active")
    .limit(1)
    .single();
  if (error || !data?.credentials_ciphertext) throw new Error("46elks_integration_missing");
  return decryptJson<ElksCredentials>(data.credentials_ciphertext, encryptionKey);
}

async function getEmailConfig(tenantId: string) {
  const tenant = await getTenant(tenantId);
  const { data, error } = await supabase.from("tenant_integrations")
    .select("id,credentials_ciphertext,configuration,status")
    .eq("tenant_id", tenantId)
    .eq("provider_type", "email")
    .eq("provider", "resend")
    .limit(1)
    .maybeSingle();
  if (error || !data || data.status !== "active") throw new Error("permanent_email_resend_integration_not_active");
  const configuration = (data.configuration ?? {}) as Record<string, unknown>;
  const credentials = data.credentials_ciphertext
    ? await decryptJson<EmailCredentials>(data.credentials_ciphertext, encryptionKey)
    : {};
  const accountMode = String(configuration.account_mode ?? "tenant_owned");
  const apiKey = accountMode === "platform_managed" ? globalResendKey : credentials.apiKey;
  const address = String(configuration.from_address ?? configuration.from ?? credentials.from ?? globalEmailFromAddress);
  const fromName = cleanHeaderName(String(configuration.from_name ?? tenant.legal_name ?? globalEmailFromName));
  const replyTo = configuration.reply_to ? String(configuration.reply_to) : null;
  if (!apiKey) throw new Error("permanent_email_provider_not_configured");
  if (!/^\S+@\S+\.\S+$/.test(address)) throw new Error("permanent_email_from_address_invalid");
  return { apiKey, address, replyTo, formattedFrom: `${fromName} <${address}>`, tenant, integrationId: data.id };
}

async function post46Elks(path: string, credentials: ElksCredentials, values: Record<string, string>) {
  const response = await fetch(`https://api.46elks.com/a1/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${credentials.username}:${credentials.password}`)}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(values),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`46elks_${response.status}:${text.slice(0, 500)}`);
  return JSON.parse(text) as Record<string, unknown>;
}

async function processSms(job: Job) {
  const { data: sms, error } = await supabase.from("sms_messages").select("*")
    .eq("tenant_id", job.tenant_id).eq("id", job.aggregate_id).single();
  if (error || !sms) throw new Error("sms_not_found");
  if (sms.provider_message_id || ["created", "sent", "delivered"].includes(sms.status)) return;
  const [{ data: outboundSms }, { data: contractSms }] = await Promise.all([
    supabase.from("tenant_features").select("enabled").eq("tenant_id", job.tenant_id).eq("feature_key", "outbound_sms").maybeSingle(),
    supabase.from("tenant_features").select("enabled").eq("tenant_id", job.tenant_id).eq("feature_key", "contract_delivery_sms").maybeSingle(),
  ]);
  if (!outboundSms?.enabled) throw new Error("permanent_sms_outbound_feature_disabled");
  if (sms.contract_id && !contractSms?.enabled) throw new Error("permanent_sms_contract_delivery_feature_disabled");

  const { data: number } = await supabase.from("phone_numbers").select("webhook_token_ciphertext")
    .eq("tenant_id", job.tenant_id).eq("number_e164", sms.from_number).single();
  if (!number?.webhook_token_ciphertext) throw new Error("sms_number_token_missing");
  const token = await decryptJson<{ token: string }>(number.webhook_token_ciphertext, encryptionKey);

  await supabase.from("sms_messages").update({ status: "submitting" }).eq("id", sms.id);
  const result = await post46Elks("sms", await get46ElksCredentials(job.tenant_id), {
    from: sms.from_number,
    to: sms.to_number,
    message: sms.body,
    whendelivered: `${appUrl}/api/webhooks/46elks/sms/delivery?token=${encodeURIComponent(token.token)}`,
  });
  const sentAt = new Date().toISOString();
  await supabase.from("sms_messages").update({
    provider_message_id: String(result.id ?? ""),
    status: "created",
    sent_at: sentAt,
    parts: Number(result.parts ?? 1),
    cost: result.cost ? Number(result.cost) : null,
  }).eq("id", sms.id);
  await supabase.from("contract_deliveries").update({ status: "sent", provider_status: "submitted", sent_at: sentAt }).eq("sms_message_id", sms.id);
  await supabase.from("contract_reminders").update({ status: "sent", sent_at: sentAt }).eq("tenant_id", job.tenant_id).eq("sms_message_id", sms.id).in("status", ["queued", "scheduled"]);
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunk, bytes.length)));
  }
  return btoa(binary);
}

async function resolveEmailAttachments(email: Record<string, unknown>, tenantId: string) {
  const references = Array.isArray(email.attachments) ? email.attachments as EmailAttachmentRef[] : [];
  const resolved: Array<{ filename: string; content: string }> = [];
  for (const reference of references) {
    if (!reference?.document_id) throw new Error("permanent_email_attachment_reference_invalid");
    const { data: document, error } = await supabase.from("contract_documents")
      .select("id,tenant_id,contract_id,contract_version_id,file_name,storage_path,mime_type,size_bytes,sha256")
      .eq("tenant_id", tenantId).eq("id", reference.document_id).single();
    if (error || !document) throw new Error("permanent_email_attachment_document_not_found");
    if (email.contract_id && document.contract_id !== email.contract_id) throw new Error("permanent_email_attachment_contract_mismatch");
    if (document.mime_type !== "application/pdf" || Number(document.size_bytes ?? 0) <= 0 || Number(document.size_bytes ?? 0) > 20 * 1024 * 1024) {
      throw new Error("permanent_email_attachment_size_or_type_invalid");
    }
    const { data: blob, error: downloadError } = await supabase.storage.from("contract-documents").download(document.storage_path);
    if (downloadError || !blob) throw new Error("email_attachment_download_failed");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes.length !== Number(document.size_bytes)) throw new Error("permanent_email_attachment_size_mismatch");
    if (await sha256Bytes(bytes) !== document.sha256) throw new Error("permanent_email_attachment_hash_mismatch");
    resolved.push({ filename: reference.filename || document.file_name, content: bytesToBase64(bytes) });
  }
  return resolved;
}

async function processEmail(job: Job) {
  const { data: email, error } = await supabase.from("email_messages").select("*")
    .eq("tenant_id", job.tenant_id).eq("id", job.aggregate_id).single();
  if (error || !email) throw new Error("email_not_found");
  if (email.provider_message_id || ["sent", "delivered", "opened", "clicked"].includes(email.status)) return;

  const [{ data: outboundEmail }, { data: contractEmail }] = await Promise.all([
    supabase.from("tenant_features").select("enabled").eq("tenant_id", job.tenant_id).eq("feature_key", "outbound_email").maybeSingle(),
    supabase.from("tenant_features").select("enabled").eq("tenant_id", job.tenant_id).eq("feature_key", "contract_delivery_email").maybeSingle(),
  ]);
  if (!outboundEmail?.enabled) throw new Error("permanent_email_outbound_feature_disabled");
  if (email.contract_id && !contractEmail?.enabled) throw new Error("permanent_email_contract_delivery_feature_disabled");

  const config = await getEmailConfig(job.tenant_id);
  const attachments = await resolveEmailAttachments(email as Record<string, unknown>, job.tenant_id);
  await supabase.from("email_messages").update({ status: "submitting", provider_status: "submitting" }).eq("id", email.id);
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json",
      "Idempotency-Key": email.idempotency_key || `kundexa-email-${email.id}`,
    },
    body: JSON.stringify({
      from: email.from_address === "pending@kundexa.local" ? config.formattedFrom : email.from_address,
      to: email.to_addresses,
      cc: email.cc_addresses?.length ? email.cc_addresses : undefined,
      bcc: email.bcc_addresses?.length ? email.bcc_addresses : undefined,
      reply_to: email.reply_to_addresses?.[0] || config.replyTo || undefined,
      subject: email.subject,
      text: email.body_text,
      html: email.body_html || undefined,
      attachments: attachments.length ? attachments : undefined,
      tags: [{ name: "category", value: String(email.purpose ?? "transactional").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 50) }],
    }),
  });
  const result = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    const message = String(result.message ?? result.name ?? `http_${response.status}`).slice(0, 500);
    const permanent = [400, 401, 403, 404, 409, 422].includes(response.status);
    await supabase.from("email_messages").update({ status: "failed", provider_status: `http_${response.status}`, failure_code: permanent ? "permanent_provider_error" : "temporary_provider_error", error_message: message }).eq("id", email.id);
    await supabase.from("contract_deliveries").update({ status: "failed", provider_status: `http_${response.status}`, failure_code: permanent ? "permanent_provider_error" : "temporary_provider_error", failure_message: message }).eq("email_message_id", email.id);
    throw new Error(`${permanent ? "permanent_" : ""}email_${response.status}:${message}`);
  }
  const sentAt = new Date().toISOString();
  await supabase.from("email_messages").update({
    provider_message_id: String(result.id ?? ""),
    status: "sent",
    provider_status: "email.sent",
    sent_at: sentAt,
    from_address: email.from_address === "pending@kundexa.local" ? config.address : email.from_address,
  }).eq("id", email.id);
  await supabase.from("contract_deliveries").update({ status: "sent", provider_status: "email.sent", sent_at: sentAt }).eq("email_message_id", email.id);
  await supabase.from("contract_reminders").update({ status: "sent", sent_at: sentAt }).eq("tenant_id", job.tenant_id).eq("email_message_id", email.id).in("status", ["queued", "scheduled"]);
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

async function processContractReminder(job: Job) {
  const reminderId = String(job.payload.reminder_id ?? job.aggregate_id ?? "");
  const { data: reminder, error } = await supabase.from("contract_reminders").select("*")
    .eq("tenant_id", job.tenant_id).eq("id", reminderId).single();
  if (error || !reminder) throw new Error("reminder_not_found");
  if (["sent", "cancelled", "failed", "skipped"].includes(reminder.status)) return;
  const [{ data: request }, { data: contract }, { data: recipient }, { data: policy }] = await Promise.all([
    supabase.from("contract_acceptance_requests").select("id,status,expires_at,public_token_ciphertext,canonical_document_id,canonical_document_sha256,contract_version_id").eq("tenant_id", job.tenant_id).eq("id", reminder.acceptance_request_id).single(),
    supabase.from("contracts").select("id,contract_number,title,customer_id,first_sent_at").eq("tenant_id", job.tenant_id).eq("id", reminder.contract_id).single(),
    supabase.from("contract_recipients").select("id,full_name,email,phone_e164").eq("tenant_id", job.tenant_id).eq("id", reminder.recipient_id).single(),
    supabase.from("contract_reminder_policies").select("timezone,quiet_hours_start,quiet_hours_end").eq("tenant_id", job.tenant_id).maybeSingle(),
  ]);
  if (!request || !contract || !recipient) throw new Error("reminder_data_missing");
  if (request.status !== "pending" || new Date(request.expires_at) <= new Date()) {
    await supabase.from("contract_reminders").update({ status: "cancelled", cancelled_at: new Date().toISOString(), cancel_reason: request.status === "pending" ? "expired" : request.status }).eq("id", reminder.id);
    return;
  }
  const timezone = policy?.timezone ?? "Europe/Stockholm";
  if (policy && inQuietHours(new Date(), timezone, String(policy.quiet_hours_start), String(policy.quiet_hours_end))) {
    throw new Error("reminder_quiet_hours_retry");
  }
  if (!request.public_token_ciphertext) throw new Error("permanent_reminder_token_missing");
  const token = await decryptJson<{ token: string }>(request.public_token_ciphertext, encryptionKey);
  if (!token.token) throw new Error("permanent_reminder_token_invalid");
  const acceptUrl = `${appUrl}/accept/${token.token}`;
  const expiresLabel = new Intl.DateTimeFormat("sv-SE", { dateStyle: "long", timeStyle: "short", timeZone: timezone }).format(new Date(request.expires_at));
  const firstSentLabel = contract.first_sent_at ? new Intl.DateTimeFormat("sv-SE", { dateStyle: "long", timeStyle: "short", timeZone: timezone }).format(new Date(contract.first_sent_at)) : "tidigare";
  const tenant = await getTenant(job.tenant_id);
  const deliveryKind = reminder.kind === "automatic" ? "automatic_reminder" : "manual_reminder";
  const baseKey = reminder.kind === "automatic" ? `contract-reminder/${request.id}/${reminder.sequence_number}` : `contract-manual-reminder/${reminder.id}`;
  const channel = String(reminder.channel);
  let emailMessageId: string | null = reminder.email_message_id;
  let smsMessageId: string | null = reminder.sms_message_id;

  if (channel === "email" || channel === "both") {
    const { data: permanentFailure } = await supabase.from("contract_deliveries").select("id")
      .eq("tenant_id", job.tenant_id).eq("acceptance_request_id", request.id).eq("channel", "email")
      .in("status", ["bounced", "complained", "suppressed"]).limit(1).maybeSingle();
    if (!permanentFailure && recipient.email) {
      const subject = `Påminnelse om avtal ${contract.contract_number}`;
      const personal = reminder.personal_message ? `<p style="font-size:15px;line-height:1.65">${escapeHtml(String(reminder.personal_message))}</p>` : "";
      const html = `<!doctype html><html><body style="margin:0;background:#f3f6f5;font-family:Arial,sans-serif;color:#17202a"><table role="presentation" width="100%"><tr><td align="center" style="padding:28px 12px"><table role="presentation" width="100%" style="max-width:640px;background:#fff;border:1px solid #dfe7e5"><tr><td style="padding:26px 30px;background:#102b26;color:#fff"><strong>${escapeHtml(tenant.legal_name)}</strong></td></tr><tr><td style="padding:32px 30px"><h1>Påminnelse om avtal</h1><p>Hej ${escapeHtml(recipient.full_name)},</p><p>Avtal <strong>${escapeHtml(contract.contract_number)}</strong> väntar på ditt besked.</p>${personal}<p style="margin:28px 0"><a href="${escapeHtml(acceptUrl)}" style="background:#0d7d65;color:#fff;text-decoration:none;padding:13px 20px;border-radius:9px;font-weight:bold">Öppna avtalet</a></p><p>Ursprungligt utskick: ${escapeHtml(firstSentLabel)}<br>Sista svarsdatum: ${escapeHtml(expiresLabel)}</p><p style="word-break:break-all">${escapeHtml(acceptUrl)}</p></td></tr></table></td></tr></table></body></html>`;
      const text = `Hej ${recipient.full_name},\n\nPåminnelse om avtal ${contract.contract_number} – ${contract.title}.\n${acceptUrl}\nSista svarsdatum: ${expiresLabel}.`;
      const idempotencyKey = `${baseKey}/email`;
      const { data: email, error: emailError } = await supabase.from("email_messages").upsert({
        tenant_id: job.tenant_id, customer_id: contract.customer_id, contract_id: contract.id, direction: "outbound",
        from_address: "pending@kundexa.local", to_addresses: [recipient.email], subject, body_text: text, body_html: html,
        status: "queued", attachments: reminder.attach_pdf ? [{ document_id: request.canonical_document_id, filename: `${contract.contract_number}.pdf`, mime_type: "application/pdf" }] : [],
        idempotency_key: idempotencyKey, purpose: "contract_reminder",
      }, { onConflict: "tenant_id,idempotency_key" }).select("id").single();
      if (emailError || !email) throw new Error(emailError?.message ?? "reminder_email_create_failed");
      emailMessageId = email.id;
      await supabase.from("contract_deliveries").upsert({
        tenant_id: job.tenant_id, contract_id: contract.id, contract_version_id: request.contract_version_id, recipient_id: recipient.id,
        acceptance_request_id: request.id, channel: "email", status: "queued", email_message_id: email.id,
        delivery_kind: deliveryKind, attempt_number: 1, canonical_document_id: request.canonical_document_id,
        canonical_document_sha256: request.canonical_document_sha256, idempotency_key: idempotencyKey, scheduled_at: new Date().toISOString(),
      }, { onConflict: "tenant_id,idempotency_key" });
      await supabase.from("outbox_jobs").upsert({ tenant_id: job.tenant_id, job_type: "email.send", aggregate_type: "email_message", aggregate_id: email.id, payload: { email_message_id: email.id, acceptance_request_id: request.id, reminder_id: reminder.id }, idempotency_key: idempotencyKey, priority: 25 }, { onConflict: "tenant_id,idempotency_key", ignoreDuplicates: true });
    } else if (channel === "email") {
      await supabase.from("contract_reminders").update({ status: "cancelled", cancelled_at: new Date().toISOString(), cancel_reason: permanentFailure ? "permanent_email_failure" : "recipient_email_missing" }).eq("id", reminder.id);
      return;
    }
  }

  if (channel === "sms" || channel === "both") {
    if (recipient.phone_e164) {
      const { data: number } = await supabase.from("phone_numbers").select("number_e164").eq("tenant_id", job.tenant_id).eq("supports_sms", true).eq("status", "active").limit(1).maybeSingle();
      if (number) {
        const idempotencyKey = `${baseKey}/sms`;
        const body = `Påminnelse om avtal ${contract.contract_number} från ${tenant.legal_name}. Granska: ${acceptUrl}. Giltigt till ${expiresLabel}.`;
        const { data: sms, error: smsError } = await supabase.from("sms_messages").upsert({ tenant_id: job.tenant_id, customer_id: contract.customer_id, contract_id: contract.id, direction: "outbound", from_number: number.number_e164, to_number: recipient.phone_e164, body, status: "queued", idempotency_key: idempotencyKey, purpose: "contract_reminder" }, { onConflict: "tenant_id,idempotency_key" }).select("id").single();
        if (smsError || !sms) throw new Error(smsError?.message ?? "reminder_sms_create_failed");
        smsMessageId = sms.id;
        await supabase.from("contract_deliveries").upsert({ tenant_id: job.tenant_id, contract_id: contract.id, contract_version_id: request.contract_version_id, recipient_id: recipient.id, acceptance_request_id: request.id, channel: "sms", status: "queued", sms_message_id: sms.id, delivery_kind: deliveryKind, attempt_number: 1, canonical_document_id: request.canonical_document_id, canonical_document_sha256: request.canonical_document_sha256, idempotency_key: idempotencyKey, scheduled_at: new Date().toISOString() }, { onConflict: "tenant_id,idempotency_key" });
        await supabase.from("outbox_jobs").upsert({ tenant_id: job.tenant_id, job_type: "sms.send", aggregate_type: "sms_message", aggregate_id: sms.id, payload: { sms_message_id: sms.id, acceptance_request_id: request.id, reminder_id: reminder.id }, idempotency_key: idempotencyKey, priority: 25 }, { onConflict: "tenant_id,idempotency_key", ignoreDuplicates: true });
      } else if (channel === "sms") throw new Error("permanent_reminder_sms_number_missing");
    } else if (channel === "sms") throw new Error("permanent_reminder_recipient_phone_missing");
  }

  if (!emailMessageId && !smsMessageId) throw new Error("permanent_reminder_no_valid_channel");
  await supabase.from("contract_reminders").update({ status: "queued", email_message_id: emailMessageId, sms_message_id: smsMessageId }).eq("id", reminder.id);
  await supabase.from("contract_events").insert({ tenant_id: job.tenant_id, contract_id: contract.id, event_type: "contract.reminder_queued", payload: { reminder_id: reminder.id, channel, acceptance_request_id: request.id } });
}

async function processRecording(job: Job) {
  const wavUrl = String(job.payload.wav_url ?? "");
  const callId = String(job.payload.call_id ?? job.aggregate_id ?? "");
  if (!wavUrl || !callId) throw new Error("recording_payload_invalid");
  const credentials = await get46ElksCredentials(job.tenant_id);
  const response = await fetch(wavUrl, { headers: { Authorization: `Basic ${btoa(`${credentials.username}:${credentials.password}`)}` } });
  if (!response.ok) throw new Error(`recording_download_${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const sha = await sha256Bytes(bytes);
  const providerRecordingId = String(job.payload.provider_recording_id ?? callId);
  const path = `${job.tenant_id}/${callId}/${providerRecordingId.replace(/[^a-zA-Z0-9._-]/g, "_")}.wav`;
  const { error } = await supabase.storage.from("call-recordings").upload(path, bytes, { contentType: "audio/wav", upsert: true });
  if (error) throw error;
  await supabase.from("call_recordings").upsert({
    tenant_id: job.tenant_id,
    call_id: callId,
    provider_recording_id: providerRecordingId,
    storage_path: path,
    sha256: sha,
    size_bytes: bytes.length,
    duration_seconds: job.payload.duration ? Number(job.payload.duration) : null,
    retention_until: new Date(Date.now() + 90 * 86400000).toISOString(),
    status: "stored",
  }, { onConflict: "tenant_id,provider_recording_id" });
}

function escapePdfText(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)").replace(/[^\x20-\x7EåäöÅÄÖéÉ]/g, "?");
}

function wrapText(value: string, width = 92) {
  const words = value.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if ((line + " " + word).trim().length > width) { if (line) lines.push(line); line = word; }
    else line = (line + " " + word).trim();
  }
  if (line) lines.push(line);
  return lines;
}

function createTextPdf(title: string, sections: Array<{ heading: string; text: string }>) {
  const lines = [title, "", ...sections.flatMap((section) => [section.heading, ...wrapText(section.text), ""])].slice(0, 62);
  const stream = ["BT", "/F1 10 Tf", "50 790 Td", "13 TL"];
  for (const [index, line] of lines.entries()) {
    if (index === 0) stream.push("/F1 16 Tf");
    if (index === 1) stream.push("/F1 10 Tf");
    stream.push(`(${escapePdfText(line)}) Tj`, "T*");
  }
  stream.push("ET");
  const content = stream.join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${new TextEncoder().encode(content).length} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(new TextEncoder().encode(pdf).length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = new TextEncoder().encode(pdf).length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

async function sha256Bytes(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function singleRelation<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

async function processEvidence(job: Job) {
  const contractId = String(job.payload.contract_id ?? job.aggregate_id ?? "");
  const acceptanceId = String(job.payload.acceptance_id ?? "");
  const requestId = String(job.payload.acceptance_request_id ?? "");
  const [{ data: contract }, { data: versions }, { data: acceptances }, { data: events }, { data: documents }, { data: deliveries }, { data: emails }, { data: sms }, { data: request }] = await Promise.all([
    supabase.from("contracts").select("*,tenants(name,legal_name),customers(display_name,email,phone_e164)").eq("tenant_id", job.tenant_id).eq("id", contractId).single(),
    supabase.from("contract_versions").select("*").eq("tenant_id", job.tenant_id).eq("contract_id", contractId).order("version"),
    supabase.from("contract_acceptances").select("*").eq("tenant_id", job.tenant_id).eq("contract_id", contractId),
    supabase.from("contract_events").select("*").eq("tenant_id", job.tenant_id).eq("contract_id", contractId).order("occurred_at"),
    supabase.from("contract_documents").select("id,document_type,file_name,storage_path,mime_type,size_bytes,sha256,metadata,created_at").eq("tenant_id", job.tenant_id).eq("contract_id", contractId),
    supabase.from("contract_deliveries").select("*").eq("tenant_id", job.tenant_id).eq("contract_id", contractId).order("created_at"),
    supabase.from("email_messages").select("id,provider_message_id,status,provider_status,sent_at,delivered_at,error_code,error_message,created_at").eq("tenant_id", job.tenant_id).eq("contract_id", contractId).order("created_at"),
    supabase.from("sms_messages").select("id,provider_message_id,status,sent_at,delivered_at,error_code,error_message,created_at").eq("tenant_id", job.tenant_id).eq("contract_id", contractId).order("created_at"),
    requestId ? supabase.from("contract_acceptance_requests").select("*").eq("tenant_id", job.tenant_id).eq("id", requestId).single() : Promise.resolve({ data: null }),
  ]);
  if (!contract) throw new Error("contract_not_found");
  const { data: sourceCall } = contract.source_call_id
    ? await supabase.from("calls").select("id,started_at,answered_at,ended_at,duration_seconds,direction,disposition,user_id,metadata").eq("tenant_id", job.tenant_id).eq("id", contract.source_call_id).maybeSingle()
    : { data: null };
  const activeVersion = (versions ?? []).find((version) => version.id === contract.active_version_id) ?? versions?.[versions.length - 1];
  const acceptance = (acceptances ?? []).find((item) => item.id === acceptanceId) ?? acceptances?.[acceptances.length - 1];
  if (!activeVersion || !acceptance) throw new Error("evidence_version_or_acceptance_missing");
  const canonicalDocumentId = acceptance.canonical_document_id ?? request?.canonical_document_id;
  const canonicalHash = acceptance.canonical_document_sha256 ?? request?.canonical_document_sha256;
  const canonicalDocument = (documents ?? []).find((document) => document.id === canonicalDocumentId);
  if (!canonicalDocument || canonicalDocument.sha256 !== canonicalHash || canonicalDocument.mime_type !== "application/pdf") {
    throw new Error("canonical_document_binding_invalid_for_evidence");
  }
  const { data: canonicalBlob, error: canonicalDownloadError } = await supabase.storage.from("contract-documents").download(canonicalDocument.storage_path);
  if (canonicalDownloadError || !canonicalBlob) throw new Error("canonical_document_download_failed_for_evidence");
  const canonicalBytes = new Uint8Array(await canonicalBlob.arrayBuffer());
  if (await sha256Bytes(canonicalBytes) !== canonicalHash) throw new Error("canonical_document_hash_mismatch_for_evidence");

  const tenant = singleRelation(contract.tenants);
  const customer = singleRelation(contract.customers);
  const manifestBase = {
    schema: "kundexa.evidence.v2",
    generated_at: new Date().toISOString(),
    request_id: requestId || request?.id || null,
    acceptance_id: acceptanceId || acceptance.id,
    contract,
    active_version: activeVersion,
    snapshot_hash: activeVersion.snapshot_hash ?? activeVersion.document_hash,
    canonical_document: { id: canonicalDocument.id, sha256: canonicalHash, file_name: canonicalDocument.file_name, size_bytes: canonicalBytes.length },
    acceptance,
    source_call: sourceCall,
    deliveries,
    emails,
    sms,
    events,
    documents,
  };
  const manifestWithoutHash = new TextEncoder().encode(JSON.stringify(manifestBase, null, 2));
  const manifestHash = await sha256Bytes(manifestWithoutHash);
  const manifest = { ...manifestBase, manifest_hash: manifestHash };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
  const finalManifestHash = await sha256Bytes(manifestBytes);
  const key = acceptanceId || acceptance.id || requestId || job.id;
  const manifestPath = `${job.tenant_id}/${contractId}/evidence-${key}.json`;
  const { error: manifestUploadError } = await supabase.storage.from("contract-documents").upload(manifestPath, manifestBytes, { contentType: "application/json", upsert: true });
  if (manifestUploadError) throw manifestUploadError;

  // The accepted contractual copy preserves the exact canonical PDF bytes. Acceptance evidence is stored separately.
  const acceptedPath = `${job.tenant_id}/${contractId}/accepted-${key}.pdf`;
  const { error: acceptedUploadError } = await supabase.storage.from("contract-documents").upload(acceptedPath, canonicalBytes, { contentType: "application/pdf", upsert: true });
  if (acceptedUploadError) throw acceptedUploadError;

  const evidencePdf = createTextPdf(`Kundexa bevispaket ${contract.contract_number}`, [
    { heading: "Avtalsparter", text: `${tenant?.legal_name ?? "Tenant"} och ${customer?.display_name ?? "Kund"}` },
    { heading: "Avtal", text: `${contract.contract_number} · version ${activeVersion.version}` },
    { heading: "Snapshot SHA-256", text: activeVersion.snapshot_hash ?? activeVersion.document_hash ?? "saknas" },
    { heading: "Kanonisk PDF SHA-256", text: canonicalHash },
    { heading: "Accepterad PDF SHA-256", text: canonicalHash },
    { heading: "Acceptans", text: JSON.stringify({ id: acceptance.id, method: acceptance.method, status: acceptance.status, accepted_at: acceptance.accepted_at, name: acceptance.acceptance_phrase, ip: acceptance.ip_address, user_agent: acceptance.user_agent }) },
    { heading: "Källsamtal", text: JSON.stringify(sourceCall) },
    { heading: "Kommunikation", text: `${deliveries?.length ?? 0} leveranser, ${emails?.length ?? 0} e-postmeddelanden och ${sms?.length ?? 0} SMS ingår i manifestet.` },
    { heading: "Manifest SHA-256", text: finalManifestHash },
  ]);
  const evidenceHash = await sha256Bytes(evidencePdf);
  const evidencePath = `${job.tenant_id}/${contractId}/evidence-${key}.pdf`;
  const { error: evidenceUploadError } = await supabase.storage.from("contract-documents").upload(evidencePath, evidencePdf, { contentType: "application/pdf", upsert: true });
  if (evidenceUploadError) throw evidenceUploadError;

  const documentRows = [
    { document_type: "manifest", file_name: `evidence-${key}.json`, storage_path: manifestPath, mime_type: "application/json", size_bytes: manifestBytes.length, sha256: finalManifestHash },
    { document_type: "signed_pdf", file_name: `accepted-${contract.contract_number}.pdf`, storage_path: acceptedPath, mime_type: "application/pdf", size_bytes: canonicalBytes.length, sha256: canonicalHash },
    { document_type: "evidence_pdf", file_name: `evidence-${contract.contract_number}.pdf`, storage_path: evidencePath, mime_type: "application/pdf", size_bytes: evidencePdf.length, sha256: evidenceHash },
  ].map((row) => ({ ...row, tenant_id: job.tenant_id, contract_id: contractId, contract_version_id: contract.active_version_id, metadata: { acceptance_id: acceptance.id, request_id: requestId || request?.id || null, canonical_document_id: canonicalDocument.id, canonical_document_sha256: canonicalHash, manifest_hash: finalManifestHash, immutable: true } }));
  const insertedDocuments: Record<string, string> = {};
  for (const row of documentRows) {
    const { data, error } = await supabase.from("contract_documents").upsert(row, { onConflict: "tenant_id,storage_path" }).select("id,document_type").single();
    if (error || !data) throw error ?? new Error("evidence_document_insert_failed");
    insertedDocuments[data.document_type] = data.id;
  }

  const evidenceRow = {
    tenant_id: job.tenant_id,
    contract_id: contractId,
    contract_version_id: contract.active_version_id,
    acceptance_id: acceptance.id,
    status: "completed",
    manifest,
    manifest_hash: finalManifestHash,
    storage_path: manifestPath,
    canonical_document_id: canonicalDocument.id,
    canonical_document_sha256: canonicalHash,
    generated_at: new Date().toISOString(),
  };
  const { error: evidenceError } = await supabase.from("evidence_packages").upsert(evidenceRow, { onConflict: "tenant_id,acceptance_id" });
  if (evidenceError) throw evidenceError;
  await supabase.from("contract_events").insert({ tenant_id: job.tenant_id, contract_id: contractId, event_type: "evidence.completed", payload: { acceptance_id: acceptance.id, manifest_hash: finalManifestHash, signed_pdf_id: insertedDocuments.signed_pdf, evidence_pdf_id: insertedDocuments.evidence_pdf, canonical_document_id: canonicalDocument.id } });
}

async function processContractConfirmation(job: Job) {
  const requestId = String(job.payload.request_id ?? "");
  const acceptanceId = String(job.payload.acceptance_id ?? "");
  if (!requestId) throw new Error("confirmation_request_missing");
  const { data: request, error } = await supabase.from("contract_acceptance_requests")
    .select("id,tenant_id,contract_id,contract_version_id,recipient_id,canonical_document_sha256,accepted_at")
    .eq("tenant_id", job.tenant_id).eq("id", requestId).single();
  if (error || !request) throw new Error("confirmation_request_not_found");
  const [{ data: contract }, { data: recipient }, { data: tenant }, { data: acceptedDocument }, { data: evidenceDocument }, { data: acceptance }] = await Promise.all([
    supabase.from("contracts").select("contract_number,title,customer_id").eq("tenant_id", job.tenant_id).eq("id", request.contract_id).single(),
    supabase.from("contract_recipients").select("id,full_name,email,phone_e164").eq("tenant_id", job.tenant_id).eq("id", request.recipient_id).single(),
    supabase.from("tenants").select("legal_name").eq("id", job.tenant_id).single(),
    supabase.from("contract_documents").select("id,file_name,sha256").eq("tenant_id", job.tenant_id).eq("contract_id", request.contract_id).eq("document_type", "signed_pdf").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("contract_documents").select("id,file_name,sha256").eq("tenant_id", job.tenant_id).eq("contract_id", request.contract_id).eq("document_type", "evidence_pdf").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    acceptanceId ? supabase.from("contract_acceptances").select("accepted_at,acceptance_phrase").eq("tenant_id", job.tenant_id).eq("id", acceptanceId).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  if (!contract || !recipient || !tenant) throw new Error("confirmation_data_missing");
  if (!acceptedDocument) throw new Error("confirmation_waiting_for_signed_document");
  const acceptedAt = acceptance?.accepted_at ?? request.accepted_at ?? new Date().toISOString();
  const acceptedLabel = new Intl.DateTimeFormat("sv-SE", { dateStyle: "long", timeStyle: "short", timeZone: "Europe/Stockholm" }).format(new Date(acceptedAt));
  const text = `Hej ${recipient.full_name},\n\nDitt besked för avtal ${contract.contract_number} (${contract.title}) hos ${tenant.legal_name} registrerades ${acceptedLabel}. Den accepterade avtalskopian finns bifogad. Detta är en dokumenterad acceptans.\n\n${tenant.legal_name}`;
  const html = `<!doctype html><html><body style="margin:0;background:#f3f6f5;font-family:Arial,sans-serif;color:#17202a"><table role="presentation" width="100%"><tr><td align="center" style="padding:28px 12px"><table role="presentation" width="100%" style="max-width:640px;background:#fff;border:1px solid #dfe7e5"><tr><td style="padding:26px 30px;background:#102b26;color:#fff"><strong>${escapeHtml(tenant.legal_name)}</strong></td></tr><tr><td style="padding:32px 30px"><h1>Din acceptans är registrerad</h1><p>Hej ${escapeHtml(recipient.full_name)},</p><p>Ditt besked för avtal <strong>${escapeHtml(contract.contract_number)}</strong> registrerades ${escapeHtml(acceptedLabel)}.</p><p>Den accepterade avtalskopian finns bifogad. Detta är en dokumenterad acceptans.</p></td></tr></table></td></tr></table></body></html>`;

  if (recipient.email) {
    const idempotencyKey = `contract-confirmation/${acceptanceId || request.id}/email`;
    const attachments = [
      { document_id: acceptedDocument.id, filename: acceptedDocument.file_name, mime_type: "application/pdf" },
      ...(evidenceDocument ? [{ document_id: evidenceDocument.id, filename: evidenceDocument.file_name, mime_type: "application/pdf" }] : []),
    ];
    const { data: email, error: emailError } = await supabase.from("email_messages").upsert({
      tenant_id: job.tenant_id, customer_id: contract.customer_id, contract_id: request.contract_id, direction: "outbound",
      from_address: "pending@kundexa.local", to_addresses: [recipient.email], subject: `Bekräftelse på avtal ${contract.contract_number}`,
      body_text: text, body_html: html, status: "queued", attachments, idempotency_key: idempotencyKey, purpose: "contract_confirmation",
    }, { onConflict: "tenant_id,idempotency_key" }).select("id").single();
    if (emailError || !email) throw emailError ?? new Error("confirmation_email_create_failed");
    await supabase.from("contract_deliveries").upsert({
      tenant_id: job.tenant_id, contract_id: request.contract_id, contract_version_id: request.contract_version_id, recipient_id: recipient.id,
      acceptance_request_id: request.id, channel: "email", status: "queued", email_message_id: email.id,
      delivery_kind: "acceptance_confirmation", attempt_number: 1, canonical_document_id: acceptedDocument.id,
      canonical_document_sha256: acceptedDocument.sha256, idempotency_key: idempotencyKey, scheduled_at: new Date().toISOString(),
    }, { onConflict: "tenant_id,idempotency_key" });
    await supabase.from("outbox_jobs").upsert({ tenant_id: job.tenant_id, job_type: "email.send", aggregate_type: "email_message", aggregate_id: email.id, payload: { email_message_id: email.id, acceptance_request_id: request.id, acceptance_id: acceptanceId || null }, idempotency_key: idempotencyKey, priority: 30 }, { onConflict: "tenant_id,idempotency_key", ignoreDuplicates: true });
  }

  if (recipient.phone_e164) {
    const { data: number } = await supabase.from("phone_numbers").select("number_e164").eq("tenant_id", job.tenant_id).eq("supports_sms", true).eq("status", "active").limit(1).maybeSingle();
    if (number) {
      const idempotencyKey = `contract-confirmation/${acceptanceId || request.id}/sms`;
      const smsBody = `Bekräftelse: ditt besked för avtal ${contract.contract_number} hos ${tenant.legal_name} registrerades ${acceptedLabel}.`;
      const { data: sms, error: smsError } = await supabase.from("sms_messages").upsert({ tenant_id: job.tenant_id, customer_id: contract.customer_id, contract_id: request.contract_id, direction: "outbound", from_number: number.number_e164, to_number: recipient.phone_e164, body: smsBody, status: "queued", idempotency_key: idempotencyKey, purpose: "contract_confirmation" }, { onConflict: "tenant_id,idempotency_key" }).select("id").single();
      if (smsError || !sms) throw smsError ?? new Error("confirmation_sms_create_failed");
      await supabase.from("contract_deliveries").upsert({ tenant_id: job.tenant_id, contract_id: request.contract_id, contract_version_id: request.contract_version_id, recipient_id: recipient.id, acceptance_request_id: request.id, channel: "sms", status: "queued", sms_message_id: sms.id, delivery_kind: "acceptance_confirmation", attempt_number: 1, canonical_document_id: acceptedDocument.id, canonical_document_sha256: acceptedDocument.sha256, idempotency_key: idempotencyKey, scheduled_at: new Date().toISOString() }, { onConflict: "tenant_id,idempotency_key" });
      await supabase.from("outbox_jobs").upsert({ tenant_id: job.tenant_id, job_type: "sms.send", aggregate_type: "sms_message", aggregate_id: sms.id, payload: { sms_message_id: sms.id, acceptance_request_id: request.id, acceptance_id: acceptanceId || null }, idempotency_key: idempotencyKey, priority: 30 }, { onConflict: "tenant_id,idempotency_key", ignoreDuplicates: true });
    }
  }
  await supabase.from("contract_events").insert({ tenant_id: job.tenant_id, contract_id: request.contract_id, event_type: "contract.confirmation_queued", payload: { acceptance_request_id: request.id, acceptance_id: acceptanceId || null, signed_document_id: acceptedDocument.id, evidence_document_id: evidenceDocument?.id ?? null } });
}


async function processSignedContractConfirmation(job: Job) {
  const contractId = String(job.aggregate_id ?? job.payload.contract_id ?? "");
  const finalDocumentId = String(job.payload.final_document_id ?? "");
  if (!contractId || !finalDocumentId) throw new Error("signed_confirmation_payload_missing");

  const [{ data: contract, error: contractError }, { data: tenant }, { data: document, error: documentError }, { data: recipients, error: recipientsError }] = await Promise.all([
    supabase.from("contracts").select("id,tenant_id,contract_number,title,customer_id,active_version_id,signed_at").eq("tenant_id", job.tenant_id).eq("id", contractId).single(),
    supabase.from("tenants").select("legal_name").eq("id", job.tenant_id).single(),
    supabase.from("contract_documents").select("id,contract_version_id,file_name,sha256").eq("tenant_id", job.tenant_id).eq("id", finalDocumentId).eq("contract_id", contractId).eq("document_type", "signed_pdf").single(),
    supabase.from("contract_recipients").select("id,full_name,email,status,required").eq("tenant_id", job.tenant_id).eq("contract_id", contractId).eq("status", "signed"),
  ]);
  if (contractError || !contract) throw new Error("signed_confirmation_contract_not_found");
  if (documentError || !document) throw new Error("signed_confirmation_document_not_found");
  if (recipientsError) throw new Error(recipientsError.message);
  if (!tenant) throw new Error("signed_confirmation_tenant_not_found");

  const signedAt = contract.signed_at ?? new Date().toISOString();
  const signedLabel = new Intl.DateTimeFormat("sv-SE", { dateStyle: "long", timeStyle: "short", timeZone: "Europe/Stockholm" }).format(new Date(signedAt));
  for (const recipient of recipients ?? []) {
    if (!recipient.email) continue;
    const idempotencyKey = `contract-signed/${contract.id}/${recipient.id}/email`;
    const text = `Hej ${recipient.full_name},

Avtal ${contract.contract_number} (${contract.title}) hos ${tenant.legal_name} är fullständigt signerat sedan ${signedLabel}. Det slutligt signerade dokumentet finns bifogat.

${tenant.legal_name}`;
    const html = `<!doctype html><html><body style="margin:0;background:#f3f6f5;font-family:Arial,sans-serif;color:#17202a"><table role="presentation" width="100%"><tr><td align="center" style="padding:28px 12px"><table role="presentation" width="100%" style="max-width:640px;background:#fff;border:1px solid #dfe7e5"><tr><td style="padding:26px 30px;background:#102b26;color:#fff"><strong>${escapeHtml(tenant.legal_name)}</strong></td></tr><tr><td style="padding:32px 30px"><h1>Avtalet är fullständigt signerat</h1><p>Hej ${escapeHtml(recipient.full_name)},</p><p>Avtal <strong>${escapeHtml(contract.contract_number)}</strong> är fullständigt signerat sedan ${escapeHtml(signedLabel)}.</p><p>Det slutligt signerade dokumentet finns bifogat.</p></td></tr></table></td></tr></table></body></html>`;
    const { data: email, error: emailError } = await supabase.from("email_messages").upsert({
      tenant_id: job.tenant_id,
      customer_id: contract.customer_id,
      contract_id: contract.id,
      direction: "outbound",
      from_address: "pending@kundexa.local",
      to_addresses: [recipient.email],
      subject: `Signerat avtal ${contract.contract_number}`,
      body_text: text,
      body_html: html,
      status: "queued",
      attachments: [{ document_id: document.id, filename: document.file_name, mime_type: "application/pdf" }],
      idempotency_key: idempotencyKey,
      purpose: "contract_confirmation",
    }, { onConflict: "tenant_id,idempotency_key" }).select("id").single();
    if (emailError || !email) throw emailError ?? new Error("signed_confirmation_email_create_failed");

    const { error: deliveryError } = await supabase.from("contract_deliveries").upsert({
      tenant_id: job.tenant_id,
      contract_id: contract.id,
      contract_version_id: document.contract_version_id ?? contract.active_version_id,
      recipient_id: recipient.id,
      channel: "email",
      status: "queued",
      email_message_id: email.id,
      delivery_kind: "acceptance_confirmation",
      attempt_number: 1,
      canonical_document_id: document.id,
      canonical_document_sha256: document.sha256,
      idempotency_key: idempotencyKey,
      scheduled_at: new Date().toISOString(),
    }, { onConflict: "tenant_id,idempotency_key" });
    if (deliveryError) throw new Error(deliveryError.message);

    const { error: outboxError } = await supabase.from("outbox_jobs").upsert({
      tenant_id: job.tenant_id,
      job_type: "email.send",
      aggregate_type: "email_message",
      aggregate_id: email.id,
      payload: { email_message_id: email.id, contract_id: contract.id, final_document_id: document.id },
      idempotency_key: idempotencyKey,
      priority: 30,
    }, { onConflict: "tenant_id,idempotency_key", ignoreDuplicates: true });
    if (outboxError) throw new Error(outboxError.message);
  }
}

function assertSafeWebhookUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("webhook_https_required");
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host === "127.0.0.1" || host === "::1" || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
    throw new Error("webhook_private_network_forbidden");
  }
  return url;
}

async function hmacSha256(secret: string, value: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(signature)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function processWebhook(job: Job) {
  const { data: delivery, error } = await supabase.from("webhook_deliveries").select("*")
    .eq("tenant_id", job.tenant_id).eq("id", job.aggregate_id).single();
  if (error || !delivery) throw new Error("webhook_delivery_not_found");
  if (delivery.status === "completed") return;
  const { data: endpoint } = await supabase.from("webhook_endpoints").select("url,secret_ciphertext,active")
    .eq("tenant_id", job.tenant_id).eq("id", delivery.endpoint_id).single();
  if (!endpoint?.active) throw new Error("webhook_endpoint_inactive");
  const url = assertSafeWebhookUrl(endpoint.url);
  const secret = await decryptJson<{ secret: string }>(endpoint.secret_ciphertext, encryptionKey);
  const body = JSON.stringify({ id: delivery.event_id, type: delivery.event_type, created_at: delivery.created_at, data: delivery.payload });
  const signature = await hmacSha256(secret.secret, body);
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-kundexa-event": delivery.event_type, "x-kundexa-signature": `sha256=${signature}` },
    body,
    redirect: "error",
  });
  const responseBody = (await response.text()).slice(0, 4000);
  await supabase.from("webhook_deliveries").update({
    status: response.ok ? "completed" : "failed",
    response_status: response.status,
    response_body: responseBody,
    attempts: delivery.attempts + 1,
    next_attempt_at: response.ok ? null : new Date(Date.now() + 60_000).toISOString(),
  }).eq("id", delivery.id);
  if (!response.ok) throw new Error(`webhook_http_${response.status}`);
}

async function sha256Text(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function getPlatformRinkelClient() {
  const apiKey = Deno.env.get("RINKEL_API_KEY") ?? "";
  if (!apiKey) throw new Error("permanent_rinkel_platform_not_configured");
  return new RinkelClient({
    apiKey,
    baseUrl: Deno.env.get("RINKEL_API_BASE_URL") ?? "https://api.rinkel.com/v1",
    timeoutMs: Number(Deno.env.get("RINKEL_REQUEST_TIMEOUT_MS") ?? 15000),
    requestId: crypto.randomUUID(),
  });
}

async function processRinkelRetention(job: Job) {
  const now = new Date().toISOString();
  const { data: policy, error: policyError } = await supabase.from("telephony_policies").select("*")
    .eq("tenant_id", job.tenant_id).maybeSingle();
  if (policyError) throw policyError;
  if (!policy) return;
  const { data: recordings, error: recordingError } = await supabase.from("call_recordings").select("*")
    .eq("tenant_id", job.tenant_id).eq("provider", "rinkel")
    .lte("retention_delete_at", now).is("deleted_at", null).limit(250);
  if (recordingError) throw recordingError;
  for (const recording of recordings ?? []) {
    if (recording.storage_path) {
      const { error: storageError } = await supabase.storage.from("call-recordings").remove([recording.storage_path]);
      if (storageError) throw storageError;
    }
    if (policy.delete_provider_recording_on_retention && recording.provider_recording_id) {
      const client = getPlatformRinkelClient();
      await client.deleteCallRecording(recording.provider_recording_id);
    }
    await supabase.from("call_recordings").update({
      status: "purged",
      storage_path: null,
      provider_reference: null,
      deleted_at: now,
    }).eq("tenant_id", job.tenant_id).eq("id", recording.id);
    await supabase.from("calls").update({ recording_status: "deleted" })
      .eq("tenant_id", job.tenant_id).eq("id", recording.call_id);
  }
  await supabase.from("call_transcripts").update({
    status: "deleted", raw_transcript: null, structured_transcript: null, provider_payload: {}, deleted_at: now,
  }).eq("tenant_id", job.tenant_id).lte("retention_delete_at", now).is("deleted_at", null);
  await supabase.from("call_insights").update({
    status: "deleted", sentiment: null, topics: [], summary: null, analysis: {}, deleted_at: now,
  }).eq("tenant_id", job.tenant_id).lte("retention_delete_at", now).is("deleted_at", null);
  const rawCutoff = new Date(Date.now() - Number(policy.raw_event_retention_days ?? 30) * 86400000).toISOString();
  await supabase.from("provider_webhook_events").update({ payload: {}, headers: {} })
    .eq("tenant_id", job.tenant_id).eq("provider", "rinkel").lt("received_at", rawCutoff)
    .in("status", ["processed", "dead_letter", "conflict"]);
}

async function processJob(job: Job) {
  if (job.job_type === "sms.send") return processSms(job);
  if (job.job_type === "call.start") throw new Error("permanent_legacy_46elks_voice_job_disabled_use_rinkel");
  if (job.job_type === "email.send") return processEmail(job);
  if (job.job_type === "contract.reminder.dispatch") return processContractReminder(job);
  if (job.job_type === "recording.download") return processRecording(job);
  if (job.job_type === "evidence.generate") return processEvidence(job);
  if (job.job_type === "contract.confirmation") return processContractConfirmation(job);
  if (job.job_type === "contract.signed.confirmation") return processSignedContractConfirmation(job);
  if (job.job_type === "webhook.deliver") return processWebhook(job);
  if (["rinkel.process_event", "rinkel.enrich_call", "rinkel.reconcile_calls"].includes(job.job_type)) {
    throw new Error("permanent_legacy_tenant_rinkel_job_disabled_use_platform_worker");
  }
  if (job.job_type === "rinkel.retention") return processRinkelRetention(job);
  throw new Error(`unsupported_job_type:${job.job_type}`);
}

Deno.serve(async (request) => {
  if (request.headers.get("x-cron-secret") !== cronSecret) return new Response("Forbidden", { status: 403 });
  const worker = `edge-${crypto.randomUUID()}`;
  const { data: remindersEnqueued, error: reminderError } = await supabase.rpc("enqueue_due_contract_reminders", { p_limit: 100 });
  if (reminderError) return Response.json({ error: reminderError.message }, { status: 500 });
  const { data: jobs, error } = await supabase.rpc("claim_outbox_jobs", { p_worker: worker, p_limit: 25 });
  if (error) return Response.json({ error: error.message }, { status: 500 });
  const results = [];
  for (const job of (jobs ?? []) as Job[]) {
    try {
      await processJob(job);
      await supabase.rpc("complete_outbox_job", { p_job_id: job.id });
      results.push({ id: job.id, status: "completed" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const permanent = message.startsWith("permanent_");
      if (permanent) {
        await supabase.rpc("dead_letter_outbox_job", { p_job_id: job.id, p_error: message });
        if (job.job_type === "email.send") {
          await supabase.from("email_messages").update({ status: "dead_letter", provider_status: "dead_letter", error_message: message.slice(0, 500) }).eq("tenant_id", job.tenant_id).eq("id", job.aggregate_id);
          await supabase.from("contract_deliveries").update({ status: "dead_letter", provider_status: "dead_letter", failure_code: "permanent_error", failure_message: message.slice(0, 500) }).eq("tenant_id", job.tenant_id).eq("email_message_id", job.aggregate_id);
        }
        if (job.job_type === "sms.send") {
          await supabase.from("sms_messages").update({ status: "dead_letter", error_message: message.slice(0, 500) }).eq("tenant_id", job.tenant_id).eq("id", job.aggregate_id);
          await supabase.from("contract_deliveries").update({ status: "dead_letter", provider_status: "dead_letter", failure_code: "permanent_error", failure_message: message.slice(0, 500) }).eq("tenant_id", job.tenant_id).eq("sms_message_id", job.aggregate_id);
        }
        if (job.job_type === "contract.reminder.dispatch") await supabase.from("contract_reminders").update({ status: "failed", cancel_reason: message.slice(0, 200) }).eq("tenant_id", job.tenant_id).eq("id", job.aggregate_id);
      } else {
        await supabase.rpc("fail_outbox_job", {
          p_job_id: job.id,
          p_error: message,
          p_delay_seconds: message === "reminder_quiet_hours_retry" ? 3600 : Math.min(3600, 2 ** Math.min(job.attempts, 10) * 15),
        });
      }
      results.push({ id: job.id, status: permanent ? "dead_letter" : "failed", error: message });
    }
  }
  return Response.json({ worker, reminders_enqueued: remindersEnqueued ?? 0, claimed: jobs?.length ?? 0, results });
});
