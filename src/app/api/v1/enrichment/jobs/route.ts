import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticateRequest } from "@/lib/api-auth";
import { queueEnrichmentForEntity } from "@/lib/directory";

const schema = z.object({
  entityIds: z.array(z.uuid()).min(1).max(500),
  purpose: z.string().min(2).max(100).default("crm_refresh"),
  enrichmentType: z.string().min(2).max(80).default("full"),
  requestedFields: z.array(z.string().min(1).max(100)).max(100).default([]),
  force: z.boolean().default(false),
  idempotencyKey: z.string().min(8).max(200).optional(),
});

export async function POST(request: Request) {
  try {
    const identity = await authenticateRequest(request, "directory:refresh");
    const input = schema.parse(await request.json());
    const results = [];
    for (const [index, entityId] of input.entityIds.entries()) {
      try {
        results.push(await queueEnrichmentForEntity({
          tenantId: identity.tenantId,
          userId: identity.userId,
          entityId,
          purpose: input.purpose,
          enrichmentType: input.enrichmentType,
          requestedFields: input.requestedFields,
          force: input.force,
          idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:${index}` : undefined,
        }));
      } catch (error) {
        results.push({ entityId, status: "rejected", error: error instanceof Error ? error.message : "unknown_error" });
      }
    }
    const accepted = results.filter((result) => result.status !== "rejected").length;
    const estimatedCost = results.reduce((sum, result) => sum + ("estimatedCost" in result ? Number(result.estimatedCost ?? 0) : 0), 0);
    return NextResponse.json({ data: results, meta: { requested: input.entityIds.length, accepted, rejected: input.entityIds.length - accepted, estimatedCost } }, { status: accepted ? 202 : 409 });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof z.ZodError) return NextResponse.json({ error: "validation_error", details: error.issues }, { status: 422 });
    return NextResponse.json({ error: error instanceof Error ? error.message : "internal_error" }, { status: 500 });
  }
}
