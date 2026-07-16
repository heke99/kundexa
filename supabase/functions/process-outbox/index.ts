import { createClient } from "npm:@supabase/supabase-js@2.110.7";
import { decryptJson } from "../_shared/crypto.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const encryptionKey = Deno.env.get("KUNDEXA_ENCRYPTION_KEY")!;
const appUrl = Deno.env.get("APP_URL")!;
const cronSecret = Deno.env.get("CRON_SECRET")!;
const globalResendKey = Deno.env.get("RESEND_API_KEY") ?? "";
const globalEmailFrom = Deno.env.get("DEFAULT_EMAIL_FROM") ?? "no-reply@example.com";
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
type EmailCredentials = { apiKey?: string; from?: string };

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
  const { data } = await supabase.from("tenant_integrations")
    .select("credentials_ciphertext,configuration")
    .eq("tenant_id", tenantId)
    .eq("provider_type", "email")
    .eq("provider", "resend")
    .eq("status", "active")
    .limit(1)
    .maybeSingle();
  const credentials = data?.credentials_ciphertext
    ? await decryptJson<EmailCredentials>(data.credentials_ciphertext, encryptionKey)
    : {};
  const apiKey = credentials.apiKey || globalResendKey;
  const address = credentials.from || (data?.configuration as { from?: string } | null)?.from || globalEmailFrom;
  if (!apiKey) throw new Error("email_provider_not_configured");
  return { apiKey, address, formattedFrom: `${cleanHeaderName(tenant.legal_name)} <${address}>`, tenant };
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

  const { data: number } = await supabase.from("phone_numbers").select("webhook_token_ciphertext")
    .eq("tenant_id", job.tenant_id).eq("number_e164", sms.from_number).single();
  if (!number?.webhook_token_ciphertext) throw new Error("sms_number_token_missing");
  const token = await decryptJson<{ token: string }>(number.webhook_token_ciphertext, encryptionKey);

  await supabase.from("sms_messages").update({ status: "submitting" }).eq("id", sms.id);
  await supabase.rpc("increment_usage", {
    p_tenant_id: job.tenant_id,
    p_metric: "sms_parts",
    p_amount: Math.max(1, Math.ceil(sms.body.length / 160)),
  });
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
  await supabase.from("contract_deliveries").update({ status: "sent", sent_at: sentAt }).eq("sms_message_id", sms.id);
}

async function processCall(job: Job) {
  const { data: call, error } = await supabase.from("calls").select("*")
    .eq("tenant_id", job.tenant_id).eq("id", job.aggregate_id).single();
  if (error || !call) throw new Error("call_not_found");
  if (call.provider_call_id || ["initiating", "ringing", "answered", "completed"].includes(call.status)) return;

  const clientNumber = String(job.payload.voice_client_number ?? "");
  const callbackToken = String(job.payload.callback_token ?? "");
  if (!clientNumber || !callbackToken) throw new Error("webrtc_bridge_configuration_missing");
  await supabase.rpc("increment_usage", { p_tenant_id: job.tenant_id, p_metric: "calls_started", p_amount: 1 });

  const action: Record<string, unknown> = { connect: call.to_number, callerid: call.from_number };
  if (call.recording_enabled) action.recordcall = `${appUrl}/api/webhooks/46elks/voice/recording?token=${encodeURIComponent(callbackToken)}`;
  const result = await post46Elks("calls", await get46ElksCredentials(job.tenant_id), {
    from: call.from_number,
    to: clientNumber,
    voice_start: JSON.stringify(action),
    whenhangup: `${appUrl}/api/webhooks/46elks/voice/hangup?token=${encodeURIComponent(callbackToken)}`,
    timeout: "60",
  });
  await supabase.from("calls").update({
    provider_call_id: String(result.id ?? ""),
    status: "initiating",
    started_at: String(result.created ?? new Date().toISOString()),
  }).eq("id", call.id);
}

