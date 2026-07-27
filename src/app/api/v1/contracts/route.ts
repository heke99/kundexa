import { z } from "zod";
import { authenticateRequest, dataClientForIdentity } from "@/lib/api-auth";
import { apiCreateContractSchema, createContractFromApi } from "@/lib/contracts/api-service";
import { apiJson, getCorrelationId, withCorrelation } from "@/lib/api-correlation";

export async function GET(request: Request) {
  const correlationId = getCorrelationId(request);
  try {
    const identity = await authenticateRequest(request, "contracts:read");
    const url = new URL(request.url);
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 100), 1), 200);
    const db = await dataClientForIdentity(identity);
    let query = db.from("contracts")
      .select("id,contract_number,title,status,audience,value,currency,starts_on,ends_on,source_call_id,source_type,expires_at,first_sent_at,last_sent_at,signed_at,created_at,updated_at,customers(display_name),contract_deliveries(channel,status,provider_status,created_at)")
      .eq("tenant_id", identity.tenantId)
      .order("created_at", { ascending: false }).limit(limit);
    const status = url.searchParams.get("status");
    const customerId = url.searchParams.get("customer_id");
    const sourceCallId = url.searchParams.get("source_call_id");
    if (status) query = query.eq("status", status);
    if (customerId) query = query.eq("customer_id", customerId);
    if (sourceCallId) query = query.eq("source_call_id", sourceCallId);
    const { data, error } = await query;
    if (error) return apiJson(correlationId, { error: error.message }, { status: 400 });
    return apiJson(correlationId, { data, meta: { count: data.length, limit } });
  } catch (error) {
    if (error instanceof Response) return withCorrelation(error, correlationId);
    return apiJson(correlationId, { error: error instanceof Error ? error.message : "internal_error" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const correlationId = getCorrelationId(request);
  try {
    const identity = await authenticateRequest(request, "contracts:write");
    const input = apiCreateContractSchema.parse(await request.json());
    const result = await createContractFromApi(identity, input);
    return apiJson(correlationId, { data: result }, { status: result.idempotent_replay ? 200 : 201 });
  } catch (error) {
    if (error instanceof Response) return withCorrelation(error, correlationId);
    if (error instanceof z.ZodError) return apiJson(correlationId, { error: "validation_error", details: error.issues }, { status: 422 });
    return apiJson(correlationId, { error: error instanceof Error ? error.message : "internal_error" }, { status: 409 });
  }
}
