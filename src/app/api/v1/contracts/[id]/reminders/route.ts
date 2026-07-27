import { z } from "zod";
import { authenticateRequest } from "@/lib/api-auth";
import { apiReminderSchema, scheduleReminderFromApi } from "@/lib/contracts/api-service";
import { apiJson, getCorrelationId, withCorrelation } from "@/lib/api-correlation";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const correlationId = getCorrelationId(request);
  try {
    const identity = await authenticateRequest(request, "contracts:remind");
    const { id } = await params;
    const input = apiReminderSchema.parse(await request.json());
    const result = await scheduleReminderFromApi(identity, id, input);
    return apiJson(correlationId, { data: result }, { status: result.idempotent_replay ? 200 : 202 });
  } catch (error) {
    if (error instanceof Response) return withCorrelation(error, correlationId);
    if (error instanceof z.ZodError) return apiJson(correlationId, { error: "validation_error", details: error.issues }, { status: 422 });
    return apiJson(correlationId, { error: error instanceof Error ? error.message : "internal_error" }, { status: 409 });
  }
}
