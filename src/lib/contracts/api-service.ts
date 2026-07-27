import { z } from "zod";
import type { ApiIdentity } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { renderStrictTemplate } from "@/lib/domain/template";
import { normalizePhone } from "@/lib/domain/phone";
import { encryptJson, randomToken, sha256 } from "@/lib/crypto";
import { serverEnv } from "@/lib/env";
import { ensureCanonicalContractDocument } from "@/lib/contracts/canonical-document";
import { renderContractDeliveryEmail } from "@/lib/email/templates/contract-delivery";
import { normalizeVariableFees } from "@/lib/contracts/price-terms";

export const apiCreateContractSchema = z.object({
  customer_id: z.uuid(),
  source_call_id: z.uuid(),
  template_version_id: z.uuid(),
  legal_entity_id: z.uuid(),
  product_id: z.uuid().nullable().optional(),
  title: z.string().min(2).max(200),
  idempotency_key: z.string().min(8).max(200),
});

export const apiSendContractSchema = z.object({
  channel: z.enum(["email", "sms", "both"]),
  recipient_name: z.string().min(2).max(200).optional(),
  email: z.email().optional(),
  phone_e164: z.string().optional(),
  reply_to: z.email().optional(),
  introduction: z.string().max(1500).optional(),
  expires_at: z.iso.datetime(),
  idempotency_key: z.string().min(8).max(200),
});

export const apiReminderSchema = z.object({
  channel: z.enum(["email", "sms", "both"]),
  personal_message: z.string().max(1500).optional(),
  attach_pdf: z.boolean().default(true),
  idempotency_key: z.string().min(8).max(200),
});

export const apiExtendExpirySchema = z.object({
  expires_at: z.iso.datetime(),
  idempotency_key: z.string().min(8).max(200),
});

type CreateInput = z.infer<typeof apiCreateContractSchema>;
type SendInput = z.infer<typeof apiSendContractSchema>;
type ReminderInput = z.infer<typeof apiReminderSchema>;
type ExtendInput = z.infer<typeof apiExtendExpirySchema>;

type ApiProductRow = {
  id: string;
  name: string;
  sku: string | null;
  description: string | null;
};

type ApiPriceVersionRow = {
  id: string;
  version: number;
  setup_fee: number;
  recurring_fee: number;
  variable_fees: unknown;
  currency: string;
  binding_months: number | null;
  notice_months: number | null;
  payment_terms_days: number | null;
  terms: Record<string, unknown> | null;
};

function actor(identity: ApiIdentity) {
  if (!identity.userId) throw new Error("api_actor_required");
  return identity.userId;
}

async function replay(identity: ApiIdentity, action: string, key: string) {
  const admin = createAdminClient();
  const { data } = await admin.from("audit_logs").select("entity_id,after_data")
    .eq("tenant_id", identity.tenantId).eq("action", action).eq("request_id", key).maybeSingle();
  return data ?? null;
}

