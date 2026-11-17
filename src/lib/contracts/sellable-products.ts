import type { SupabaseClient } from "@supabase/supabase-js";
import { contractApprovalProblems } from "@/lib/contracts/approval-readiness";
import { ok } from "@/lib/supabase/read";

/** RLS-scoped readiness shared by the dialer and contract page. Read failures
 * must reach the error boundary rather than masquerade as zero sellable items. */
export async function countSellableProducts(supabase: SupabaseClient) {
  const today = new Date().toISOString().slice(0, 10);
  const [{ data: products }, { data: templates }, { data: prices }] = await Promise.all([
    ok(supabase.from("products").select("id").eq("active", true)),
    ok(supabase.from("contract_templates").select("product_id,current_version:contract_template_versions!contract_templates_current_version_tenant_fk(status,title_template,body_template,terms_template)").eq("active", true).not("product_id", "is", null).not("current_version_id", "is", null)),
    ok(supabase.from("product_price_versions").select("*").eq("active", true).lte("valid_from", today).or(`valid_to.is.null,valid_to.gte.${today}`).order("version", { ascending: false })),
  ]);
  const activeProducts = new Set((products ?? []).map((row) => row.id));
  const priceByProduct = new Map<string, Record<string, unknown>>();
  for (const price of prices ?? []) if (!priceByProduct.has(price.product_id)) priceByProduct.set(price.product_id, price);
  const sellable = new Set<string>();
  for (const row of templates ?? []) {
    // A many-to-one relation is an object; untyped Supabase clients infer arrays.
    const version = (Array.isArray(row.current_version) ? row.current_version[0] : row.current_version) as {
      status: string; title_template: string; body_template: string; terms_template: string | null;
    } | null;
    if (!activeProducts.has(row.product_id) || version?.status !== "approved") continue;
    if (!contractApprovalProblems({ productId: row.product_id, productActive: true,
      title: version.title_template, body: version.body_template, terms: version.terms_template ?? "",
      price: priceByProduct.get(row.product_id) ?? null }).length) sellable.add(row.product_id);
  }
  return sellable.size;
}
