import { ok } from "@/lib/supabase/read";
import { createClient } from "@/lib/supabase/server";
import type { CallerIdNumber } from "@/components/caller-id-picker";

/**
 * Företagets valbara utgående nummer, och vilket som gäller när inget valts.
 *
 * Filtret är detsamma som `resolve_caller_id_phone_number` använder vid
 * uppringningen. Att erbjuda ett nummer som resolvern sedan hoppar över hade
 * gett ett val som ser sparat ut men inte syns hos mottagaren.
 */
export async function callerIdChoices(): Promise<{
  numbers: CallerIdNumber[];
  tenantDefaultId: string | null;
  tenantDefaultNumber: string | null;
}> {
  const supabase = await createClient();
  const [{ data: numbers }, { data: policy }] = await Promise.all([
    ok(supabase.from("phone_numbers")
      .select("id,number_e164,status,supports_voice")
      .eq("status", "active").eq("supports_voice", true)
      .order("number_e164")),
    ok(supabase.from("telephony_policies").select("default_caller_id_phone_number_id").maybeSingle()),
  ]);

  const available = (numbers ?? []).map((number) => ({ id: number.id, number_e164: number.number_e164 }));
  const tenantDefaultId = policy?.default_caller_id_phone_number_id ?? null;
  return {
    numbers: available,
    tenantDefaultId,
    tenantDefaultNumber: available.find((number) => number.id === tenantDefaultId)?.number_e164 ?? null,
  };
}
