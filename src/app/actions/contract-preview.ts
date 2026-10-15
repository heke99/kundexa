"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getAppContext } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ensureCanonicalContractDocument } from "@/lib/contracts/canonical-document";

export async function prepareContractPreview(form: FormData) {
  const ctx = await getAppContext();
  const id = z.uuid().parse(form.get("contract_id"));
  if (!can(ctx.role, "contracts.send")) throw new Error("permission_required");
  const client = await createClient();
  const { data: contract, error } = await client.from("contracts").select("id,status").eq("tenant_id", ctx.tenantId).eq("id", id).maybeSingle();
  if (error || !contract || !["draft", "ready"].includes(contract.status)) redirect(`/app/contracts/${id}?error=Avtalet kan inte förhandsgranskas i detta läge.`);
  try {
    await ensureCanonicalContractDocument(createAdminClient(), { tenantId: ctx.tenantId, contractId: id, actorUserId: ctx.userId });
  } catch (error) {
    redirect(`/app/contracts/${id}?error=${encodeURIComponent(error instanceof Error ? error.message : "Förhandsgranskningen kunde inte skapas.")}`);
  }
  revalidatePath(`/app/contracts/${id}`);
  redirect(`/app/contracts/${id}?message=Kontrollera PDF och mottagare innan du skickar.`);
}