async function processEmail(job: Job) {
  const { data: email, error } = await supabase.from("email_messages").select("*")
    .eq("tenant_id", job.tenant_id).eq("id", job.aggregate_id).single();
  if (error || !email) throw new Error("email_not_found");
  if (email.provider_message_id || ["sent", "delivered", "opened"].includes(email.status)) return;

  const config = await getEmailConfig(job.tenant_id);
  await supabase.from("email_messages").update({ status: "submitting" }).eq("id", email.id);
  await supabase.rpc("increment_usage", { p_tenant_id: job.tenant_id, p_metric: "emails_sent", p_amount: 1 });
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
      cc: email.cc_addresses,
      subject: email.subject,
      text: email.body_text,
      html: email.body_html || undefined,
      attachments: email.attachments?.length ? email.attachments : undefined,
    }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`email_${response.status}:${JSON.stringify(result).slice(0, 500)}`);
  const sentAt = new Date().toISOString();
  await supabase.from("email_messages").update({
    provider_message_id: result.id,
    status: "sent",
    sent_at: sentAt,
    from_address: email.from_address === "pending@kundexa.local" ? config.address : email.from_address,
  }).eq("id", email.id);
  await supabase.from("contract_deliveries").update({ status: "sent", sent_at: sentAt }).eq("email_message_id", email.id);
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
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function singleRelation<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

async function processEvidence(job: Job) {
  const contractId = String(job.payload.contract_id ?? job.aggregate_id ?? "");
  const acceptanceId = String(job.payload.acceptance_id ?? "");
  const requestId = String(job.payload.acceptance_request_id ?? "");
  const [{ data: contract }, { data: versions }, { data: acceptances }, { data: events }, { data: documents }] = await Promise.all([
    supabase.from("contracts").select("*,tenants(name,legal_name),customers(display_name,email,phone_e164)").eq("tenant_id", job.tenant_id).eq("id", contractId).single(),
    supabase.from("contract_versions").select("*").eq("tenant_id", job.tenant_id).eq("contract_id", contractId).order("version"),
    supabase.from("contract_acceptances").select("*").eq("tenant_id", job.tenant_id).eq("contract_id", contractId),
    supabase.from("contract_events").select("*").eq("tenant_id", job.tenant_id).eq("contract_id", contractId).order("occurred_at"),
    supabase.from("contract_documents").select("id,document_type,file_name,sha256,created_at").eq("tenant_id", job.tenant_id).eq("contract_id", contractId),
  ]);
  if (!contract) throw new Error("contract_not_found");

  const tenant = singleRelation(contract.tenants);
  const customer = singleRelation(contract.customers);

  const manifest = {
    schema: "kundexa.evidence.v1",
    generated_at: new Date().toISOString(),
    request_id: requestId || null,
    acceptance_id: acceptanceId || null,
    contract,
    versions,
    acceptances,
    events,
    documents,
  };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
  const manifestHash = await sha256Bytes(manifestBytes);
  const key = acceptanceId || requestId || job.id;
  const manifestPath = `${job.tenant_id}/${contractId}/evidence-${key}.json`;
  const { error: manifestUploadError } = await supabase.storage.from("contract-documents").upload(manifestPath, manifestBytes, { contentType: "application/json", upsert: true });
  if (manifestUploadError) throw manifestUploadError;

  const activeVersion = (versions ?? []).find((version) => version.id === contract.active_version_id) ?? versions?.[versions.length - 1];
  const acceptance = (acceptances ?? []).find((item) => item.id === acceptanceId) ?? acceptances?.[acceptances.length - 1];
  const acceptedPdf = createTextPdf(`Accepterad avtalskopia ${contract.contract_number}`, [
    { heading: "Avtalsparter", text: `${tenant?.legal_name ?? "Tenant"} och ${customer?.display_name ?? "Kund"}` },
    { heading: "Avtal", text: activeVersion?.rendered_body ?? contract.title },
    { heading: "Villkor", text: activeVersion?.rendered_terms ?? "" },
    { heading: "Accept", text: `${acceptance?.status ?? "okänd"} via ${acceptance?.method ?? "okänd metod"} vid ${acceptance?.accepted_at ?? acceptance?.created_at ?? "okänd tid"}` },
    { heading: "Dokumenthash", text: activeVersion?.document_hash ?? "saknas" },
    { heading: "Bevismanifest", text: manifestHash },
  ]);
  const acceptedPath = `${job.tenant_id}/${contractId}/accepted-${key}.pdf`;
  const { error: acceptedUploadError } = await supabase.storage.from("contract-documents").upload(acceptedPath, acceptedPdf, { contentType: "application/pdf", upsert: true });
  if (acceptedUploadError) throw acceptedUploadError;

  const evidencePdf = createTextPdf(`Kundexa bevispaket ${contract.contract_number}`, [
    { heading: "Manifest", text: manifestPath },
    { heading: "Manifest SHA-256", text: manifestHash },
    { heading: "Avtalsversion", text: `${activeVersion?.version ?? "okänd"} · ${activeVersion?.document_hash ?? "hash saknas"}` },
    { heading: "Acceptans", text: JSON.stringify({ id: acceptance?.id, method: acceptance?.method, status: acceptance?.status, accepted_at: acceptance?.accepted_at, normalized_response: acceptance?.normalized_response }) },
    { heading: "Händelser", text: `${events?.length ?? 0} revisionshändelser ingår i JSON-manifestet.` },
  ]);
  const evidencePath = `${job.tenant_id}/${contractId}/evidence-${key}.pdf`;
  const { error: evidenceUploadError } = await supabase.storage.from("contract-documents").upload(evidencePath, evidencePdf, { contentType: "application/pdf", upsert: true });
  if (evidenceUploadError) throw evidenceUploadError;

  const documentRows = [
    { document_type: "manifest", file_name: `evidence-${key}.json`, storage_path: manifestPath, mime_type: "application/json", size_bytes: manifestBytes.length, sha256: manifestHash },
    { document_type: "accepted_pdf", file_name: `accepted-${key}.pdf`, storage_path: acceptedPath, mime_type: "application/pdf", size_bytes: acceptedPdf.length, sha256: await sha256Bytes(acceptedPdf) },
    { document_type: "evidence_pdf", file_name: `evidence-${key}.pdf`, storage_path: evidencePath, mime_type: "application/pdf", size_bytes: evidencePdf.length, sha256: await sha256Bytes(evidencePdf) },
  ].map((row) => ({ ...row, tenant_id: job.tenant_id, contract_id: contractId, contract_version_id: contract.active_version_id, metadata: { acceptance_id: acceptanceId || null, request_id: requestId || null } }));
  for (const row of documentRows) {
    const { error } = await supabase.from("contract_documents").upsert(row, { onConflict: "tenant_id,storage_path" });
    if (error) throw error;
  }

  const evidenceRow = {
    tenant_id: job.tenant_id,
    contract_id: contractId,
    contract_version_id: contract.active_version_id,
    acceptance_id: acceptanceId || acceptance?.id || null,
    status: "completed",
    manifest,
    manifest_hash: manifestHash,
    storage_path: manifestPath,
    generated_at: new Date().toISOString(),
  };
  const { error: evidenceError } = evidenceRow.acceptance_id
    ? await supabase.from("evidence_packages").upsert(evidenceRow, { onConflict: "tenant_id,acceptance_id" })
    : await supabase.from("evidence_packages").insert(evidenceRow);
  if (evidenceError) throw evidenceError;
}

