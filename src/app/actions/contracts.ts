"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getAppContext } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { randomToken, sha256, sha256Bytes } from "@/lib/crypto";
import { serverEnv } from "@/lib/env";
import { normalizePhone } from "@/lib/domain/phone";
import { assertPermission } from "@/lib/permissions";

const value = (form: FormData, key: string) => String(form.get(key) ?? "").trim();
const contractNumber = () => `KX-${new Date().getFullYear()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

export async function createContract(form: FormData) {
  const ctx = await getAppContext();
  assertPermission(ctx.role, "contracts.write");

  const parsed = z.object({
    customerId: z.uuid(),
    productId: z.union([z.uuid(), z.literal("")]),
    title: z.string().min(2).max(200),
    salesChannel: z.enum(["telephone", "web", "email", "in_person", "partner", "api", "other"]),
  }).safeParse({
    customerId: value(form, "customer_id"),
    productId: value(form, "product_id"),
    title: value(form, "title"),
    salesChannel: value(form, "sales_channel") || "other",
  });
  if (!parsed.success) redirect("/app/contracts?error=Kontrollera avtalsuppgifterna");

  const supabase = await createClient();
  const { data: customer } = await supabase
    .from("customers")
    .select("display_name,customer_type")
    .eq("id", parsed.data.customerId)
    .single();
  if (!customer) redirect("/app/contracts?error=Kunden saknas eller är inte tillgänglig");

  let price: null | {
    id: string;
    setup_fee: number;
    recurring_fee: number;
    currency: string;
    binding_months: number | null;
    notice_months: number | null;
  } = null;
  if (parsed.data.productId) {
    const { data } = await supabase
      .from("product_price_versions")
      .select("id,setup_fee,recurring_fee,currency,binding_months,notice_months")
      .eq("product_id", parsed.data.productId)
      .eq("active", true)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();
    price = data;
  }

  const commercialTerms = {
    currency: price?.currency ?? "SEK",
    setup_fee: Number(price?.setup_fee ?? 0),
    recurring_fee: Number(price?.recurring_fee ?? 0),
    binding_months: price?.binding_months ?? null,
    notice_months: price?.notice_months ?? null,
  };
  const renderedBody = `Avtal mellan ${ctx.tenantLegalName} och ${customer.display_name}. Avtalet gäller ${parsed.data.title}. Pris: ${commercialTerms.recurring_fee} ${commercialTerms.currency} per månad. Startavgift: ${commercialTerms.setup_fee} ${commercialTerms.currency}.`;
  const renderedTerms = "Fullständiga villkor ska granskas och godkännas av tenantens juridiskt ansvariga före produktionsanvändning.";
  const documentHash = sha256(`${renderedBody}\n${renderedTerms}\n${JSON.stringify(commercialTerms)}`);

  const { data: contractId, error } = await supabase.rpc("create_contract_draft", {
    p_contract_number: contractNumber(),
    p_customer_id: parsed.data.customerId,
    p_product_id: parsed.data.productId || null,
    p_price_version_id: price?.id ?? null,
    p_title: parsed.data.title,
    p_rendered_body: renderedBody,
    p_rendered_terms: renderedTerms,
    p_commercial_terms: commercialTerms,
    p_document_hash: documentHash,
    p_sales_channel: parsed.data.salesChannel,
  });
  if (error || !contractId) redirect(`/app/contracts?error=${encodeURIComponent(error?.message ?? "Avtalet kunde inte skapas")}`);

  revalidatePath("/app/contracts");
  redirect(`/app/contracts/${contractId}`);
}

export async function uploadContractPdf(form: FormData) {
  const ctx = await getAppContext();
  assertPermission(ctx.role, "contracts.write");
  const contractId = value(form, "contract_id");
  const file = form.get("file");
  if (!(file instanceof File) || file.type !== "application/pdf" || file.size > 50 * 1024 * 1024) {
    redirect(`/app/contracts/${contractId}?error=PDF krävs och får vara högst 50 MB`);
  }

  const supabase = await createClient();
  const { data: contract } = await supabase
    .from("contracts")
    .select("active_version_id,status,contract_versions!contracts_active_version_tenant_fk(locked_at)")
    .eq("id", contractId)
    .single();
  const versionRaw = contract?.contract_versions as unknown as { locked_at: string | null } | { locked_at: string | null }[] | null;
  const version = Array.isArray(versionRaw) ? versionRaw[0] : versionRaw;
  if (!contract?.active_version_id || version?.locked_at || !["draft", "ready"].includes(contract.status)) {
    redirect(`/app/contracts/${contractId}?error=Utskickad eller låst avtalsversion kan inte få nya PDF-filer`);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") {
    redirect(`/app/contracts/${contractId}?error=Filen har inte ett giltigt PDF-huvud`);
  }
  const hash = sha256Bytes(bytes);
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const path = `${ctx.tenantId}/${contractId}/${crypto.randomUUID()}-${safeName}`;
  const { error: uploadError } = await supabase.storage.from("contract-documents").upload(path, bytes, {
    contentType: "application/pdf",
    upsert: false,
  });
  if (uploadError) redirect(`/app/contracts/${contractId}?error=${encodeURIComponent(uploadError.message)}`);

  const { error: insertError } = await supabase.from("contract_documents").insert({
    tenant_id: ctx.tenantId,
    contract_id: contractId,
    contract_version_id: contract.active_version_id,
    document_type: "source_pdf",
    file_name: file.name,
    storage_path: path,
    mime_type: file.type,
    size_bytes: file.size,
    sha256: hash,
  });
  if (insertError) {
    await supabase.storage.from("contract-documents").remove([path]);
    redirect(`/app/contracts/${contractId}?error=${encodeURIComponent(insertError.message)}`);
  }

  await supabase.from("contract_events").insert({
    tenant_id: ctx.tenantId,
    contract_id: contractId,
    event_type: "document.uploaded",
    actor_user_id: ctx.userId,
    payload: { file_name: file.name, sha256: hash },
  });
  revalidatePath(`/app/contracts/${contractId}`);
}

export async function sendContract(form: FormData) {
  const ctx = await getAppContext();
  assertPermission(ctx.role, "contracts.send");
  const contractId = value(form, "contract_id");
  const channel = z.enum(["sms", "email", "both"]).catch("both").parse(value(form, "channel"));
  const supabase = await createClient();

  const { data: contract } = await supabase
    .from("contracts")
    .select("id,contract_number,title,audience,sales_channel,customer_id,active_version_id,customers(display_name,email,phone_e164)")
    .eq("id", contractId)
    .single();
  if (!contract?.active_version_id) redirect(`/app/contracts/${contractId}?error=Avtalet saknar aktiv version`);

  const customerRaw = contract.customers as unknown as { display_name: string; email: string | null; phone_e164: string | null } | { display_name: string; email: string | null; phone_e164: string | null }[] | null;
  const customer = Array.isArray(customerRaw) ? customerRaw[0] : customerRaw;
  if (!customer) redirect(`/app/contracts/${contractId}?error=Kunden saknas`);

  let phone = customer.phone_e164;
  if (phone) {
    try { phone = normalizePhone(phone); } catch { phone = null; }
  }
  if ((channel === "sms" || channel === "both") && !phone) redirect(`/app/contracts/${contractId}?error=Kunden saknar giltigt mobilnummer`);
  if ((channel === "email" || channel === "both") && !customer.email) redirect(`/app/contracts/${contractId}?error=Kunden saknar e-post`);

  let callId: string | null = null;
  let callEndedAt: string | null = null;
  if (contract.audience === "B2C" && contract.sales_channel === "telephone") {
    const { data: call } = await supabase
      .from("calls")
      .select("id,ended_at")
      .eq("customer_id", contract.customer_id)
      .eq("direction", "outbound")
      .not("ended_at", "is", null)
      .order("ended_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!call?.ended_at) redirect(`/app/contracts/${contractId}?error=B2C-avtal efter telefonförsäljning får skickas först när säljsamtalet har avslutats`);
    callId = call.id;
    callEndedAt = call.ended_at;
  }

  let smsFrom: string | null = null;
  if (channel === "sms" || channel === "both") {
    const { data: number } = await supabase
      .from("phone_numbers")
      .select("number_e164")
      .eq("supports_sms", true)
      .eq("status", "active")
      .limit(1)
      .maybeSingle();
    if (!number) redirect(`/app/contracts/${contractId}?error=Inget SMS-kompatibelt nummer är konfigurerat`);
    smsFrom = number.number_e164;
  }

  const token = randomToken();
  const code = randomToken(4).slice(0, 4).toUpperCase();
  const env = serverEnv();
  const publicUrl = `${env.NEXT_PUBLIC_APP_URL}/accept/${token}`;
  const smsBody = `Erbjudande från ${ctx.tenantLegalName}. Avtal ${contract.contract_number}: ${contract.title}. Läs ${publicUrl}. Svara JA ${code} för att acceptera eller NEJ ${code}.`;
  const emailSubject = `Avtal ${contract.contract_number} från ${ctx.tenantLegalName}`;
  const emailBody = `Granska avtalet och lämna ditt skriftliga besked via den säkra länken: ${publicUrl}`;

  const { error } = await supabase.rpc("prepare_contract_delivery", {
    p_contract_id: contractId,
    p_channel: channel,
    p_recipient_name: customer.display_name,
    p_email: customer.email,
    p_phone_e164: phone,
    p_public_token_hash: sha256(token + env.KUNDEXA_WEBHOOK_PEPPER),
    p_acceptance_code: code,
    p_expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
    p_call_id: callId,
    p_call_ended_at: callEndedAt,
    p_sms_from: smsFrom,
    p_sms_body: smsBody,
    p_email_from: "pending@kundexa.local",
    p_email_subject: emailSubject,
    p_email_body: emailBody,
  });
  if (error) redirect(`/app/contracts/${contractId}?error=${encodeURIComponent(error.message)}`);

  revalidatePath(`/app/contracts/${contractId}`);
  revalidatePath("/app/contracts");
}

export async function activateContract(form: FormData) {
  const ctx = await getAppContext();
  assertPermission(ctx.role, "contracts.write");
  const contractId = value(form, "contract_id");
  const supabase = await createClient();
  const [{ data: contract }, { count: evidenceCount }] = await Promise.all([
    supabase.from("contracts").select("status").eq("id", contractId).single(),
    supabase.from("evidence_packages").select("*", { count: "exact", head: true }).eq("contract_id", contractId).eq("status", "completed"),
  ]);
  if (contract?.status !== "accepted") redirect(`/app/contracts/${contractId}?error=Endast ett accepterat avtal kan aktiveras`);
  if (!evidenceCount) redirect(`/app/contracts/${contractId}?error=Bevispaketet måste vara färdigställt innan aktivering`);

  const now = new Date().toISOString();
  const { error } = await supabase.from("contracts").update({ status: "active", activated_at: now }).eq("id", contractId);
  if (error) redirect(`/app/contracts/${contractId}?error=${encodeURIComponent(error.message)}`);
  await supabase.from("contract_events").insert({ tenant_id: ctx.tenantId, contract_id: contractId, event_type: "contract.activated", actor_user_id: ctx.userId, payload: { activated_at: now } });
  await supabase.from("audit_logs").insert({ tenant_id: ctx.tenantId, actor_user_id: ctx.userId, action: "contract.activated", entity_type: "contract", entity_id: contractId, after_data: { activated_at: now } });
  revalidatePath(`/app/contracts/${contractId}`);
  revalidatePath("/app/contracts");
}
