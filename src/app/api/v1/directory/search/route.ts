import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticateRequest } from "@/lib/api-auth";
import { directorySearchSchema, searchDirectoryForTenant } from "@/lib/directory";

export async function POST(request: Request) {
  try {
    const identity = await authenticateRequest(request, "directory:read");
    const input = directorySearchSchema.parse(await request.json());
    const result = await searchDirectoryForTenant(identity.tenantId, input);
    return NextResponse.json({ data: result.data, meta: { ...result.summary, limit: input.limit, offset: input.offset } });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof z.ZodError) return NextResponse.json({ error: "validation_error", details: error.issues }, { status: 422 });
    return NextResponse.json({ error: error instanceof Error ? error.message : "internal_error" }, { status: 500 });
  }
}
