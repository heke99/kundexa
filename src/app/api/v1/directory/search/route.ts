import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticateRequest } from "@/lib/api-auth";
import { directorySearchSchema, searchDirectoryForTenant } from "@/lib/directory";

export async function POST(request: Request) {
  try {
    const identity = await authenticateRequest(request, "directory:read");
    const input = directorySearchSchema.parse(await request.json());
    const data = await searchDirectoryForTenant(identity.tenantId, input);
    const freshness = data.reduce<Record<string, number>>((counts, row) => {
      const key = String(row.freshness_state ?? "missing");
      counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    }, {});
    return NextResponse.json({ data, meta: { count: data.length, limit: input.limit, offset: input.offset, freshness } });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof z.ZodError) return NextResponse.json({ error: "validation_error", details: error.issues }, { status: 422 });
    return NextResponse.json({ error: error instanceof Error ? error.message : "internal_error" }, { status: 500 });
  }
}
