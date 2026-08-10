import { authenticateRequest, assertApiObjectAccess, dataClientForIdentity } from "@/lib/api-auth";
import { apiJson, getCorrelationId, withCorrelation } from "@/lib/api-correlation";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const correlationId = getCorrelationId(request);
  try {
    const identity = await authenticateRequest(request, "contracts:read");
    const { id } = await params;
    await assertApiObjectAccess(identity, "contract", id);
    const db = await dataClientForIdentity(identity);
    const { data, error } = await db.from("contracts")
      .select("*,customers(*),contract_versions(*),contract_documents(id,document_type,file_name,mime_type,size_bytes,sha256,metadata,created_at),contract_recipients(*),contract_acceptance_requests(id,status,expires_at,opened_at,accepted_at,declined_at,cancelled_at,superseded_at,canonical_document_id,canonical_document_sha256),contract_acceptances(*),contract_deliveries(*),contract_reminders(*),evidence_packages(*),calls!contracts_source_call_tenant_fk(id,status,direction,started_at,answered_at,ended_at,duration_seconds,disposition,notes,metadata,user_id,list_id)")
      .eq("tenant_id", identity.tenantId).eq("id", id).single();
    if (error || !data) return apiJson(correlationId, { error: "not_found" }, { status: 404 });
    return apiJson(correlationId, { data });
  } catch (error) {
    if (error instanceof Response) return withCorrelation(error, correlationId);
    return apiJson(correlationId, { error: error instanceof Error ? error.message : "internal_error" }, { status: 500 });
  }
}
