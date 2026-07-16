"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { serverEnv } from "@/lib/env";
import { sha256 } from "@/lib/crypto";

export async function acceptPublicContract(formData: FormData) {
  const token = String(formData.get("token") ?? "");
  const parsed = z.object({
    fullName: z.string().min(2).max(200),
    confirm: z.literal("on"),
  }).safeParse({
    fullName: String(formData.get("full_name") ?? "").trim(),
    confirm: formData.get("confirm"),
  });
  if (!token || !parsed.success) redirect(`/accept/${token}?error=Bekräfta namn och godkännande`);

  const env = serverEnv();
  const admin = createAdminClient();
  const tokenHash = sha256(token + env.KUNDEXA_WEBHOOK_PEPPER);
  const { data: request } = await admin
    .from("contract_acceptance_requests")
    .select("id,tenant_id,status,expires_at")
    .eq("public_token_hash", tokenHash)
    .single();
  if (!request) redirect(`/accept/${token}?error=Länken är ogiltig`);
  if (request.status !== "pending" || new Date(request.expires_at) < new Date()) {
    redirect(`/accept/${token}?error=Begäran är inte längre aktiv`);
  }

  const { data: allowed } = await admin.rpc("consume_rate_limit", {
    p_tenant_id: request.tenant_id,
    p_bucket: `public-accept:${request.id}`,
    p_limit: 10,
    p_window_seconds: 60,
  });
  if (!allowed) redirect(`/accept/${token}?error=För många försök. Försök igen senare.`);

  const requestHeaders = await headers();
  const ip = requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = requestHeaders.get("user-agent");
  const { error } = await admin.rpc("record_contract_acceptance", {
    p_request_id: request.id,
    p_method: "web",
    p_status: "accepted_via_web",
    p_raw_response: "WEB_ACCEPT",
    p_normalized_response: "WEB_ACCEPT",
    p_acceptance_phrase: "WEB_ACCEPT",
    p_acceptance_code: null,
    p_ip_address: ip,
    p_user_agent: userAgent,
    p_provider_message_id: null,
    p_evidence: { full_name: parsed.data.fullName, public_token_hash: tokenHash },
  });
  if (error) redirect(`/accept/${token}?error=${encodeURIComponent(error.message)}`);
  redirect(`/accept/${token}?accepted=1`);
}
