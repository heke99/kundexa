import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Får företaget skicka avtalet på den kanal säljaren valde?
 *
 * Funktionsflaggorna kontrollerades tidigare bara i utskicksarbetaren, som
 * kastar ett `permanent_`-fel. Det betyder att jobbet dödbrevas. Säljaren hade
 * då redan fått "utskicket har köats" och gått vidare, kunden fick aldrig någon
 * länk, och det enda spåret var en rad i en jobbtabell ingen tittar i.
 *
 * Kontrollen hör hemma före köandet, tillsammans med de andra förutsättningarna
 * som redan prövas där: verifierad avsändaradress, aktiv e-postintegration och
 * ett SMS-kompatibelt nummer. Ett nej ska nå den som står framför skärmen och
 * kan göra något åt det.
 *
 * Båda flaggorna krävs och de betyder olika saker: `outbound_*` är kanalen som
 * helhet, `contract_delivery_*` är rätten att skicka just bindande avtal på den.
 * Ett företag kan ha SMS påslaget för notiser utan att få skicka avtal så.
 */

export type ContractDeliveryChannel = "sms" | "email" | "both";

const REQUIRED_FEATURES: Record<"sms" | "email", { channel: string; delivery: string }> = {
  sms: { channel: "outbound_sms", delivery: "contract_delivery_sms" },
  email: { channel: "outbound_email", delivery: "contract_delivery_email" },
};

const BLOCKER_MESSAGES: Record<string, string> = {
  outbound_sms: "Utgående SMS är avstängt för företaget, så avtalslänken skulle aldrig skickas. En administratör slår på det under Integrationer.",
  contract_delivery_sms: "Avtalsleverans via SMS är avstängd för företaget. En administratör slår på det under Integrationer.",
  outbound_email: "Utgående e-post är avstängd för företaget, så avtalslänken skulle aldrig skickas. En administratör slår på det under Integrationer.",
  contract_delivery_email: "Avtalsleverans via e-post är avstängd för företaget. En administratör slår på det under Integrationer.",
};

export function contractDeliveryFeatureKeys(channel: ContractDeliveryChannel): string[] {
  const parts: ("sms" | "email")[] = channel === "both" ? ["sms", "email"] : [channel];
  return parts.flatMap((part) => [REQUIRED_FEATURES[part].channel, REQUIRED_FEATURES[part].delivery]);
}

export type ContractDeliveryBlocker = { featureKey: string; message: string };

/**
 * Returnerar första hindret, eller `null` när kanalen är öppen.
 *
 * Ett läsfel är inte "avstängt". En databas som inte svarar hade annars läst som
 * att företaget saknar rättigheten, och säljaren hade skickats till en
 * administratör för att slå på något som redan är påslaget. Därför kastas
 * lässfelet vidare i stället för att tolkas.
 */
export async function contractDeliveryBlocker(
  admin: SupabaseClient,
  tenantId: string,
  channel: ContractDeliveryChannel,
): Promise<ContractDeliveryBlocker | null> {
  const required = contractDeliveryFeatureKeys(channel);
  const { data, error } = await admin.from("tenant_features")
    .select("feature_key,enabled")
    .eq("tenant_id", tenantId)
    .in("feature_key", required);
  if (error) throw new Error(`contract_delivery_feature_read_failed:${error.code ?? "unknown"}`);
  const enabled = new Map((data ?? []).map((row) => [String(row.feature_key), row.enabled === true]));
  for (const featureKey of required) {
    // En saknad rad är inte ett påslaget värde. Flaggor skapas av
    // `ensure_tenant_defaults`, och ett företag vars rad aldrig skapades ska
    // stoppas här -- inte upptäckas av en kund som väntar på ett avtal.
    if (!enabled.get(featureKey)) return { featureKey, message: BLOCKER_MESSAGES[featureKey] };
  }
  return null;
}

/**
 * Hur kunden får svara: via länken (`web_acceptance`) och/eller med "JA <kod>"
 * i ett SMS (`sms_acceptance`).
 *
 * Flaggorna fanns men lästes aldrig (FAILURE-0126): SMS-svar godtogs för ett
 * företag som stängt av dem, och webbformuläret visades för ett som stängt av
 * webben. Ett läsfel kastas vidare av samma skäl som ovan.
 */
export type ContractAcceptanceModes = { web: boolean; sms: boolean };

export async function contractAcceptanceModes(admin: SupabaseClient, tenantId: string): Promise<ContractAcceptanceModes> {
  const { data, error } = await admin.from("tenant_features")
    .select("feature_key,enabled")
    .eq("tenant_id", tenantId)
    .in("feature_key", ["web_acceptance", "sms_acceptance"]);
  if (error) throw new Error(`contract_acceptance_feature_read_failed:${error.code ?? "unknown"}`);
  const enabled = new Map((data ?? []).map((row) => [String(row.feature_key), row.enabled === true]));
  return { web: enabled.get("web_acceptance") === true, sms: enabled.get("sms_acceptance") === true };
}

export const NO_ANSWER_PATH_MESSAGE = "Kunden skulle inte kunna svara: varken godkännande via länken eller via SMS är påslaget för företaget på den här kanalen. En administratör slår på det under Integrationer.";
