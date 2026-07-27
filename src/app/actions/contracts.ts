"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getAppContext } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptJson, randomToken, sha256, sha256Bytes } from "@/lib/crypto";
import { serverEnv } from "@/lib/env";
import { normalizePhone } from "@/lib/domain/phone";
import { assertPermission } from "@/lib/permissions";
import { renderStrictTemplate } from "@/lib/domain/template";
import { zonedLocalDateTimeToIso } from "@/lib/domain/time";
import { assertContractCallEligibility } from "@/lib/contracts/call-eligibility";
import { ensureCanonicalContractDocument } from "@/lib/contracts/canonical-document";
import { renderContractDeliveryEmail } from "@/lib/email/templates/contract-delivery";
import { normalizeVariableFees } from "@/lib/contracts/price-terms";

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
    sourceCallId: z.union([z.uuid(), z.literal("")]),
    startsOn: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.literal("")]),
    endsOn: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.literal("")]),
    bindingMonths: z.union([z.string().regex(/^\d{1,3}$/), z.literal("")]),
    noticeMonths: z.union([z.string().regex(/^\d{1,3}$/), z.literal("")]),
    paymentTermsDays: z.union([z.string().regex(/^\d{1,3}$/), z.literal("")]),
    contractValue: z.union([z.string().regex(/^\d+(?:[.,]\d{1,2})?$/), z.literal("")]),
    currency: z.string().regex(/^[A-Z]{3}$/),
    specialTerms: z.string().max(4000),
    language: z.enum(["sv", "en"]),
    ownerUserId: z.union([z.uuid(), z.literal("")]),
    teamId: z.union([z.uuid(), z.literal("")]),
    expiresAt: z.union([z.string().min(16).max(25), z.literal("")]),
  }).safeParse({
    customerId: value(form, "customer_id"),
    productId: value(form, "product_id"),
    templateVersionId: value(form, "template_version_id"),
    legalEntityId: value(form, "legal_entity_id"),
    title: value(form, "title"),
    salesChannel: value(form, "sales_channel") || "other",
    sourceCallId: value(form, "source_call_id"),
    startsOn: value(form, "starts_on"),
    endsOn: value(form, "ends_on"),
    bindingMonths: value(form, "binding_months"),
    noticeMonths: value(form, "notice_months"),
    paymentTermsDays: value(form, "payment_terms_days"),
    contractValue: value(form, "contract_value").replace(",", "."),
    currency: value(form, "currency").toUpperCase() || "SEK",
    specialTerms: value(form, "special_terms"),
    language: value(form, "language") || "sv",
    ownerUserId: value(form, "owner_user_id"),
    teamId: value(form, "team_id"),
    expiresAt: value(form, "expires_at"),
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
    variable_fees: unknown;
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
      supabase.from("product_price_versions").select("id,version,setup_fee,recurring_fee,variable_fees,currency,binding_months,notice_months,payment_terms_days,terms").eq("product_id", parsed.data.productId).eq("active", true).order("version", { ascending: false }).limit(1).maybeSingle(),
    ]);
    if (!productData) redirect("/app/contracts?error=Produkten saknas eller är inaktiv");
    if (!priceData) redirect("/app/contracts?error=Produkten saknar en aktiv prisversion");
    product = productData as ProductRecord;
    price = priceData as PriceRecord;
  }

  const variableFees = normalizeVariableFees(price?.variable_fees);
  const bindingMonths = parsed.data.bindingMonths === "" ? (price?.binding_months ?? null) : Number(parsed.data.bindingMonths);
  const noticeMonths = parsed.data.noticeMonths === "" ? (price?.notice_months ?? null) : Number(parsed.data.noticeMonths);
  const paymentTermsDays = parsed.data.paymentTermsDays === "" ? (price?.payment_terms_days ?? null) : Number(parsed.data.paymentTermsDays);
  if ((bindingMonths ?? 0) > 240 || (noticeMonths ?? 0) > 120 || (paymentTermsDays ?? 0) > 365) {
    redirect("/app/contracts?error=Bindningstid, uppsägningstid eller betalningsvillkor ligger utanför tillåtet intervall");
  }
  const contractValue = parsed.data.contractValue === "" ? Number(price?.recurring_fee ?? 0) : Number(parsed.data.contractValue);
  const additionalTerms = {
    ...(price?.terms ?? {}),
    ...(parsed.data.specialTerms ? { special_conditions: parsed.data.specialTerms } : {}),
  };
  const commercialTerms = {
    currency: parsed.data.currency,
    setup_fee: Number(price?.setup_fee ?? 0),
    recurring_fee: Number(price?.recurring_fee ?? 0),
    variable_fee: variableFees.total,
    variable_fees: variableFees.fees,
    binding_months: bindingMonths,
    notice_months: noticeMonths,
    payment_terms_days: paymentTermsDays,
    contract_value: contractValue,
    starts_on: parsed.data.startsOn || null,
    ends_on: parsed.data.endsOn || null,
    language: parsed.data.language,
    product_id: product?.id ?? null,
    product_name: product?.name ?? null,
    price_version: price?.version ?? null,
    additional_terms: additionalTerms,
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
    contract: {
      title: parsed.data.title, sales_channel: parsed.data.salesChannel, audience,
      starts_on: parsed.data.startsOn || "Ej angivet", ends_on: parsed.data.endsOn || "Ej angivet",
      language: parsed.data.language, special_terms: parsed.data.specialTerms || "Inga särskilda villkor",
    },
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

  let expiresAt: string | null = null;
  if (parsed.data.expiresAt) {
    try {
      expiresAt = zonedLocalDateTimeToIso(parsed.data.expiresAt, ctx.tenantTimezone);
      if (new Date(expiresAt).getTime() <= Date.now()) throw new Error("expiry_not_future");
    } catch {
      redirect("/app/contracts?error=Sista svarsdatum måste vara ett giltigt framtida datum");
    }
  }

  const { data: contractId, error } = await supabase.rpc("create_contract_draft_v3", {
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
    p_owner_user_id: parsed.data.ownerUserId || ctx.userId,
    p_team_id: parsed.data.teamId || null,
    p_starts_on: parsed.data.startsOn || null,
    p_ends_on: parsed.data.endsOn || null,
    p_binding_months: bindingMonths,
    p_notice_months: noticeMonths,
    p_contract_value: contractValue,
    p_currency: parsed.data.currency,
    p_expires_at: expiresAt,
  });
  if (error || !contractId) redirect(`/app/contracts?error=${encodeURIComponent(error?.message ?? "Avtalet kunde inte skapas")}`);

  if (parsed.data.sourceCallId) {
    try {
      await assertContractCallEligibility(supabase, parsed.data.customerId, parsed.data.sourceCallId);
      const { data: sourceCall } = await supabase.from("calls").select("dialer_session_id,metadata").eq("id", parsed.data.sourceCallId).single();
      const metadata = (sourceCall?.metadata ?? {}) as Record<string, unknown>;
      const sourceType = metadata.registered_manually === true ? "external_manual_call" : sourceCall?.dialer_session_id ? "dialer_call" : "manual_call";
      const { error: sourceError } = await supabase.from("contracts").update({ source_call_id: parsed.data.sourceCallId, source_type: sourceType, prepared_at: new Date().toISOString() }).eq("id", contractId);
      if (sourceError) throw sourceError;
    } catch (sourceError) {
      await supabase.from("contracts").delete().eq("id", contractId).eq("status", "draft");
      redirect(`/app/contracts?error=${encodeURIComponent(sourceError instanceof Error ? sourceError.message : "Det valda samtalet är inte avtalsgrundande")}`);
    }
  }

  revalidatePath("/app/contracts");
  redirect(`/app/contracts/${contractId}`);
}

