import { createAdminClient } from "@/lib/supabase/admin";
import { serverEnv } from "@/lib/env";
import { sha256, sha256Bytes } from "@/lib/crypto";

export async function GET(requestUrl: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const env = serverEnv();
  const admin = createAdminClient();
  const { data: request } = await admin.from("contract_acceptance_requests")
    .select("tenant_id,status,expires_at,canonical_document_id,canonical_document_sha256")
    .eq("public_token_hash", sha256(token + env.KUNDEXA_WEBHOOK_PEPPER)).single();
  if (!request || !request.canonical_document_id) return Response.json({ error: "document_not_found" }, { status: 404 });
  const clientIp = requestUrl.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? requestUrl.headers.get("x-real-ip") ?? "unknown";
  const { data: allowed } = await admin.rpc("consume_rate_limit", { p_tenant_id: request.tenant_id, p_bucket: `public-contract-document:${request.canonical_document_id}:${clientIp}`, p_limit: 20, p_window_seconds: 60 });
  if (!allowed) return Response.json({ error: "rate_limited" }, { status: 429 });
  if (["cancelled", "superseded"].includes(request.status) || (request.status === "pending" && new Date(request.expires_at) <= new Date())) {
    return Response.json({ error: "acceptance_link_inactive" }, { status: 410 });
  }
  const { data: document } = await admin.from("contract_documents")
    .select("file_name,storage_path,mime_type,sha256")
    .eq("tenant_id", request.tenant_id).eq("id", request.canonical_document_id).single();
  if (!document || document.sha256 !== request.canonical_document_sha256) return Response.json({ error: "document_hash_binding_failed" }, { status: 409 });
  const { data, error } = await admin.storage.from("contract-documents").download(document.storage_path);
  if (error || !data) return Response.json({ error: "document_download_failed" }, { status: 502 });
  const bytes = new Uint8Array(await data.arrayBuffer());
  if (bytes.byteLength > 20 * 1024 * 1024 || sha256Bytes(bytes) !== document.sha256) return Response.json({ error: "document_integrity_failed" }, { status: 409 });
  return new Response(bytes, {
    headers: {
      "content-type": document.mime_type,
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(document.file_name)}`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "x-document-sha256": document.sha256,
    },
  });
}
