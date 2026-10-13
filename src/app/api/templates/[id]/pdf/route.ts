import { z } from "zod";
import { getAppContext } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";
import { documentsRequest, engineBuilderUrl, readEngineTemplate } from "@/lib/signing/docuseal-client";
import { pdfConfigurationSchema, validatePdfBindings } from "@/lib/contracts/pdf-template";
import { toJson } from "@/lib/supabase/json";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (request.headers.get("origin") !== new URL(request.url).origin) return Response.json({ error: "forbidden" }, { status: 403 });
  const ctx = await getAppContext();
  if (!can(ctx.role, "contracts.manage_templates")) return Response.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const db = await createClient();
  const { data: version, error } = await db.from("contract_template_versions").select("id,template_id,status,signing_configuration")
    .eq("tenant_id", ctx.tenantId).eq("id", id).maybeSingle();
  if (error || !version || version.status !== "draft") return Response.json({ error: "draft_template_required" }, { status: 409 });
  const externalId = `kundexa:${ctx.tenantId}:${version.id}`;
  try {
    const configuration = (version.signing_configuration ?? {}) as Record<string,unknown>;
    if (request.headers.get("content-type")?.includes("multipart/form-data")) {
      const input = await request.formData(); const file = input.get("file");
      if (!(file instanceof File) || file.type !== "application/pdf" || file.size > 20 * 1024 * 1024)
        return Response.json({ error: "PDF krävs, högst 20 MB." }, { status: 422 });
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") return Response.json({ error: "Ogiltig PDF." }, { status: 422 });
      const form = new FormData(); form.set("file", file); form.set("external_id", externalId); form.set("name", "Kundexa avtalsmall");
      const created = await documentsRequest<{ id: number; external_id: string }>("/kundexa/templates", { method: "POST", body: form });
      if (created.external_id !== externalId) throw new Error("template_tenant_binding_mismatch");
      const saved = await db.from("contract_template_versions").update({ signing_configuration: toJson({ ...configuration,
        pdf_draft: { template_id: created.id, external_id: externalId } }) }).eq("tenant_id", ctx.tenantId).eq("id", id).eq("status", "draft");
      if (saved.error) throw new Error(saved.error.message);
      return Response.json({ template_id: created.id, builder_url: engineBuilderUrl(created.id, externalId) });
    }
    const draft = configuration.pdf_draft as { template_id?: number; external_id?: string } | undefined;
    if (!draft?.template_id || draft.external_id !== externalId) throw new Error("upload_pdf_first");
    const input = await request.json() as { action?: string; bindings?: unknown };
    const snapshot = await readEngineTemplate(draft.template_id);
    if (snapshot.external_id !== externalId) throw new Error("template_tenant_binding_mismatch");
    if (snapshot.data.submitters.length !== 1) throw new Error("one_customer_signer_required");
    if (input.action === "load") return Response.json({ snapshot, builder_url: engineBuilderUrl(snapshot.id, externalId) });
    const mapping = z.array(z.object({ field_id: z.uuid(), source: z.string().nullable() })).parse(input.bindings);
    if (mapping.length !== snapshot.data.fields.length || new Set(mapping.map(m => m.field_id)).size !== mapping.length
      || mapping.some(m => !snapshot.data.fields.some(f => f.uuid === m.field_id))) throw new Error("all_pdf_fields_must_be_mapped");
    const config = pdfConfigurationSchema.parse({ mode: "pdf", provider: "docuseal", template_id: snapshot.id,
      external_id: externalId, schema_hash: snapshot.schema_hash, role: snapshot.data.submitters[0].name,
      bindings: snapshot.data.fields.map(field => ({ field_id: field.uuid, name: field.name, type: field.type,
        source: mapping.find(m => m.field_id === field.uuid)?.source ?? null,
        required: field.required !== false })) });
    validatePdfBindings(config);
    const locked = await readEngineTemplate(snapshot.id, true, snapshot.schema_hash);
    if (locked.schema_hash !== snapshot.schema_hash) throw new Error("template_changed_while_saving");
    const { error: savedError } = await db.rpc("save_pdf_template_configuration", { p_version_id: id, p_configuration: toJson(config) });
    if (savedError) throw new Error(savedError.message);
    return Response.json({ saved: true });
  } catch (error) {
    const code = error instanceof Error ? error.message : "pdf_template_failed";
    console.error("pdf_template_failed", { versionId: id, code });
    const known: Record<string,string> = {
      documents_service_not_configured: "Dokumenttjänsten är inte konfigurerad ännu.",
      upload_pdf_first: "Ladda upp PDF-filen först.", required_signature_field_missing: "Lägg till ett obligatoriskt signaturfält.",
      one_customer_signer_required: "Den här mallen ska ha en kund som signerar.", duplicate_pdf_field: "Ge varje fält ett unikt namn.",
    };
    const message = known[code] ?? (code.startsWith("pdf_field_mapping_required:") ? `Välj kundkortsfält för ${code.split(":").slice(1).join(":")}.`
      : "PDF-mallen kunde inte sparas. Kontrollera fälten och försök igen.");
    return Response.json({ error: message }, { status: 409 });
  }
}
