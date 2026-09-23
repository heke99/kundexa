import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Utfallen som gör ett manuellt registrerat samtal avtalsgrundande.
 *
 * Samma regel som `manual_contract_disposition_allowed` i databasen: företagets
 * egen lista i `tenant_settings.settings.contracts.manual_call_eligible_dispositions`
 * om den finns, annars standardlistan nedan. Formulären läste tidigare
 * ringlistornas `list_dispositions` -- en annan regel, och en tabell som är tom
 * tills någon skapat en ringlista. Resultatet var ett obligatoriskt val utan
 * alternativ, och ett avtal som därför aldrig kunde få sitt källsamtal.
 */
export const DEFAULT_MANUAL_CONTRACT_DISPOSITIONS = ["interested", "contract", "contract_requested", "sale", "sold", "order"] as const;

const labels: Record<string, string> = {
  interested: "Intresserad",
  contract: "Avtal",
  contract_requested: "Vill ha avtal",
  sale: "Försäljning",
  sold: "Sålt",
  order: "Order",
};

export async function manualContractDispositions(supabase: SupabaseClient, tenantId: string) {
  const { data } = await supabase.from("tenant_settings").select("settings").eq("tenant_id", tenantId).maybeSingle();
  const configured = ((data?.settings as Record<string, unknown> | null)?.contracts as Record<string, unknown> | undefined)
    ?.manual_call_eligible_dispositions;
  const keys = Array.isArray(configured)
    ? configured.filter((key): key is string => typeof key === "string" && key.trim().length > 0)
    : [...DEFAULT_MANUAL_CONTRACT_DISPOSITIONS];
  return keys.map((key) => ({ key, label: labels[key] ?? key }));
}