export async function uploadContractPdf(form: FormData) {
  const ctx = await getAppContext();
  assertPermission(ctx.role, "contracts.write");
  const contractId = value(form, "contract_id");
  const file = form.get("file");
  if (!(file instanceof File) || file.type !== "application/pdf" || file.size > 20 * 1024 * 1024) {
    redirect(`/app/contracts/${contractId}?error=PDF krävs och får vara högst 20 MB`);
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
    metadata: { canonical: value(form, "document_mode") === "canonical", upload_mode: value(form, "document_mode") || "attachment" },
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

export async function linkContractSourceCall(form: FormData) {
  const ctx = await getAppContext();
  assertPermission(ctx.role, "contracts.write");
  const contractId = z.uuid().parse(value(form, "contract_id"));
  const callId = z.uuid().parse(value(form, "source_call_id"));
  const supabase = await createClient();
  const { data: contract } = await supabase.from("contracts").select("customer_id,status").eq("id", contractId).single();
  if (!contract || !["draft", "ready"].includes(contract.status)) redirect(`/app/contracts/${contractId}?error=Endast ett utkast kan kopplas till ett nytt samtal`);
  try {
    await assertContractCallEligibility(supabase, contract.customer_id, callId);
  } catch (error) {
    redirect(`/app/contracts/${contractId}?error=${encodeURIComponent(error instanceof Error ? error.message : "Samtalet är inte avtalsgrundande")}`);
  }
  const { data: call } = await supabase.from("calls").select("dialer_session_id,metadata").eq("id", callId).single();
  const metadata = (call?.metadata ?? {}) as Record<string, unknown>;
  const sourceType = metadata.registered_manually === true ? "external_manual_call" : call?.dialer_session_id ? "dialer_call" : "manual_call";
  const { error } = await supabase.from("contracts").update({ source_call_id: callId, source_type: sourceType, prepared_at: new Date().toISOString(), send_block_reason: null }).eq("id", contractId);
  if (error) redirect(`/app/contracts/${contractId}?error=${encodeURIComponent(error.message)}`);
  await supabase.from("contract_events").insert({ tenant_id: ctx.tenantId, contract_id: contractId, event_type: "source_call.linked", actor_user_id: ctx.userId, payload: { source_call_id: callId, source_type: sourceType } });
  revalidatePath(`/app/contracts/${contractId}`);
}

export async function createContractCustomer(form: FormData) {
  const ctx = await getAppContext();
  assertPermission(ctx.role, "customers.write");
  const parsed = z.object({
    customerType: z.enum(["person", "company"]), firstName: z.string().max(120), lastName: z.string().max(120),
    companyName: z.string().max(200), organizationNumber: z.string().max(30), personalIdentityNumber: z.string().max(30),
    contactPerson: z.string().max(200), email: z.union([z.email(), z.literal("")]),
    phone: z.string().min(8), address: z.string().max(250), postalCode: z.string().max(20), city: z.string().max(120), countryCode: z.string().length(2),
  }).safeParse({
    customerType: value(form, "customer_type"), firstName: value(form, "first_name"), lastName: value(form, "last_name"),
    companyName: value(form, "company_name"), organizationNumber: value(form, "organization_number"),
    personalIdentityNumber: value(form, "personal_identity_number"), contactPerson: value(form, "contact_person"), email: value(form, "email").toLowerCase(),
    phone: value(form, "phone_e164"), address: value(form, "address_line1"), postalCode: value(form, "postal_code").replace(/\s+/g, ""),
    city: value(form, "city"), countryCode: (value(form, "country_code") || "SE").toUpperCase(),
  });
  if (!parsed.success) redirect("/app/contracts/new?error=Kontrollera kunduppgifterna");
  const displayName = parsed.data.customerType === "company" ? parsed.data.companyName.trim() : `${parsed.data.firstName} ${parsed.data.lastName}`.trim();
  if (displayName.length < 2) redirect("/app/contracts/new?error=Kundens namn krävs");
  let phone: string;
  try { phone = normalizePhone(parsed.data.phone); } catch { redirect("/app/contracts/new?error=Telefonnumret är ogiltigt"); }
  const organizationNumber = parsed.data.organizationNumber.replace(/\D/g, "") || null;
  const supabase = await createClient();
  let duplicateQuery = supabase.from("customers").select("id,display_name,email,phone_e164,organization_number").is("deleted_at", null);
  const filters = [`phone_e164.eq.${phone}`];
  if (parsed.data.email) filters.push(`email.eq.${parsed.data.email}`);
  if (organizationNumber) filters.push(`organization_number.eq.${organizationNumber}`);
  const { data: duplicate } = await duplicateQuery.or(filters.join(",")).limit(1).maybeSingle();
  if (duplicate) redirect(`/app/contracts/new?customer_id=${duplicate.id}&warning=${encodeURIComponent(`Möjlig dubblett hittades: ${duplicate.display_name}. Befintlig kund har valts.`)}`);
  const { data: status } = await supabase.from("customer_statuses").select("id").eq("key", "new").single();
  const { data: customer, error } = await supabase.from("customers").insert({
    tenant_id: ctx.tenantId, customer_type: parsed.data.customerType, lifecycle: "lead", status_id: status?.id,
    display_name: displayName, first_name: parsed.data.customerType === "person" ? parsed.data.firstName.trim() || null : null,
    last_name: parsed.data.customerType === "person" ? parsed.data.lastName.trim() || null : null,
    company_name: parsed.data.customerType === "company" ? parsed.data.companyName.trim() : null,
    personal_identity_number: parsed.data.customerType === "person" ? parsed.data.personalIdentityNumber.replace(/\s+/g, "") || null : null,
    organization_number: organizationNumber, email: parsed.data.email || null, phone_e164: phone,
    address_line1: parsed.data.address || null, postal_code: parsed.data.postalCode || null, city: parsed.data.city || null,
    country_code: parsed.data.countryCode, assigned_user_id: ctx.userId, created_by: ctx.userId,
  }).select("id").single();
  if (error || !customer) redirect(`/app/contracts/new?error=${encodeURIComponent(error?.message ?? "Kunden kunde inte skapas")}`);
  if (parsed.data.customerType === "company" && parsed.data.contactPerson) {
    const { error: contactError } = await supabase.from("contact_people").insert({
      tenant_id: ctx.tenantId, customer_id: customer.id, full_name: parsed.data.contactPerson,
      email: parsed.data.email || null, phone_e164: phone, is_primary: true,
    });
    if (contactError) {
      await supabase.from("customers").delete().eq("id", customer.id);
      redirect(`/app/contracts/new?error=${encodeURIComponent(contactError.message)}`);
    }
  }
  await supabase.from("audit_logs").insert({ tenant_id: ctx.tenantId, actor_user_id: ctx.userId, action: "customer.created_from_contract_wizard", entity_type: "customer", entity_id: customer.id, after_data: { display_name: displayName, phone_e164: phone, contact_person: parsed.data.contactPerson || null } });
  revalidatePath("/app/contracts/new");
  redirect(`/app/contracts/new?customer_id=${customer.id}&message=Kunden skapades`);
}

export async function registerExternalContractCall(form: FormData) {
  const ctx = await getAppContext();
  assertPermission(ctx.role, "calls.create");
  const parsed = z.object({
    customerId: z.uuid(),
    contractId: z.union([z.uuid(), z.literal("")]),
    phone: z.string().min(8),
    direction: z.enum(["inbound", "outbound"]),
    startedAt: z.string().min(10),
    endedAt: z.string().min(10),
    disposition: z.string().min(1),
    note: z.string().min(3).max(4000),
    externalReference: z.string().max(200).optional(),
    confirmed: z.literal("on"),
  }).safeParse({
    customerId: value(form, "customer_id"), contractId: value(form, "contract_id"), phone: value(form, "phone_e164"),
    direction: value(form, "direction"), startedAt: value(form, "started_at"), endedAt: value(form, "ended_at"),
    disposition: value(form, "disposition"), note: value(form, "note"), externalReference: value(form, "external_reference") || undefined,
    confirmed: value(form, "confirmed"),
  });
  const returnPath = parsed.success && parsed.data.contractId ? `/app/contracts/${parsed.data.contractId}` : "/app/contracts/new";
  if (!parsed.success) redirect(`${returnPath}?error=Alla samtalsuppgifter och bekräftelsen krävs`);
  let phone: string;
  try { phone = normalizePhone(parsed.data.phone); } catch { redirect(`${returnPath}?error=Telefonnumret måste vara giltigt E.164`); }
  let startedAt: string;
  let endedAt: string;
  try {
    startedAt = zonedLocalDateTimeToIso(parsed.data.startedAt, ctx.tenantTimezone);
    endedAt = zonedLocalDateTimeToIso(parsed.data.endedAt, ctx.tenantTimezone);
  } catch { redirect(`${returnPath}?error=Samtalets tider är ogiltiga`); }
  if (new Date(endedAt!) <= new Date(startedAt!) || new Date(endedAt!) > new Date()) redirect(`${returnPath}?error=Samtalets tider är ogiltiga`);
  const supabase = await createClient();
  const { data: callId, error } = await supabase.rpc("register_external_manual_call", {
    p_customer_id: parsed.data.customerId,
    p_phone_e164: phone!,
    p_direction: parsed.data.direction,
    p_started_at: startedAt!,
    p_ended_at: endedAt!,
    p_disposition: parsed.data.disposition,
    p_notes: parsed.data.note,
    p_external_reference: parsed.data.externalReference ?? null,
  });
  if (error || !callId) redirect(`${returnPath}?error=${encodeURIComponent(error?.message ?? "Samtalet kunde inte registreras")}`);
  if (parsed.data.contractId) {
    const formData = new FormData();
    formData.set("contract_id", parsed.data.contractId);
    formData.set("source_call_id", String(callId));
    return linkContractSourceCall(formData);
  }
  redirect(`/app/contracts/new?customer_id=${parsed.data.customerId}&source_call_id=${callId}&message=Tidigare samtal registrerat`);
}

export async function sendContract(form: FormData) {
  const ctx = await getAppContext();
  assertPermission(ctx.role, "contracts.send");
  const contractId = z.uuid().parse(value(form, "contract_id"));
  const channel = z.enum(["sms", "email", "both"]).catch("both").parse(value(form, "channel"));
  const introduction = value(form, "introduction").slice(0, 1500);
  const recipientNameOverride = value(form, "recipient_name").slice(0, 200);
  const emailOverride = value(form, "recipient_email").toLowerCase();
  const replyToOverride = value(form, "reply_to").toLowerCase();
  const expiresAt = value(form, "expires_at") ? new Date(value(form, "expires_at")) : new Date(Date.now() + 7 * 86400000);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date()) redirect(`/app/contracts/${contractId}?error=Sista svarsdatum måste vara i framtiden`);

  const supabase = await createClient();
  const admin = createAdminClient();
  const { data: contract, error: contractError } = await supabase
    .from("contracts")
    .select("id,contract_number,title,customer_id,active_version_id,source_call_id,seller_snapshot,customers(display_name,email,phone_e164)")
    .eq("id", contractId).single();
  if (contractError || !contract?.active_version_id) redirect(`/app/contracts/${contractId}?error=Avtalet saknar aktiv version`);
  if (!contract.source_call_id) redirect(`/app/contracts/${contractId}?error=Giltigt tidigare samtal saknas`);
  try { await assertContractCallEligibility(supabase, contract.customer_id, contract.source_call_id); }
  catch (error) { redirect(`/app/contracts/${contractId}?error=${encodeURIComponent(error instanceof Error ? error.message : "Källsamtalet är inte giltigt")}`); }

  const customerRaw = contract.customers as unknown as { display_name: string; email: string | null; phone_e164: string | null } | { display_name: string; email: string | null; phone_e164: string | null }[] | null;
  const customer = Array.isArray(customerRaw) ? customerRaw[0] : customerRaw;
  if (!customer) redirect(`/app/contracts/${contractId}?error=Kunden saknas`);
  const recipientName = recipientNameOverride || customer.display_name;
  const email = emailOverride || customer.email?.toLowerCase() || null;
  let phone = customer.phone_e164;
  if (phone) { try { phone = normalizePhone(phone); } catch { phone = null; } }
  if ((channel === "sms" || channel === "both") && !phone) redirect(`/app/contracts/${contractId}?error=Kunden saknar giltigt mobilnummer`);
  if ((channel === "email" || channel === "both") && (!email || !/^\S+@\S+\.\S+$/.test(email))) redirect(`/app/contracts/${contractId}?error=Kunden saknar giltig e-post`);

  const env = serverEnv();
  let emailFrom = "pending@kundexa.local";
  let replyTo = replyToOverride || null;
  if (channel === "email" || channel === "both") {
    const { data: integration } = await admin.from("tenant_integrations")
      .select("status,configuration,credentials_ciphertext")
      .eq("tenant_id", ctx.tenantId).eq("provider_type", "email").eq("provider", "resend").limit(1).maybeSingle();
    const configuration = (integration?.configuration ?? {}) as Record<string, unknown>;
    const accountMode = String(configuration.account_mode ?? "tenant_owned");
    if (integration?.status !== "active") redirect(`/app/contracts/${contractId}?error=Resend-integrationen måste testas och vara aktiv innan utskick`);
    if (accountMode === "platform_managed" && !env.RESEND_API_KEY) redirect(`/app/contracts/${contractId}?error=Kundexas plattformshanterade Resend-konto är inte konfigurerat`);
    if (accountMode !== "platform_managed" && !integration.credentials_ciphertext) redirect(`/app/contracts/${contractId}?error=Tenantens Resend API-nyckel saknas`);
    emailFrom = String(configuration.from_address ?? configuration.from ?? env.DEFAULT_EMAIL_FROM ?? "");
    replyTo = replyTo || (configuration.reply_to ? String(configuration.reply_to) : null);
    if (!/^\S+@\S+\.\S+$/.test(emailFrom)) redirect(`/app/contracts/${contractId}?error=Verifierad från-adress saknas`);
  }

  let smsFrom: string | null = null;
  if (channel === "sms" || channel === "both") {
    const { data: number } = await supabase.from("phone_numbers").select("number_e164").eq("supports_sms", true).eq("status", "active").limit(1).maybeSingle();
    if (!number) redirect(`/app/contracts/${contractId}?error=Inget SMS-kompatibelt nummer är konfigurerat`);
    smsFrom = number.number_e164;
  }

  let canonicalDocument;
  try { canonicalDocument = await ensureCanonicalContractDocument(admin, { tenantId: ctx.tenantId, contractId, actorUserId: ctx.userId }); }
  catch (error) { redirect(`/app/contracts/${contractId}?error=${encodeURIComponent(error instanceof Error ? error.message : "Kanonisk PDF kunde inte skapas")}`); }

  const token = randomToken();
  const code = randomToken(4).slice(0, 4).toUpperCase();
  const publicUrl = `${env.NEXT_PUBLIC_APP_URL}/accept/${token}`;
  const expiresLabel = new Intl.DateTimeFormat("sv-SE", { dateStyle: "long", timeStyle: "short", timeZone: "Europe/Stockholm" }).format(expiresAt);
  const sellerSnapshot = (contract.seller_snapshot ?? {}) as Record<string, unknown>;
  const branding = (sellerSnapshot.branding ?? {}) as Record<string, unknown>;
  const snapshotLogoUrl = typeof branding.logo_url === "string" && /^https:\/\//i.test(branding.logo_url) ? branding.logo_url : null;
  const snapshotContact = [sellerSnapshot.email, sellerSnapshot.phone_e164, sellerSnapshot.website].filter((item): item is string => typeof item === "string" && item.length > 0).join(" · ") || null;
  const renderedEmail = renderContractDeliveryEmail({
    legalName: typeof sellerSnapshot.legal_name === "string" ? sellerSnapshot.legal_name : ctx.tenantLegalName,
    customerName: recipientName, contractNumber: contract.contract_number, contractTitle: contract.title,
    acceptUrl: publicUrl, expiresAt: expiresLabel, introduction, contact: snapshotContact, logoUrl: snapshotLogoUrl,
  });
  const smsBody = `Avtal ${contract.contract_number} från ${ctx.tenantLegalName}. Granska: ${publicUrl}. Svara JA ${code} eller NEJ ${code}. Giltigt till ${expiresLabel}.`;
  const attachments = [{ document_id: canonicalDocument.id, filename: canonicalDocument.file_name, mime_type: "application/pdf" }];
  const { error } = await supabase.rpc("prepare_contract_delivery_v2", {
    p_contract_id: contractId,
    p_channel: channel,
    p_recipient_name: recipientName,
    p_email: email,
    p_phone_e164: phone,
    p_public_token_hash: sha256(token + env.KUNDEXA_WEBHOOK_PEPPER),
    p_public_token_ciphertext: encryptJson({ token }, env.KUNDEXA_ENCRYPTION_KEY),
    p_acceptance_code: code,
    p_expires_at: expiresAt.toISOString(),
    p_canonical_document_id: canonicalDocument.id,
    p_sms_from: smsFrom,
    p_sms_body: smsBody,
    p_email_from: emailFrom,
    p_email_subject: renderedEmail.subject,
    p_email_text: renderedEmail.text,
    p_email_html: renderedEmail.html,
    p_email_attachments: attachments,
    p_reply_to: replyTo,
    p_personal_message: introduction || null,
  });
  if (error) redirect(`/app/contracts/${contractId}?error=${encodeURIComponent(error.message)}`);
  revalidatePath(`/app/contracts/${contractId}`);
  revalidatePath("/app/contracts");
  redirect(`/app/contracts/${contractId}?message=Avtalsversionen är låst och utskicket har köats`);
}

export async function sendContractReminder(form: FormData) {
  const ctx = await getAppContext();
  assertPermission(ctx.role, "contracts.remind");
  const contractId = z.uuid().parse(value(form, "contract_id"));
  const channel = z.enum(["email", "sms", "both"]).parse(value(form, "channel") || "email");
  const message = value(form, "personal_message").slice(0, 1500);
  const { data, error } = await (await createClient()).rpc("schedule_manual_contract_reminder", {
    p_contract_id: contractId, p_channel: channel, p_personal_message: message || null,
    p_attach_pdf: form.get("attach_pdf") === "on", p_idempotency_key: value(form, "idempotency_key") || crypto.randomUUID(),
  });
  if (error || !data) redirect(`/app/contracts/${contractId}?error=${encodeURIComponent(error?.message ?? "Påminnelsen kunde inte schemaläggas")}`);
  revalidatePath(`/app/contracts/${contractId}`);
  redirect(`/app/contracts/${contractId}?message=Påminnelsen är köad`);
}

export async function extendContractExpiry(form: FormData) {
  const ctx = await getAppContext();
  assertPermission(ctx.role, "contracts.manage_expiry");
  const contractId = z.uuid().parse(value(form, "contract_id"));
  const expiresAt = new Date(value(form, "expires_at"));
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date()) redirect(`/app/contracts/${contractId}?error=Det nya svarsdatumet måste vara i framtiden`);
  const admin = createAdminClient();
  const { data: request } = await admin.from("contract_acceptance_requests").select("id,expires_at").eq("tenant_id", ctx.tenantId).eq("contract_id", contractId).eq("status", "pending").order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!request) redirect(`/app/contracts/${contractId}?error=Ingen aktiv acceptbegäran finns`);
  const { error } = await admin.from("contract_acceptance_requests").update({ expires_at: expiresAt.toISOString() }).eq("tenant_id", ctx.tenantId).eq("id", request.id).eq("status", "pending");
  if (error) redirect(`/app/contracts/${contractId}?error=${encodeURIComponent(error.message)}`);
  await admin.from("contracts").update({ expires_at: expiresAt.toISOString() }).eq("tenant_id", ctx.tenantId).eq("id", contractId);
  const { data: policy } = await admin.from("contract_reminder_policies").select("final_reminder_before_expiry_hours").eq("tenant_id", ctx.tenantId).maybeSingle();
  if (policy) {
    const finalReminderAt = new Date(expiresAt.getTime() - Number(policy.final_reminder_before_expiry_hours) * 3600000).toISOString();
    await admin.from("contract_reminders").update({ scheduled_at: finalReminderAt })
      .eq("tenant_id", ctx.tenantId).eq("acceptance_request_id", request.id).eq("kind", "automatic").eq("sequence_number", 3).eq("status", "scheduled");
  }
  await admin.from("audit_logs").insert({ tenant_id: ctx.tenantId, actor_user_id: ctx.userId, action: "contract.expiry_extended", entity_type: "contract", entity_id: contractId, before_data: { expires_at: request.expires_at }, after_data: { expires_at: expiresAt.toISOString() } });
  await admin.from("contract_events").insert({ tenant_id: ctx.tenantId, contract_id: contractId, event_type: "contract.expiry_extended", actor_user_id: ctx.userId, payload: { previous_expires_at: request.expires_at, expires_at: expiresAt.toISOString() } });
  revalidatePath(`/app/contracts/${contractId}`);
}

