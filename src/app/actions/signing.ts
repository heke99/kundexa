"use server";
import { z } from "zod";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getAppContext } from "@/lib/auth";
import { assertPermission } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { beginNativeSigning, continueNativeSigning } from "@/lib/signing/orchestration";
import { zonedLocalDateTimeToIso } from "@/lib/domain/time";

export async function beginNativeContractSigning(form: FormData) {
  const ctx = await getAppContext(); assertPermission(ctx.role, "contracts.send");
  const contractId = z.uuid().parse(form.get("contract_id"));
  const own = await createClient();
  const { data: contract, error } = await own.from("contracts").select("id").eq("tenant_id", ctx.tenantId).eq("id", contractId).single();
  if (error || !contract) redirect("/app/contracts?error=Avtalet kunde inte hittas");
  let failure = false;
  try {
    await beginNativeSigning(ctx.tenantId, ctx.userId, { contractId, recipientName: String(form.get("recipient_name") ?? ""),
      email: String(form.get("recipient_email") ?? ""), expiresAt: zonedLocalDateTimeToIso(String(form.get("expires_at") ?? ""), ctx.tenantTimezone), idempotencyKey: String(form.get("idempotency_key") ?? "") });
  } catch (error) { failure = true; console.error("native_signing_start_failed", { contractId, code: error instanceof Error ? error.message : "unknown" }); }
  revalidatePath(`/app/contracts/${contractId}`);
  redirect(`/app/contracts/${contractId}?${failure ? "error=Signeringen kunde inte förberedas. Kontrollera mottagaren och e-postinställningarna. Ett befintligt försök kan återupptas." : "message=Signeringsinbjudan har köats"}`);
}
async function ownEnvelope(form: FormData, permission: "contracts.send" | "contracts.write") {
  const ctx = await getAppContext(); assertPermission(ctx.role, permission);
  const id = z.uuid().parse(form.get("envelope_id")); const own = await createClient();
  const { data: envelope, error } = await own.from("signing_envelopes").select("id,contract_id,status,created_by").eq("tenant_id", ctx.tenantId).eq("provider", "kundexa_native").eq("id", id).single();
  if (error || !envelope) redirect("/app/contracts?error=Signeringen är inte tillgänglig");
  const { data: canWrite, error: accessError } = await own.rpc("can_write_contract", { p_contract_id: envelope.contract_id });
  if (accessError || !canWrite) redirect("/app/contracts?error=Du saknar rätt att ändra avtalet");
  return { ctx, envelope };
}
export async function resumeNativeContractSigning(form: FormData) {
  const { envelope } = await ownEnvelope(form, "contracts.send");
  let failure = false;
  try { await continueNativeSigning(envelope.id); } catch { failure = true; }
  revalidatePath(`/app/contracts/${envelope.contract_id}`);
  redirect(`/app/contracts/${envelope.contract_id}?${failure ? "error=Signeringen kunde inte återupptas. Försök igen senare." : "message=Signeringsstatus har kontrollerats"}`);
}
export async function cancelNativeContractSigning(form: FormData) {
  const { ctx, envelope } = await ownEnvelope(form, "contracts.write");
  const admin: import("@supabase/supabase-js").SupabaseClient = createAdminClient();
  const { error } = await admin.rpc("cancel_native_signing", { p_input: { tenant_id: ctx.tenantId, actor_id: ctx.userId, envelope_id: envelope.id } });
  if (error) redirect(`/app/contracts/${envelope.contract_id}?error=Signeringen kunde inte avbrytas. Ett registrerat svar måste först färdigställas.`);
  revalidatePath(`/app/contracts/${envelope.contract_id}`);
  redirect(`/app/contracts/${envelope.contract_id}?message=Signeringen har avbrutits`);
}
