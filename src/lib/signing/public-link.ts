import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { sha256 } from "@/lib/crypto";
import { serverEnv } from "@/lib/env";

export async function publicSigningLink(token: string) {
  if (!/^[a-zA-Z0-9_-]{20,200}$/.test(token)) return null;
  const db = createAdminClient();
  const { data: link, error } = await db.from("contract_signing_links").select("*")
    .eq("token_hash", sha256(token + serverEnv().KUNDEXA_WEBHOOK_PEPPER)).maybeSingle();
  if (error || !link || link.revoked_at) return null;
  const { data: envelope } = await db.from("signing_envelopes").select("*")
    .eq("tenant_id", link.tenant_id).eq("id", link.envelope_id).maybeSingle();
  if (!envelope || ["cancelled","declined","expired","failed"].includes(envelope.status)) return null;
  const { data: contract } = await db.from("contracts").select("id,contract_number,title,active_version_id,acceptance_generation,status")
    .eq("tenant_id", link.tenant_id).eq("id", envelope.contract_id).maybeSingle();
  if (!contract || contract.acceptance_generation !== envelope.generation || contract.active_version_id !== envelope.contract_version_id
    || ["cancelled","superseded"].includes(contract.status)) return null;
  const expiry = Date.parse(link.expires_at);
  if (Date.now() > expiry + (envelope.status === "completed" ? 90 * 86400_000 : 0)) return null;
  return { link, envelope, contract };
}
