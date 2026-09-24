import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Hur många produkter som går att sälja med avtal: aktiv produkt, ett aktivt
 * avtal med godkänd version och ett aktivt pris. Samma villkor som avtalssidan
 * ställer innan en produkt kan väljas.
 *
 * Dialern använder det för att säga i förväg att inget avtal kan skickas, i
 * stället för att säljaren upptäcker det på avtalssidan efter samtalet.
 */
export async function countSellableProducts(supabase: SupabaseClient) {
  const [{ data: products }, { data: templates }, { data: prices }] = await Promise.all([
    supabase.from("products").select("id").eq("active", true),
    supabase.from("contract_templates").select("product_id").eq("active", true).not("product_id", "is", null).not("current_version_id", "is", null),
    supabase.from("product_price_versions").select("product_id").eq("active", true),
  ]);
  const withContract = new Set((templates ?? []).map((row) => row.product_id as string));
  const withPrice = new Set((prices ?? []).map((row) => row.product_id as string));
  return (products ?? []).filter((product) => withContract.has(product.id) && withPrice.has(product.id)).length;
}
