import { NextResponse } from "next/server";
import { docusealProvider, reconcileExternalSigning } from "@/lib/signing/orchestration";
export async function POST(request: Request) {
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > 1024 * 1024) return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  let event;
  try { event = docusealProvider().verifyWebhook(bytes, request.headers); }
  catch { return NextResponse.json({ error: "webhook_rejected" }, { status: 403 }); }
  try {
    await reconcileExternalSigning(event);
    return NextResponse.json({ received: true });
  } catch (error) {
    console.error("docuseal_webhook_reconciliation_failed", { eventId: event.providerEventId, code: error instanceof Error ? error.message : "unknown" });
    return NextResponse.json({ error: "reconciliation_pending" }, { status: 503 });
  }
}
