import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticateRequest } from "@/lib/api-auth";
import { directorySearchSchema, searchDirectoryForTenant } from "@/lib/directory";
const schema = z.object({ rules: directorySearchSchema, sampleLimit: z.number().int().min(1).max(200).default(50) });
export async function POST(request: Request) {
  try {
    const identity = await authenticateRequest(request, "directory:read");
    const input = schema.parse(await request.json());
    const result = await searchDirectoryForTenant(identity.tenantId, { ...input.rules, limit: input.sampleLimit, offset: 0 });
    return NextResponse.json({ data: result.data, meta: { ...result.summary, sampleCount: result.data.length, estimatedOnly: false } });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof z.ZodError) return NextResponse.json({ error: "validation_error", details: error.issues }, { status: 422 });
    return NextResponse.json({ error: error instanceof Error ? error.message : "internal_error" }, { status: 500 });
  }
}
