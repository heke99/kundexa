import { authenticateRequest, assertApiObjectAccess, dataClientForIdentity } from "@/lib/api-auth";
import { apiJson, getCorrelationId, withCorrelation } from "@/lib/api-correlation";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const correlationId = getCorrelationId(request);
  try {
    const identity = await authenticateRequest(request, "contracts:read");
    const { id } = await params;
    await assertApiObjectAccess(identity, "contract", id);
    const db = await dataClientForIdentity(identity);
    const { data, error } = await db.from("contract_deliveries")
      .select("*,email_messages(id,status,provider_status,provider_message_id,sent_at,delivered_at,opened_at,clicked_at,failure_code,error_message),sms_messages(id,status,provider_message_id,sent_at,delivered_at,error_message)")
      .eq("tenant_id", identity.tenantId).eq("contract_id", id).order("created_at", { ascending: false });
    if (error) return apiJson(correlationId, { error: error.message }, { status: 400 });
    return apiJson(correlationId, { data });
  } catch (error) {
    if (error instanceof Response) return withCorrelation(error, correlationId);
    return apiJson(correlationId, { error: error instanceof Error ? error.message : "internal_error" }, { status: 500 });
  }
}
