import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticateRequest } from "@/lib/api-auth";
import { queueEnrichmentForEntity } from "@/lib/directory";

const schema = z.object({
  force: z.boolean().default(false),
  purpose: z.string().min(2).max(100).default("crm_refresh"),
  enrichmentType: z.string().min(2).max(80).default("full"),
  requestedFields: z.array(z.string().min(1).max(100)).max(100).default([]),
  idempotencyKey: z.string().min(8).max(300).optional(),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const identity = await authenticateRequest(request, "directory:refresh");
    const { id } = await params;
    const input = schema.parse(await request.json().catch(() => ({})));
    const result = await queueEnrichmentForEntity({
      tenantId: identity.tenantId,
      userId: identity.userId,
      entityId: id,
      purpose: input.purpose,
      enrichmentType: input.enrichmentType,
      requestedFields: input.requestedFields,
      force: input.force,
      idempotencyKey: input.idempotencyKey || request.headers.get("idempotency-key") || undefined,
    });
    return NextResponse.json({ data: result }, { status: result.job ? 202 : 200 });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof z.ZodError) return NextResponse.json({ error: "validation_error", details: error.issues }, { status: 422 });
    const message = error instanceof Error ? error.message : "internal_error";
    const status = /not_found/.test(message) ? 404 : /permission|feature|provider|account|identifier/.test(message) ? 409 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