export async function cancelFutureContractReminders(form: FormData) {
  const ctx = await getAppContext();
  assertPermission(ctx.role, "contracts.remind");
  const contractId = z.uuid().parse(value(form, "contract_id"));
  const admin = createAdminClient();
  const now = new Date().toISOString();
  const { data: requests, error: requestError } = await admin.from("contract_acceptance_requests")
    .select("id").eq("tenant_id", ctx.tenantId).eq("contract_id", contractId).eq("status", "pending");
  if (requestError) redirect(`/app/contracts/${contractId}?error=${encodeURIComponent(requestError.message)}`);
  for (const request of requests ?? []) {
    const { error } = await admin.rpc("cancel_contract_reminders", { p_acceptance_request_id: request.id, p_reason: "manual_user_cancellation" });
    if (error) redirect(`/app/contracts/${contractId}?error=${encodeURIComponent(error.message)}`);
  }
  await admin.from("audit_logs").insert({ tenant_id: ctx.tenantId, actor_user_id: ctx.userId, action: "contract.reminders_cancelled", entity_type: "contract", entity_id: contractId, after_data: { cancelled_at: now } });
  await admin.from("contract_events").insert({ tenant_id: ctx.tenantId, contract_id: contractId, event_type: "contract.reminders_cancelled", actor_user_id: ctx.userId, payload: { cancelled_at: now } });
  revalidatePath(`/app/contracts/${contractId}`);
}

export async function activateContract(form: FormData) {
  const ctx = await getAppContext();
  assertPermission(ctx.role, "contracts.activate");
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
