import { authenticateRequest, assertApiObjectAccess } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { sha256Bytes } from "@/lib/crypto";
import { apiJson, getCorrelationId, withCorrelation } from "@/lib/api-correlation";

export async function GET(request: Request, { params }: { params: Promise<{ id: string; documentId: string }> }) {
  const correlationId = getCorrelationId(request);
  try {
    const identity = await authenticateRequest(request, "contracts:read");
    const { id, documentId } = await params;
    await assertApiObjectAccess(identity, "contract", id);
    await assertApiObjectAccess(identity, "contract_document", documentId);
    const admin = createAdminClient();
    const { data: document, error } = await admin.from("contract_documents")
      .select("file_name,storage_path,mime_type,sha256")
      .eq("tenant_id", identity.tenantId).eq("contract_id", id).eq("id", documentId).single();
    if (error || !document) return apiJson(correlationId, { error: "document_not_found" }, { status: 404 });
    const { data, error: downloadError } = await admin.storage.from("contract-documents").download(document.storage_path);
    if (downloadError || !data) return apiJson(correlationId, { error: "document_download_failed" }, { status: 502 });
    const bytes = new Uint8Array(await data.arrayBuffer());
    if (bytes.byteLength > 20 * 1024 * 1024) return apiJson(correlationId, { error: "document_too_large" }, { status: 413 });
    if (sha256Bytes(bytes) !== document.sha256) return apiJson(correlationId, { error: "document_hash_mismatch" }, { status: 409 });
    return new Response(bytes, {
      headers: {
        "content-type": document.mime_type,
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(document.file_name)}`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "x-document-sha256": document.sha256,
        "x-correlation-id": correlationId,
      },
    });
  } catch (error) {
    if (error instanceof Response) return withCorrelation(error, correlationId);
    return apiJson(correlationId, { error: "internal_error" }, { status: 500 });
  }
}
