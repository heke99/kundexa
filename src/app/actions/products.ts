"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
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
    bindingMonths: z.coerce.number().int().min(0).max(240),
    noticeMonths: z.coerce.number().int().min(0).max(120),
    paymentTermsDays: z.coerce.number().int().min(0).max(365),
    terms: z.string().max(8000),
  }).safeParse({
    name: value(form, "name"), sku: value(form, "sku"), description: value(form, "description"),
    productType: value(form, "product_type") || "service",
    setupFee: value(form, "setup_fee") || "0", recurringFee: value(form, "recurring_fee") || "0",
    variableFee: value(form, "variable_fee") || "0", variableFeeLabel: value(form, "variable_fee_label"),
    bindingMonths: value(form, "binding_months") || "0", noticeMonths: value(form, "notice_months") || "0",
    paymentTermsDays: value(form, "payment_terms_days") || "30", terms: value(form, "terms"),
  });
  if (!parsed.success) redirect("/app/products?error=Kontrollera produkt- och prisuppgifterna");

  const supabase = await createClient();
  const { data: product, error } = await supabase.from("products").insert({
    tenant_id: context.tenantId,
    name: parsed.data.name,
    sku: parsed.data.sku || null,
    description: parsed.data.description || null,
    product_type: parsed.data.productType,
  }).select("id").single();
  if (error || !product) redirect(`/app/products?error=${encodeURIComponent(error?.message ?? "Produkten kunde inte skapas")}`);

  const variableFees = parsed.data.variableFee > 0
    ? [{ label: parsed.data.variableFeeLabel || "Rörlig avgift", amount: parsed.data.variableFee }]
    : [];
  const { error: priceError } = await supabase.from("product_price_versions").insert({
    tenant_id: context.tenantId,
    product_id: product.id,
    version: 1,
    setup_fee: parsed.data.setupFee,
    recurring_fee: parsed.data.recurringFee,
    recurring_interval: parsed.data.recurringFee ? "month" : null,
    variable_fees: variableFees,
    binding_months: parsed.data.bindingMonths || null,
    notice_months: parsed.data.noticeMonths || null,
    payment_terms_days: parsed.data.paymentTermsDays,
    terms: parsed.data.terms ? { text: parsed.data.terms } : {},
  });
  if (priceError) {
    await supabase.from("products").delete().eq("id", product.id);
    redirect(`/app/products?error=${encodeURIComponent(priceError.message)}`);
  }

  await supabase.from("audit_logs").insert({
    tenant_id: context.tenantId,
    actor_user_id: context.userId,
    action: "product.created",
    entity_type: "product",
    entity_id: product.id,
    after_data: { price_version: 1, payment_terms_days: parsed.data.paymentTermsDays },
  });
  revalidatePath("/app/products");
  redirect("/app/products");
}
