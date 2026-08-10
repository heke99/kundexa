"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { serverEnv } from "@/lib/env";
import { sha256 } from "@/lib/crypto";

const ACCEPTANCE_TEXT = "Jag har läst avtalet och accepterar den visade, hashade avtalsversionen samt förstår att mitt besked dokumenteras.";
const DECLINE_TEXT = "Jag avstår från avtalet och förstår att mitt besked dokumenteras.";

export async function respondPublicContract(formData: FormData) {
  const token = String(formData.get("token") ?? "");
  const parsed = z.object({
    fullName: z.string().min(2).max(200),
    confirm: z.literal("on"),
    decision: z.enum(["accept", "decline"]),
    acceptanceCode: z.string().trim().max(32).optional(),
  }).safeParse({
    fullName: String(formData.get("full_name") ?? "").trim(),
    confirm: formData.get("confirm"),
    decision: String(formData.get("decision") ?? "accept"),
    acceptanceCode: String(formData.get("acceptance_code") ?? "").trim() || undefined,
  });
  if (!token || !parsed.success) redirect(`/accept/${token}?error=Bekräfta namn och ditt uttryckliga besked`);

  const env = serverEnv();
  const admin = createAdminClient();
  const tokenHash = sha256(token + env.KUNDEXA_WEBHOOK_PEPPER);
  const { data: request } = await admin
    .from("contract_acceptance_requests")
    .select("id,tenant_id,status,expires_at,require_code,canonical_document_id,canonical_document_sha256")
    .eq("public_token_hash", tokenHash)
    .single();
  if (!request) redirect(`/accept/${token}?error=Länken är ogiltig`);
  if (request.status !== "pending") redirect(`/accept/${token}?error=Begäran är inte längre aktiv`);
  if (new Date(request.expires_at) <= new Date()) {
    await admin.from("contract_acceptance_requests").update({ status: "expired" }).eq("id", request.id).eq("status", "pending");
    await admin.rpc("cancel_contract_reminders", { p_acceptance_request_id: request.id, p_reason: "expired" });
    redirect(`/accept/${token}?error=Acceptlänken har löpt ut`);
  }
  if (!request.canonical_document_id || !request.canonical_document_sha256) redirect(`/accept/${token}?error=Avtalsdokumentets bindning saknas`);
  if (request.require_code && !parsed.data.acceptanceCode) redirect(`/accept/${token}?error=Ange acceptanskoden som skickades till dig`);

  const { data: allowed } = await admin.rpc("consume_rate_limit", {
    p_tenant_id: request.tenant_id,
    p_bucket: `public-accept:${request.id}`,
    p_limit: 10,
    p_window_seconds: 60,
  });
  if (!allowed) redirect(`/accept/${token}?error=För många försök. Försök igen senare.`);

  const requestHeaders = await headers();
  const ip = requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim() ?? requestHeaders.get("x-real-ip") ?? null;
  const userAgent = requestHeaders.get("user-agent");
  const accepted = parsed.data.decision === "accept";
  const acceptanceText = accepted ? ACCEPTANCE_TEXT : DECLINE_TEXT;
  const { error } = await admin.rpc("record_contract_acceptance_v3", {
    p_request_id: request.id,
    p_method: "web",
    p_status: accepted ? "accepted_via_web" : "declined",
    p_raw_response: accepted ? "WEB_ACCEPT" : "WEB_DECLINE",
    p_normalized_response: accepted ? "WEB_ACCEPT" : "WEB_DECLINE",
    p_acceptance_phrase: parsed.data.fullName,
    p_acceptance_code: parsed.data.acceptanceCode ?? null,
    p_ip_address: ip,
    p_user_agent: userAgent,
    p_provider_message_id: null,
    p_acceptance_text: acceptanceText,
    p_evidence: {
      full_name: parsed.data.fullName,
      public_token_hash: tokenHash,
      canonical_document_id: request.canonical_document_id,
      canonical_document_sha256: request.canonical_document_sha256,
      decision: parsed.data.decision,
    },
  });
  if (error) redirect(`/accept/${token}?error=${encodeURIComponent(error.message)}`);
  redirect(`/accept/${token}?${accepted ? "accepted" : "declined"}=1`);
}

export const acceptPublicContract = respondPublicContract;
