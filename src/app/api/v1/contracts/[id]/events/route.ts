import { authenticateRequest, dataClientForIdentity } from "@/lib/api-auth";
import { apiJson, getCorrelationId, withCorrelation } from "@/lib/api-correlation";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const correlationId = getCorrelationId(request);
  try {
    const identity = await authenticateRequest(request, "contracts:read");
    const { id } = await params;
    const db = await dataClientForIdentity(identity);
    const { data, error } = await db.from("contract_events").select("id,event_type,actor_user_id,payload,occurred_at")
      .eq("tenant_id", identity.tenantId).eq("contract_id", id).order("occurred_at", { ascending: true });
    if (error) return apiJson(correlationId, { error: error.message }, { status: 400 });
    return apiJson(correlationId, { data });
  } catch (error) {
    if (error instanceof Response) return withCorrelation(error, correlationId);
    return apiJson(correlationId, { error: error instanceof Error ? error.message : "internal_error" }, { status: 500 });
  }
}
