import { isTenantPdfTemplatePath } from "@/lib/contracts/pdf-field-template";
import { randomUUID } from "node:crypto";
import { getAppContext } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { inspectTemplatePdf } from "@/lib/contracts/render-pdf-fields";
import { hashPdfBytes } from "@/lib/contracts/document-hash";

export async function POST(request: Request) {
  const ctx = await getAppContext();
  if (!["owner", "admin", "contract_manager", "team_lead"].includes(ctx.role)) return Response.json({ error: "Du saknar behörighet att skapa PDF-mallar." }, { status: 403 });
  if (Number(request.headers.get("content-length") ?? 0) > 11 * 1024 * 1024) return Response.json({ error: "PDF-filen får vara högst 10 MB." }, { status: 413 });
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File) || file.size > 10 * 1024 * 1024) return Response.json({ error: "Välj en PDF på högst 10 MB." }, { status: 400 });
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const pageSizes = await inspectTemplatePdf(bytes);
    const sha256 = hashPdfBytes(bytes);
    const storagePath = `${ctx.tenantId}/templates/${randomUUID()}/${sha256}.pdf`;
    const admin = createAdminClient();
    const { error } = await admin.storage.from("contract-documents").upload(storagePath, bytes, { contentType: "application/pdf", upsert: false });
    if (error) throw new Error("PDF-filen kunde inte sparas.");
    return Response.json({ storagePath, sha256, pageSizes });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "PDF-filen kunde inte läsas." }, { status: 422 });
  }
}

export async function GET(request: Request) {
  const ctx = await getAppContext();
  if (!["owner", "admin", "contract_manager", "team_lead"].includes(ctx.role)) return new Response(null, { status: 403 });
  const path = new URL(request.url).searchParams.get("path") ?? "";
  if (!isTenantPdfTemplatePath(path, ctx.tenantId)) return new Response(null, { status: 404 });
  const { data, error } = await createAdminClient().storage.from("contract-documents").download(path);
  if (error || !data) return new Response(null, { status: 404 });
  return new Response(data, { headers: { "Content-Type": "application/pdf", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Disposition": "inline; filename=template.pdf" } });
}
