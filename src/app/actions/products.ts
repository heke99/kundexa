"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { productContractTermsSchema, nullableMonths } from "@/lib/products/contract-terms";
import { getAppContext } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { assertPermission } from "@/lib/permissions";

const value = (form: FormData, key: string) => String(form.get(key) ?? "").trim();

export async function createProduct(form: FormData) {
  const context = await getAppContext();
  assertPermission(context.role, "products.manage");
  const parsed = z.object({
    name: z.string().min(2).max(200),
    sku: z.string().max(80),
    description: z.string().max(4000),
    productType: z.enum(["service", "product", "package"]),
    setupFee: z.coerce.number().min(0),
    recurringFee: z.coerce.number().min(0),
    variableFee: z.coerce.number().min(0),
    variableFeeLabel: z.string().max(120),
    bindingMonths: nullableMonths(240),
    noticeMonths: nullableMonths(120),
    paymentTermsDays: z.coerce.number().int().min(0).max(365),
    terms: z.string().max(8000),
  }).safeParse({
    name: value(form, "name"), sku: value(form, "sku"), description: value(form, "description"),
    productType: value(form, "product_type") || "service",
    setupFee: value(form, "setup_fee") || "0", recurringFee: value(form, "recurring_fee") || "0",
    variableFee: value(form, "variable_fee") || "0", variableFeeLabel: value(form, "variable_fee_label"),
    bindingMonths: value(form, "binding_months"), noticeMonths: value(form, "notice_months"),
    paymentTermsDays: value(form, "payment_terms_days") || "30", terms: value(form, "terms"),
  });
  if (!parsed.success) redirect("/app/products?error=Kontrollera produkt- och prisuppgifterna");

  const supabase = await createClient();
  const variableFees = parsed.data.variableFee > 0
    ? [{ label: parsed.data.variableFeeLabel || "Rörlig avgift", amount: parsed.data.variableFee }]
    : [];
  const { data: product, error } = await supabase.from("products").insert({
    tenant_id: context.tenantId,
    name: parsed.data.name,
    sku: parsed.data.sku || null,
    description: parsed.data.description || null,
    product_type: parsed.data.productType,
    configuration: {
      _initial_price: {
        currency: "SEK",
        setup_fee: parsed.data.setupFee,
        recurring_fee: parsed.data.recurringFee,
        recurring_interval: parsed.data.recurringFee ? "month" : null,
        variable_fees: variableFees,
        binding_months: parsed.data.bindingMonths,
        notice_months: parsed.data.noticeMonths,
        payment_terms_days: parsed.data.paymentTermsDays,
        terms: parsed.data.terms ? { text: parsed.data.terms } : {},
      },
    },
  }).select("id").single();
  if (error || !product) redirect(`/app/products?error=${encodeURIComponent(error?.message ?? "Produkten och priset kunde inte skapas atomiskt")}`);

  // Initial price and audit are committed by the same database trigger.
  revalidatePath("/app/products");
  // Nästa steg är avtalet i produkten, så dit går man direkt.
  redirect(`/app/templates?product_id=${product.id}&message=${encodeURIComponent(`${parsed.data.name} är skapad. Lägg nu in avtalet som hör till produkten.`)}`);
}

/** A product-local new price version; existing agreement versions are untouched. */
export async function reviseProductContractTerms(form: FormData) {
  const context = await getAppContext();
  assertPermission(context.role, "products.manage");
  const parsed = productContractTermsSchema.extend({
    productId: z.uuid(), expectedPriceId: z.uuid(), requestKey: z.uuid(),
  }).safeParse({
    productId: value(form, "product_id"), expectedPriceId: value(form, "expected_price_id"), requestKey: value(form, "request_key"),
    bindingMonths: value(form, "binding_months"), noticeMonths: value(form, "notice_months"), paymentTermsDays: value(form, "payment_terms_days"),
  });
  if (!parsed.success) redirect("/app/products?error=Kontrollera produktens avtalstider");
  const supabase = await createClient();
  const { error } = await supabase.rpc("revise_product_contract_terms", {
    p_product_id: parsed.data.productId, p_expected_price_id: parsed.data.expectedPriceId,
    p_binding_months: parsed.data.bindingMonths, p_notice_months: parsed.data.noticeMonths,
    p_payment_terms_days: parsed.data.paymentTermsDays, p_request_key: parsed.data.requestKey,
  });
  if (error) {
    const message = error.message.includes("price_version_changed_reload") ? "Prisversionen har ändrats. Ladda om sidan innan du sparar."
      : error.message.includes("scheduled_price_version_requires_review") ? "Produkten har ett framtida pris. Granska det innan avtalstiderna ändras."
      : error.message.includes("contract_required_price_value_missing") ? "Produktens godkända mall kräver det värde som lämnades tomt. Ange värdet eller skapa och godkänn en ny mallversion."
      : "Produktens avtalstider kunde inte sparas. Kontrollera produkt och behörighet.";
    redirect(`/app/products?error=${encodeURIComponent(message)}`);
  }
  for (const path of ["/app/products", "/app/contracts/new", "/app/dialer"]) revalidatePath(path);
  redirect(`/app/products?message=${encodeURIComponent("Ny prisversion sparad för produkten. Nya avtal använder den senaste gällande versionen; befintliga avtal behåller sina värden.")}`);
}
