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
import { renderStrictTemplate } from "@/lib/domain/template";

const value = (form: FormData, key: string) => String(form.get(key) ?? "").trim();
const contractNumber = () => `KX-${new Date().getFullYear()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

export async function createContract(form: FormData) {
  const ctx = await getAppContext();
  assertPermission(ctx.role, "contracts.write");

  const parsed = z.object({
    customerId: z.uuid(),
    productId: z.union([z.uuid(), z.literal("")]),
    templateVersionId: z.uuid(),
    legalEntityId: z.uuid(),
    title: z.string().min(2).max(200),
    salesChannel: z.enum(["telephone", "web", "email", "in_person", "partner", "api", "other"]),
  }).safeParse({
    customerId: value(form, "customer_id"),
    productId: value(form, "product_id"),
    templateVersionId: value(form, "template_version_id"),
    legalEntityId: value(form, "legal_entity_id"),
    title: value(form, "title"),
    salesChannel: value(form, "sales_channel") || "other",
  });
  if (!parsed.success) redirect("/app/contracts?error=Kund, juridiskt bolag, godkänd mall och avtalstitel krävs");

  const supabase = await createClient();
  const [{ data: customer }, { data: legalEntity }, { data: templateVersion }] = await Promise.all([
    supabase.from("customers").select("id,display_name,customer_type,first_name,last_name,company_name,personal_identity_number,organization_number,email,phone_e164,address_line1,postal_code,city,country_code").eq("id", parsed.data.customerId).is("deleted_at", null).single(),
    supabase.from("tenant_legal_entities").select("id,legal_name,organization_number,address_line1,postal_code,city,country_code,email,phone_e164,website,branding").eq("id", parsed.data.legalEntityId).eq("active", true).single(),
    supabase.from("contract_template_versions").select("id,template_id,status,title_template,body_template,terms_template,variables,approved_at").eq("id", parsed.data.templateVersionId).single(),
  ]);
  if (!customer) redirect("/app/contracts?error=Kunden saknas eller är inte tillgänglig");
  if (!legalEntity) redirect("/app/contracts?error=Det juridiska avsändarbolaget saknas eller är inaktivt");
  if (!templateVersion || templateVersion.status !== "approved") redirect("/app/contracts?error=En godkänd avtalsmall krävs");

  const { data: template } = await supabase.from("contract_templates")
    .select("id,name,audience,active,current_version_id,legal_entity_id")
    .eq("id", templateVersion.template_id).single();
  const audience = customer.customer_type === "person" ? "B2C" : "B2B";
  if (!template?.active || template.current_version_id !== templateVersion.id || ![audience, "BOTH"].includes(template.audience)) {
    redirect("/app/contracts?error=Mallversionen är inte den aktuella godkända versionen för denna kundtyp");
  }
  if (template.legal_entity_id && template.legal_entity_id !== legalEntity.id) {
    redirect("/app/contracts?error=Mallen är bunden till ett annat juridiskt bolag");
  }

  type ProductRecord = { id: string; name: string; sku: string | null; description: string | null };
  type PriceRecord = {
    id: string;
    version: number;
    setup_fee: number;
    recurring_fee: number;
    variable_fee: number;
    currency: string;
    binding_months: number | null;
    notice_months: number | null;
    payment_terms_days: number;
    terms: Record<string, unknown> | null;
  };
  let product: ProductRecord | null = null;
  let price: PriceRecord | null = null;
  if (parsed.data.productId) {
    const [{ data: productData }, { data: priceData }] = await Promise.all([
      supabase.from("products").select("id,name,sku,description").eq("id", parsed.data.productId).eq("active", true).single(),
      supabase.from("product_price_versions").select("id,version,setup_fee,recurring_fee,variable_fee,currency,binding_months,notice_months,payment_terms_days,terms").eq("product_id", parsed.data.productId).eq("active", true).order("version", { ascending: false }).limit(1).maybeSingle(),
    ]);
    if (!productData) redirect("/app/contracts?error=Produkten saknas eller är inaktiv");
    if (!priceData) redirect("/app/contracts?error=Produkten saknar en aktiv prisversion");
    product = productData as ProductRecord;
    price = priceData as PriceRecord;
  }

  const commercialTerms = {
    currency: price?.currency ?? "SEK",
    setup_fee: Number(price?.setup_fee ?? 0),
    recurring_fee: Number(price?.recurring_fee ?? 0),
    variable_fee: Number(price?.variable_fee ?? 0),
    binding_months: price?.binding_months ?? null,
    notice_months: price?.notice_months ?? null,
    payment_terms_days: price?.payment_terms_days ?? null,
    product_id: product?.id ?? null,
    product_name: product?.name ?? null,
    price_version: price?.version ?? null,
    additional_terms: price?.terms ?? {},
  };
  const sellerSnapshot = {
    id: legalEntity.id,
    legal_name: legalEntity.legal_name,
    organization_number: legalEntity.organization_number,
    address_line1: legalEntity.address_line1,
    postal_code: legalEntity.postal_code,
    city: legalEntity.city,
    country_code: legalEntity.country_code,
    email: legalEntity.email,
    phone_e164: legalEntity.phone_e164,
    website: legalEntity.website,
    branding: legalEntity.branding,
  };
  const counterpartySnapshot = {
    id: customer.id,
    customer_type: customer.customer_type,
    display_name: customer.display_name,
    first_name: customer.first_name,
    last_name: customer.last_name,
    company_name: customer.company_name,
    personal_identity_number: customer.personal_identity_number,
    organization_number: customer.organization_number,
    email: customer.email,
    phone_e164: customer.phone_e164,
    address_line1: customer.address_line1,
    postal_code: customer.postal_code,
    city: customer.city,
    country_code: customer.country_code,
  };
  const context = {
    seller: sellerSnapshot,
    customer: counterpartySnapshot,
    product: {
      id: product?.id ?? "Ingen produkt",
      name: product?.name ?? "Ingen produkt",
      sku: product?.sku ?? "—",
      description: product?.description ?? "—",
    },
    price: {
      currency: commercialTerms.currency,
      setup_fee: commercialTerms.setup_fee,
      recurring_fee: commercialTerms.recurring_fee,
      variable_fee: commercialTerms.variable_fee,
      binding_months: commercialTerms.binding_months ?? "Ingen bindningstid",
      notice_months: commercialTerms.notice_months ?? "Ej angivet",
      payment_terms_days: commercialTerms.payment_terms_days ?? "Ej angivet",
    },
    contract: { title: parsed.data.title, sales_channel: parsed.data.salesChannel, audience },
    today: new Intl.DateTimeFormat("sv-SE", { dateStyle: "long", timeZone: "Europe/Stockholm" }).format(new Date()),
  };

  let renderedTitle: string;
  let renderedBody: string;
  let renderedTerms: string;
  try {
    renderedTitle = renderStrictTemplate(templateVersion.title_template, context);
    renderedBody = renderStrictTemplate(templateVersion.body_template, context);
    renderedTerms = renderStrictTemplate(templateVersion.terms_template ?? "", context);
  } catch (error) {
    const message = error instanceof Error ? error.message.replace("unresolved_template_variables:", "Mallen saknar kund- eller avtalsdata för: ") : "Mallrenderingen misslyckades";
    redirect(`/app/contracts?error=${encodeURIComponent(message)}`);
  }
  const documentHash = sha256(`${renderedTitle}\n${renderedBody}\n${renderedTerms}\n${JSON.stringify(commercialTerms)}\n${JSON.stringify(sellerSnapshot)}\n${JSON.stringify(counterpartySnapshot)}`);

  const { data: contractId, error } = await supabase.rpc("create_contract_draft_v2", {
    p_contract_number: contractNumber(),
    p_customer_id: parsed.data.customerId,
    p_product_id: parsed.data.productId || null,
    p_price_version_id: price?.id ?? null,
    p_template_id: template.id,
    p_template_version_id: templateVersion.id,
    p_legal_entity_id: legalEntity.id,
    p_title: renderedTitle,
    p_rendered_body: renderedBody,
    p_rendered_terms: renderedTerms,
    p_commercial_terms: commercialTerms,
    p_document_hash: documentHash,
    p_sales_channel: parsed.data.salesChannel,
    p_seller_snapshot: sellerSnapshot,
    p_counterparty_snapshot: counterpartySnapshot,
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
