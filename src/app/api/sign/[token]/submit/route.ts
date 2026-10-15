import { isIP } from "node:net";
import { submitNativeSignature } from "@/lib/signing/orchestration";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  if (Number(request.headers.get("content-length") ?? 0) > 800_000) return Response.json({ error: "signature_too_large" }, { status: 413 });
  try {
    const reader = request.body?.getReader();
    if (!reader) return Response.json({ error: "signature_body_required" }, { status: 422 });
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > 800_000) {
          await reader.cancel();
          return Response.json({ error: "signature_too_large" }, { status: 413 });
        }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
    const body = Buffer.concat(chunks, length).toString("utf8");
    const { token } = await params;
    const ipCandidate = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
    const ipAddress = isIP(ipCandidate) ? ipCandidate : null;
    const result = await submitNativeSignature(token, JSON.parse(body), { ipAddress, userAgent: request.headers.get("user-agent") });
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("native_signature_submission_failed", { code: error instanceof Error ? error.message : "unknown" });
    return Response.json({ error: "signature_not_confirmed", message: "Underskriften kunde inte bekräftas. Försök igen med samma underskrift. Kontakta avsändaren om problemet kvarstår." }, { status: 409, headers: { "Cache-Control": "no-store" } });
  }
}
