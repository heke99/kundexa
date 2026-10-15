import { nativeSigningDocument } from "@/lib/signing/orchestration";
export const runtime = "nodejs";
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const bytes = await nativeSigningDocument(token);
    return new Response(Buffer.from(bytes), { headers: { "Content-Type": "application/pdf", "Content-Disposition": 'inline; filename="avtal.pdf"', "Cache-Control": "no-store, private", "X-Content-Type-Options": "nosniff" } });
  } catch { return Response.json({ error: "signing_link_unavailable" }, { status: 410, headers: { "Cache-Control": "no-store" } }); }
}
