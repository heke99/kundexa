import { publicSigningLink } from "@/lib/signing/public-link";
import { createAdminClient } from "@/lib/supabase/admin";
import { sha256Bytes } from "@/lib/crypto";

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params; const result = await publicSigningLink(token);
  if (!result) return new Response(null, { status: 410 });
  const db = createAdminClient();
  const { data: allowed, error: rateError } = await db.rpc("consume_rate_limit", { p_tenant_id: result.link.tenant_id,
    p_bucket: `signing-document:${result.link.id}`, p_limit: 20, p_window_seconds: 60 });
  if (rateError || !allowed) return new Response(null, { status: rateError ? 503 : 429 });
  const completed = result.envelope.status === "completed";
  const evidence = result.envelope.provider_evidence as Record<string,unknown>;
  const id = completed ? result.envelope.final_document_id : String(evidence.source_document_id ?? "");
  if (!id) return new Response(null, { status: 409 });
  const { data: document, error } = await db.from("contract_documents").select("*")
    .eq("tenant_id", result.link.tenant_id).eq("contract_id", result.contract.id)
    .eq("contract_version_id", result.envelope.contract_version_id).eq("id", id).maybeSingle();
  if (error || !document || (completed && document.document_type !== "signed_pdf")
    || (!completed && document.sha256 !== evidence.source_sha256)) return new Response(null, { status: 409 });
  const { data: blob, error: downloadError } = await db.storage.from("contract-documents").download(document.storage_path);
  if (downloadError || !blob) return new Response(null, { status: 502 });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.length > 20 * 1024 * 1024 || sha256Bytes(bytes) !== document.sha256) return new Response(null, { status: 409 });
  return new Response(bytes, { headers: { "content-type": "application/pdf", "cache-control": "private, no-store",
    "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(document.file_name)}`,
    "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-document-sha256": document.sha256 } });
}