async function processContractConfirmation(job: Job) {
  const requestId = String(job.payload.request_id ?? "");
  if (!requestId) throw new Error("confirmation_request_missing");
  const { data: request, error } = await supabase.from("contract_acceptance_requests")
    .select("id,tenant_id,contract_id,recipient_id")
    .eq("tenant_id", job.tenant_id).eq("id", requestId).single();
  if (error || !request) throw new Error("confirmation_request_not_found");
  const [{ data: contract }, { data: recipient }, { data: tenant }, { data: acceptedDocument }] = await Promise.all([
    supabase.from("contracts").select("contract_number,title,customer_id").eq("tenant_id", job.tenant_id).eq("id", request.contract_id).single(),
    supabase.from("contract_recipients").select("full_name,email,phone_e164").eq("tenant_id", job.tenant_id).eq("id", request.recipient_id).single(),
    supabase.from("tenants").select("legal_name").eq("id", job.tenant_id).single(),
    supabase.from("contract_documents").select("storage_path").eq("tenant_id", job.tenant_id).eq("contract_id", request.contract_id).eq("document_type", "accepted_pdf").order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (!contract || !recipient || !tenant) throw new Error("confirmation_data_missing");

  let copyUrl = "";
  if (acceptedDocument?.storage_path) {
    const { data } = await supabase.storage.from("contract-documents").createSignedUrl(acceptedDocument.storage_path, 7 * 86400);
    copyUrl = data?.signedUrl ?? "";
  }
  const text = `Vi bekräftar att avtal ${contract.contract_number} (${contract.title}) hos ${tenant.legal_name} har accepterats.${copyUrl ? ` Din tidsbegränsade avtalskopia: ${copyUrl}` : ""}`;

  if (recipient.email) {
    const idempotencyKey = `confirmation.email:${request.id}`;
    const { data: emailMessage, error: emailError } = await supabase.from("email_messages").upsert({
      tenant_id: job.tenant_id,
      customer_id: contract.customer_id,
      contract_id: request.contract_id,
      direction: "outbound",
      from_address: "pending@kundexa.local",
      to_addresses: [recipient.email],
      subject: `Bekräftelse på avtal ${contract.contract_number}`,
      body_text: text,
      status: "queued",
      idempotency_key: idempotencyKey,
    }, { onConflict: "tenant_id,idempotency_key" }).select("id").single();
    if (emailError) throw emailError;
    await supabase.from("outbox_jobs").upsert({
      tenant_id: job.tenant_id,
      job_type: "email.send",
      aggregate_type: "email_message",
      aggregate_id: emailMessage.id,
      payload: { email_message_id: emailMessage.id, confirmation_for_request: request.id },
      idempotency_key: `email.send:${emailMessage.id}`,
    }, { onConflict: "tenant_id,idempotency_key", ignoreDuplicates: true });
  }

  if (recipient.phone_e164) {
    const { data: number } = await supabase.from("phone_numbers").select("number_e164")
      .eq("tenant_id", job.tenant_id).eq("supports_sms", true).eq("status", "active").limit(1).maybeSingle();
    if (number) {
      const idempotencyKey = `confirmation.sms:${request.id}`;
      const { data: smsMessage, error: smsError } = await supabase.from("sms_messages").upsert({
        tenant_id: job.tenant_id,
        customer_id: contract.customer_id,
        contract_id: request.contract_id,
        direction: "outbound",
        from_number: number.number_e164,
        to_number: recipient.phone_e164,
        body: text,
        status: "queued",
        idempotency_key: idempotencyKey,
      }, { onConflict: "tenant_id,idempotency_key" }).select("id").single();
      if (smsError) throw smsError;
      await supabase.from("outbox_jobs").upsert({
        tenant_id: job.tenant_id,
        job_type: "sms.send",
        aggregate_type: "sms_message",
        aggregate_id: smsMessage.id,
        payload: { sms_message_id: smsMessage.id, confirmation_for_request: request.id },
        idempotency_key: `sms.send:${smsMessage.id}`,
      }, { onConflict: "tenant_id,idempotency_key", ignoreDuplicates: true });
    }
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

async function processJob(job: Job) {
  if (job.job_type === "sms.send") return processSms(job);
  if (job.job_type === "call.start") return processCall(job);
  if (job.job_type === "email.send") return processEmail(job);
  if (job.job_type === "recording.download") return processRecording(job);
  if (job.job_type === "evidence.generate") return processEvidence(job);
  if (job.job_type === "contract.confirmation") return processContractConfirmation(job);
  if (job.job_type === "webhook.deliver") return processWebhook(job);
  throw new Error(`unsupported_job_type:${job.job_type}`);
}

Deno.serve(async (request) => {
  if (request.headers.get("x-cron-secret") !== cronSecret) return new Response("Forbidden", { status: 403 });
  const worker = `edge-${crypto.randomUUID()}`;
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
      await supabase.rpc("fail_outbox_job", {
        p_job_id: job.id,
        p_error: message,
        p_delay_seconds: Math.min(3600, 2 ** Math.min(job.attempts, 10) * 15),
      });
      results.push({ id: job.id, status: "failed", error: message });
    }
  }
  return Response.json({ worker, claimed: jobs?.length ?? 0, results });
});