function contractNumber() {
  return `KX-${new Date().getFullYear()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
}

export async function createContractFromApi(identity: ApiIdentity, input: CreateInput) {
  const prior = await replay(identity, "contract.api_created", input.idempotency_key);
  if (prior?.entity_id) return { contract_id: prior.entity_id, idempotent_replay: true };

  const admin = createAdminClient();
  const [{ data: customer }, { data: legalEntity }, { data: templateVersion }] = await Promise.all([
    admin.from("customers").select("id,display_name,customer_type,first_name,last_name,company_name,personal_identity_number,organization_number,email,phone_e164,address_line1,postal_code,city,country_code")
      .eq("tenant_id", identity.tenantId).eq("id", input.customer_id).is("deleted_at", null).single(),
    admin.from("tenant_legal_entities").select("id,legal_name,organization_number,address_line1,postal_code,city,country_code,email,phone_e164,website,branding")
      .eq("tenant_id", identity.tenantId).eq("id", input.legal_entity_id).eq("active", true).single(),
    admin.from("contract_template_versions").select("id,template_id,status,title_template,body_template,terms_template")
      .eq("tenant_id", identity.tenantId).eq("id", input.template_version_id).single(),
  ]);
  if (!customer) throw new Error("customer_not_found");
  if (!legalEntity) throw new Error("active_legal_entity_required");
  if (!templateVersion || templateVersion.status !== "approved") throw new Error("approved_contract_template_required");

  const { data: template } = await admin.from("contract_templates")
    .select("id,audience,active,current_version_id,legal_entity_id")
    .eq("tenant_id", identity.tenantId).eq("id", templateVersion.template_id).single();
  const audience = customer.customer_type === "person" ? "B2C" : "B2B";
  if (!template?.active || template.current_version_id !== templateVersion.id || ![audience, "BOTH"].includes(template.audience)) {
    throw new Error("template_not_current_for_customer_audience");
  }
  if (template.legal_entity_id && template.legal_entity_id !== legalEntity.id) throw new Error("template_legal_entity_mismatch");

  let product: ApiProductRow | null = null;
  let price: ApiPriceVersionRow | null = null;
  if (input.product_id) {
    const [{ data: productData }, { data: priceData }] = await Promise.all([
      admin.from("products").select("id,name,sku,description").eq("tenant_id", identity.tenantId).eq("id", input.product_id).eq("active", true).single(),
      admin.from("product_price_versions").select("id,version,setup_fee,recurring_fee,variable_fees,currency,binding_months,notice_months,payment_terms_days,terms")
        .eq("tenant_id", identity.tenantId).eq("product_id", input.product_id).eq("active", true).order("version", { ascending: false }).limit(1).maybeSingle(),
    ]);
    if (!productData) throw new Error("active_product_not_found");
    if (!priceData) throw new Error("active_price_version_not_found");
    product = productData as unknown as ApiProductRow;
    price = priceData as unknown as ApiPriceVersionRow;
  }

  const variableFees = normalizeVariableFees(price?.variable_fees);
  const commercialTerms = {
    currency: price?.currency ?? "SEK",
    setup_fee: Number(price?.setup_fee ?? 0), recurring_fee: Number(price?.recurring_fee ?? 0), variable_fee: variableFees.total,
    variable_fees: variableFees.fees,
    binding_months: price?.binding_months ?? null, notice_months: price?.notice_months ?? null,
    payment_terms_days: price?.payment_terms_days ?? null, product_id: product?.id ?? null,
    product_name: product?.name ?? null, price_version: price?.version ?? null, additional_terms: price?.terms ?? {},
  };
  const sellerSnapshot = { ...legalEntity };
  const counterpartySnapshot = { ...customer };
  const context = {
    seller: sellerSnapshot,
    customer: counterpartySnapshot,
    product: { id: product?.id ?? "Ingen produkt", name: product?.name ?? "Ingen produkt", sku: product?.sku ?? "—", description: product?.description ?? "—" },
    price: {
      currency: commercialTerms.currency, setup_fee: commercialTerms.setup_fee, recurring_fee: commercialTerms.recurring_fee,
      variable_fee: commercialTerms.variable_fee, binding_months: commercialTerms.binding_months ?? "Ingen bindningstid",
      notice_months: commercialTerms.notice_months ?? "Ej angivet", payment_terms_days: commercialTerms.payment_terms_days ?? "Ej angivet",
    },
    contract: { title: input.title, sales_channel: "api", audience },
    today: new Intl.DateTimeFormat("sv-SE", { dateStyle: "long", timeZone: "Europe/Stockholm" }).format(new Date()),
  };
  const renderedTitle = renderStrictTemplate(templateVersion.title_template, context);
  const renderedBody = renderStrictTemplate(templateVersion.body_template, context);
  const renderedTerms = renderStrictTemplate(templateVersion.terms_template ?? "", context);
  const documentHash = sha256(`${renderedTitle}\n${renderedBody}\n${renderedTerms}\n${JSON.stringify(commercialTerms)}\n${JSON.stringify(sellerSnapshot)}\n${JSON.stringify(counterpartySnapshot)}`);

  const { data, error } = await admin.rpc("create_contract_draft_api_v2", {
    p_tenant_id: identity.tenantId, p_actor_user_id: actor(identity), p_contract_number: contractNumber(),
    p_customer_id: input.customer_id, p_product_id: input.product_id ?? null, p_price_version_id: price?.id ?? null,
    p_template_id: template.id, p_template_version_id: templateVersion.id, p_legal_entity_id: legalEntity.id,
    p_title: renderedTitle, p_rendered_body: renderedBody, p_rendered_terms: renderedTerms,
    p_commercial_terms: commercialTerms, p_document_hash: documentHash, p_seller_snapshot: sellerSnapshot,
    p_counterparty_snapshot: counterpartySnapshot, p_source_call_id: input.source_call_id, p_idempotency_key: input.idempotency_key,
  });
  if (error) {
    if (error.code === "23505") {
      const existing = await replay(identity, "contract.api_created", input.idempotency_key);
      if (existing?.entity_id) return { contract_id: existing.entity_id, idempotent_replay: true };
    }
    throw new Error(error.message);
  }
  return { contract_id: String(data), idempotent_replay: false };
}

export async function sendContractFromApi(identity: ApiIdentity, contractId: string, input: SendInput) {
  const prior = await replay(identity, "contract.api_sent", input.idempotency_key);
  if (prior) return { ...(prior.after_data as Record<string, unknown>), idempotent_replay: true };

  const admin = createAdminClient();
  const [{ data: contract }, { data: tenant }] = await Promise.all([
    admin.from("contracts").select("id,contract_number,title,customer_id,source_call_id,seller_snapshot,customers(display_name,email,phone_e164)")
      .eq("tenant_id", identity.tenantId).eq("id", contractId).single(),
    admin.from("tenants").select("name,legal_name").eq("id", identity.tenantId).single(),
  ]);
  if (!contract) throw new Error("contract_not_found");
  if (!contract.source_call_id) throw new Error("source_call_required");
  const customer = Array.isArray(contract.customers) ? contract.customers[0] : contract.customers;
  const recipientName = input.recipient_name ?? customer?.display_name ?? "Kund";
  const email = input.email?.trim().toLowerCase() ?? customer?.email?.trim().toLowerCase() ?? null;
  let phone = input.phone_e164 ?? customer?.phone_e164 ?? null;
  if (phone) phone = normalizePhone(phone);
  if (["email", "both"].includes(input.channel) && !email) throw new Error("recipient_email_required");
  if (["sms", "both"].includes(input.channel) && !phone) throw new Error("recipient_phone_required");
  const expiresAt = new Date(input.expires_at);
  if (expiresAt <= new Date()) throw new Error("acceptance_expiry_must_be_future");

  const env = serverEnv();
  let emailFrom = "pending@kundexa.local";
  let replyTo = input.reply_to ?? null;
  if (["email", "both"].includes(input.channel)) {
    const { data: integration } = await admin.from("tenant_integrations")
      .select("status,configuration,credentials_ciphertext").eq("tenant_id", identity.tenantId)
      .eq("provider_type", "email").eq("provider", "resend").limit(1).maybeSingle();
    if (integration?.status !== "active") throw new Error("resend_integration_not_active");
    const configuration = (integration.configuration ?? {}) as Record<string, unknown>;
    const accountMode = String(configuration.account_mode ?? "tenant_owned");
    if (accountMode === "platform_managed" && !env.RESEND_API_KEY) throw new Error("platform_resend_key_missing");
    if (accountMode !== "platform_managed" && !integration.credentials_ciphertext) throw new Error("tenant_resend_key_missing");
    emailFrom = String(configuration.from_address ?? configuration.from ?? env.DEFAULT_EMAIL_FROM ?? "");
    replyTo = replyTo ?? (configuration.reply_to ? String(configuration.reply_to) : null);
    if (!/^\S+@\S+\.\S+$/.test(emailFrom)) throw new Error("verified_from_address_required");
  }

  let smsFrom: string | null = null;
  if (["sms", "both"].includes(input.channel)) {
    const { data: number } = await admin.from("phone_numbers").select("number_e164").eq("tenant_id", identity.tenantId)
      .eq("supports_sms", true).eq("status", "active").limit(1).maybeSingle();
    if (!number) throw new Error("sms_number_not_configured");
    smsFrom = number.number_e164;
  }

  const canonical = await ensureCanonicalContractDocument(admin, { tenantId: identity.tenantId, contractId, actorUserId: actor(identity) });
  const token = randomToken();
  const code = randomToken(4).slice(0, 4).toUpperCase();
  const acceptUrl = `${env.NEXT_PUBLIC_APP_URL}/accept/${token}`;
  const expiryLabel = new Intl.DateTimeFormat("sv-SE", { dateStyle: "long", timeStyle: "short", timeZone: "Europe/Stockholm" }).format(expiresAt);
  const sellerSnapshot = (contract.seller_snapshot ?? {}) as Record<string, unknown>;
  const legalName = typeof sellerSnapshot.legal_name === "string" && sellerSnapshot.legal_name.trim()
    ? sellerSnapshot.legal_name
    : tenant?.legal_name ?? tenant?.name ?? "Kundexa-kund";
  const branding = sellerSnapshot.branding && typeof sellerSnapshot.branding === "object"
    ? sellerSnapshot.branding as Record<string, unknown>
    : {};
  const logoUrl = typeof branding.logo_url === "string" && /^https:\/\//i.test(branding.logo_url) ? branding.logo_url : null;
  const contact = [sellerSnapshot.email, sellerSnapshot.phone_e164, sellerSnapshot.website]
    .filter((item): item is string => typeof item === "string" && item.length > 0)
    .join(" · ") || null;
  const rendered = renderContractDeliveryEmail({ legalName, customerName: recipientName, contractNumber: contract.contract_number, contractTitle: contract.title, acceptUrl, expiresAt: expiryLabel, introduction: input.introduction, contact, logoUrl });
  const smsBody = `Avtal ${contract.contract_number} från ${legalName}. Granska: ${acceptUrl}. Svara JA ${code} eller NEJ ${code}. Giltigt till ${expiryLabel}.`;
  const attachments = [{ document_id: canonical.id, filename: canonical.file_name, mime_type: "application/pdf" }];
  const { data, error } = await admin.rpc("prepare_contract_delivery_api_v2", {
    p_tenant_id: identity.tenantId, p_actor_user_id: actor(identity), p_contract_id: contractId,
    p_channel: input.channel, p_recipient_name: recipientName, p_email: email, p_phone_e164: phone,
    p_public_token_hash: sha256(token + env.KUNDEXA_WEBHOOK_PEPPER),
    p_public_token_ciphertext: encryptJson({ token }, env.KUNDEXA_ENCRYPTION_KEY), p_acceptance_code: code,
    p_expires_at: expiresAt.toISOString(), p_canonical_document_id: canonical.id, p_sms_from: smsFrom,
    p_sms_body: smsBody, p_email_from: emailFrom, p_email_subject: rendered.subject, p_email_text: rendered.text,
    p_email_html: rendered.html, p_email_attachments: attachments, p_reply_to: replyTo,
    p_personal_message: input.introduction ?? null, p_idempotency_key: input.idempotency_key,
  });
  if (error) {
    if (error.code === "23505") {
      const existing = await replay(identity, "contract.api_sent", input.idempotency_key);
      if (existing) return { ...(existing.after_data as Record<string, unknown>), idempotent_replay: true };
    }
    throw new Error(error.message);
  }
  return { ...(data as Record<string, unknown>), idempotent_replay: false };
}

export async function scheduleReminderFromApi(identity: ApiIdentity, contractId: string, input: ReminderInput) {
  const prior = await replay(identity, "contract.api_reminder_scheduled", input.idempotency_key);
  if (prior) return { ...(prior.after_data as Record<string, unknown>), idempotent_replay: true };
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("schedule_manual_contract_reminder_api_v2", {
    p_tenant_id: identity.tenantId, p_actor_user_id: actor(identity), p_contract_id: contractId,
    p_channel: input.channel, p_personal_message: input.personal_message ?? null,
    p_attach_pdf: input.attach_pdf, p_idempotency_key: input.idempotency_key,
  });
  if (error) {
    if (error.code === "23505") {
      const existing = await replay(identity, "contract.api_reminder_scheduled", input.idempotency_key);
      if (existing) return { ...(existing.after_data as Record<string, unknown>), idempotent_replay: true };
    }
    throw new Error(error.message);
  }
  return { reminder_id: String(data), idempotent_replay: false };
}

export async function extendExpiryFromApi(identity: ApiIdentity, contractId: string, input: ExtendInput) {
  const prior = await replay(identity, "contract.api_expiry_extended", input.idempotency_key);
  if (prior) return { ...(prior.after_data as Record<string, unknown>), idempotent_replay: true };
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("extend_contract_acceptance_expiry_api_v2", {
    p_tenant_id: identity.tenantId, p_actor_user_id: actor(identity), p_contract_id: contractId,
    p_expires_at: input.expires_at, p_idempotency_key: input.idempotency_key,
  });
  if (error) {
    if (error.code === "23505") {
      const existing = await replay(identity, "contract.api_expiry_extended", input.idempotency_key);
      if (existing) return { ...(existing.after_data as Record<string, unknown>), idempotent_replay: true };
    }
    throw new Error(error.message);
  }
  return { ...(data as Record<string, unknown>), idempotent_replay: false };
}
