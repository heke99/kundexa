import type { SupabaseClient } from "@supabase/supabase-js";
import type { ContractAcceptanceModes, ContractDeliveryChannel } from "./delivery-readiness";

export type SignatureMethod = "simple_click" | "sms_otp" | "email_otp";
export function signatureMethod(policy: unknown): SignatureMethod {
  const value = policy && typeof policy === "object" ? policy as Record<string, unknown> : {};
  if (value.requireFinalProviderDocument === true) throw new Error("signature_policy_requires_external_signing");
  const method = value.method ?? "simple_click";
  if (method !== "simple_click" && method !== "sms_otp" && method !== "email_otp") throw new Error("signature_policy_requires_external_signing");
  return method;
}
export async function loadContractSignatureMethod(admin: SupabaseClient, tenantId: string, versionId: string, locked = false): Promise<SignatureMethod> {
  const { data, error } = await admin.from("contract_versions").select("signature_policy_snapshot,template_version_id")
    .eq("tenant_id", tenantId).eq("id", versionId).single();
  if (error || !data) throw new Error("contract_signature_policy_read_failed");
  if (data.signature_policy_snapshot) return signatureMethod(data.signature_policy_snapshot);
  if (locked) throw new Error("contract_signature_policy_snapshot_required");
  if (!data.template_version_id) return "simple_click";
  const { data: template, error: templateError } = await admin.from("contract_template_versions").select("signature_policy")
    .eq("tenant_id", tenantId).eq("id", data.template_version_id).single();
  if (templateError || !template) throw new Error("contract_signature_policy_read_failed");
  return signatureMethod(template.signature_policy);
}
export function planContractDelivery(input: { channel: ContractDeliveryChannel; method: SignatureMethod; modes: ContractAcceptanceModes }) {
  if (input.method === "sms_otp" && input.channel === "email") throw new Error("sms_otp_requires_sms_delivery");
  if (input.method === "email_otp" && input.channel === "sms") throw new Error("email_otp_requires_email_delivery");
  const web = input.modes.web;
  const sms = input.modes.sms && input.channel !== "email" && input.method !== "email_otp";
  if (!web && !sms) throw new Error("contract_acceptance_answer_path_required");
  return { web, sms, codeRequired: input.channel !== "email" || input.method !== "simple_click" };
}
export function acceptanceMethod(method: SignatureMethod, channel: "web" | "sms") {
  if (method === "email_otp" && channel !== "web") throw new Error("acceptance_channel_not_permitted");
  return method === "simple_click" ? channel : method;
}
export function renderContractDeliverySms(input: { contractNumber: string; legalName: string; acceptUrl: string; expiresAt: string; code: string; plan: ReturnType<typeof planContractDelivery> }) {
  const instruction = input.plan.sms ? `Granska: ${input.acceptUrl}. Svara JA ${input.code} eller NEJ ${input.code}.` : `Granska och svara: ${input.acceptUrl}. ${input.plan.codeRequired ? `Kod: ${input.code}. ` : ""}`;
  return `Avtal ${input.contractNumber} från ${input.legalName}. ${instruction} Giltigt till ${input.expiresAt}.`;
}
