import type { SupabaseClient } from "@supabase/supabase-js";

export type ContractCallEligibility = { eligible: boolean; reason: string | null; call_id?: string; ended_at?: string; disposition?: string };

export async function assertContractCallEligibility(
  supabase: SupabaseClient,
  customerId: string,
  callId: string,
): Promise<ContractCallEligibility> {
  const { data, error } = await supabase.rpc("get_contract_call_eligibility", { p_customer_id: customerId, p_call_id: callId });
  if (error) throw new Error(error.message);
  const result = data as unknown as ContractCallEligibility;
  if (!result?.eligible) throw new Error(result?.reason ?? "source_call_not_eligible");
  return result;
}
