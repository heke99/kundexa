"use server";
import { z } from "zod";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getAppContext } from "@/lib/auth";
import { assertPermission } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";
import { beginExternalSigning, continueExternalSigning } from "@/lib/signing/orchestration";
import { zonedLocalDateTimeToIso } from "@/lib/domain/time";

export async function beginDocuSealSigning(form: FormData) {
  const ctx = await getAppContext();
  assertPermission(ctx.role, "contracts.send");
  const contractId = z.uuid().parse(form.get("contract_id"));
  const own = await createClient();
  const { data: contract, error } = await own.from("contracts").select("id").eq("tenant_id", ctx.tenantId).eq("id", contractId).single();
  if (error || !contract) redirect("/app/contracts?error=Avtalet kunde inte hittas");
  let failure: string | null = null;
  try {
    await beginExternalSigning(ctx.tenantId, ctx.userId, { contractId,
      recipientName: String(form.get("recipient_name") ?? ""), email: String(form.get("recipient_email") ?? ""),
      expiresAt: zonedLocalDateTimeToIso(String(form.get("expires_at") ?? ""), ctx.tenantTimezone) ?? "",
      idempotencyKey: String(form.get("idempotency_key") ?? ""),
    });
  } catch (error) {
    console.error("external_signing_start_failed", { contractId, code: error instanceof Error ? error.message : "unknown" });
    failure = "Signeringen kunde inte bekräftas. Använd Återuppta signering för att kontrollera samma försök innan ett nytt skapas.";
  }
  revalidatePath(`/app/contracts/${contractId}`);
  redirect(`/app/contracts/${contractId}?${failure ? `error=${encodeURIComponent(failure)}` : "message=Signeringsinbjudan har köats"}`);
}

export async function resumeDocuSealSigning(form: FormData) {
  const ctx = await getAppContext();
  assertPermission(ctx.role, "contracts.send");
  const envelopeId = z.uuid().parse(form.get("envelope_id"));
  const own = await createClient();
  const { data: envelope, error } = await own.from("signing_envelopes").select("id,contract_id,created_by")
    .eq("tenant_id", ctx.tenantId).eq("id", envelopeId).single();
  if (error || !envelope || (envelope.created_by !== ctx.userId && !["owner", "admin", "contract_manager"].includes(ctx.role))) redirect("/app/contracts?error=Signeringsförsöket är inte tillgängligt");
  let failure = false;
  try { await continueExternalSigning(envelopeId); }
  catch (error) { failure = true; console.error("external_signing_resume_failed", { envelopeId, code: error instanceof Error ? error.message : "unknown" }); }
  revalidatePath(`/app/contracts/${envelope.contract_id}`);
  redirect(`/app/contracts/${envelope.contract_id}?${failure ? "error=Signeringsförsökets utfall är fortfarande oklart. Inget nytt försök har skickats." : "message=Signeringsförsöket har återfunnits"}`);
}

export async function refreshDocuSealSigning(form: FormData) {
  const ctx = await getAppContext();
  assertPermission(ctx.role, "contracts.send");
  const envelopeId = z.uuid().parse(form.get("envelope_id"));
  const own = await createClient();
  const { data: envelope } = await own.from("signing_envelopes").select("id,contract_id,provider_envelope_id").eq("tenant_id", ctx.tenantId).eq("id", envelopeId).single();
  if (!envelope?.provider_envelope_id) redirect("/app/contracts?error=Signeringsförsöket är inte tillgängligt");
  const { reconcileExternalSigning } = await import("@/lib/signing/orchestration");
  let failed = false;
  try { await reconcileExternalSigning({ providerEventId: `poll/${envelope.id}/${crypto.randomUUID()}`, providerEnvelopeId: envelope.provider_envelope_id,
    eventType: "submission.polled", eventAt: new Date().toISOString(), verified: true, payload: { source: "authenticated_server_reconciliation" } }); }
  catch (error) { failed = true; console.error("external_signing_refresh_failed", { envelopeId, code: error instanceof Error ? error.message : "unknown" }); }
  revalidatePath(`/app/contracts/${envelope.contract_id}`);
  redirect(`/app/contracts/${envelope.contract_id}?${failed ? "error=Status kunde inte bekräftas. Försök igen senare." : "message=Signeringsstatus har kontrollerats"}`);
}

export async function cancelDocuSealSigning(form: FormData) {
  const ctx = await getAppContext();
  assertPermission(ctx.role, "contracts.write");
  const envelopeId = z.uuid().parse(form.get("envelope_id"));
  const own = await createClient();
  const { data: envelope } = await own.from("signing_envelopes").select("id,contract_id,provider_envelope_id").eq("tenant_id", ctx.tenantId).eq("id", envelopeId).single();
  if (!envelope?.provider_envelope_id) redirect("/app/contracts?error=Ett oklart signeringsförsök måste återfinnas innan det kan avbrytas");
  const { data: canWrite, error: accessError } = await own.rpc("can_write_contract", { p_contract_id: envelope.contract_id });
  if (accessError || !canWrite) redirect("/app/contracts?error=Du saknar rätt att ändra avtalet");
  const { docusealProvider } = await import("@/lib/signing/orchestration");
  const { createAdminClient } = await import("@/lib/supabase/admin");
  let failed = false;
  try {
    const provider = docusealProvider();
    const before = await provider.fetchEnvelope(envelope.provider_envelope_id);
    if (before.status === "completed") throw new Error("completed_signing_cannot_be_cancelled");
    await provider.cancelEnvelope(envelope.provider_envelope_id);
    if ((await provider.fetchEnvelope(envelope.provider_envelope_id)).status !== "cancelled") throw new Error("provider_cancellation_unconfirmed");
    const { error } = await createAdminClient().from("signing_envelopes").update({ status: "cancelled", cancelled_at: new Date().toISOString() })
      .eq("tenant_id", ctx.tenantId).eq("id", envelopeId).in("status", ["sent", "partially_signed"]);
    if (error) throw error;
    const { error: restoreError } = await createAdminClient().from("contracts").update({ status: "ready" }).eq("tenant_id", ctx.tenantId).eq("id", envelope.contract_id).eq("status", "signing");
    if (restoreError) throw restoreError;
  } catch (error) { failed = true; console.error("external_signing_cancel_failed", { envelopeId, code: error instanceof Error ? error.message : "unknown" }); }
  revalidatePath(`/app/contracts/${envelope.contract_id}`);
  redirect(`/app/contracts/${envelope.contract_id}?${failed ? "error=Avbrytandet kunde inte bekräftas. Kontrollera signeringsstatus." : "message=Signeringen har avbrutits"}`);
}
