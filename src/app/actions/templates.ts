"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getAppContext } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseSignaturePolicy } from "@/lib/signing/policy";
import { validatePdfTemplate } from "@/lib/contracts/pdf-field-template";
import { inspectTemplatePdf } from "@/lib/contracts/render-pdf-fields";
import { hashPdfBytes } from "@/lib/contracts/document-hash";
import { can } from "@/lib/permissions";
import { requiredTemplateVariableNames, templateVariableNames } from "@/lib/domain/template";
import { validateTemplateVariables, describeTemplateVariableProblem } from "@/lib/contracts/template-context";

const value = (form: FormData, key: string) => String(form.get(key) ?? "").trim();

export async function createContractTemplateVersion(form: FormData) {
  const ctx = await getAppContext();
  if (!["owner", "admin", "contract_manager", "team_lead"].includes(ctx.role)) redirect("/app/templates?error=Du saknar behörighet att skapa avtalsmallar");

  const parsed = z.object({
    templateId: z.union([z.uuid(), z.literal("")]),
    productId: z.uuid(),
    name: z.string().min(2).max(120),
    contractType: z.string().min(2).max(80),
    audience: z.enum(["B2B", "B2C", "BOTH"]),
    description: z.string().max(500),
    legalEntityId: z.uuid(),
    titleTemplate: z.string().min(2).max(500),
    bodyTemplate: z.string().min(20).max(100_000),
    termsTemplate: z.string().min(20).max(100_000),
  }).safeParse({
    templateId: value(form, "template_id"),
    productId: value(form, "product_id"),
    name: value(form, "name"),
    contractType: value(form, "contract_type"),
    audience: value(form, "audience"),
    description: value(form, "description"),
    legalEntityId: value(form, "legal_entity_id"),
    titleTemplate: value(form, "title_template"),
    bodyTemplate: value(form, "body_template"),
    termsTemplate: value(form, "terms_template"),
  });
  if (!parsed.success) {
    // Avtalet hör till en produkt. Utan den kan ingen säljare någonsin välja det.
    const productMissing = !z.uuid().safeParse(value(form, "product_id")).success;
    const templateId = value(form, "template_id");
    const back = z.uuid().safeParse(templateId).success ? `/app/templates/${templateId}` : "/app/templates";
    redirect(`${back}?error=${encodeURIComponent(productMissing
      ? "Välj vilken produkt avtalet hör till."
      : "Kontrollera mallens namn, målgrupp, juridiska bolag och fullständiga villkor.")}`);
  }

  const variables = templateVariableNames(parsed.data.titleTemplate, parsed.data.bodyTemplate, parsed.data.termsTemplate);
  const required = requiredTemplateVariableNames(parsed.data.titleTemplate, parsed.data.bodyTemplate, parsed.data.termsTemplate);
  // Check the field, not just the group. `{{customer.address}}` is a plausible
  // guess for a field actually called `address_line1`; accepting it here means
  // the mistake surfaces weeks later, for every customer, in front of a seller
  // rather than the person who wrote the template.
  const problems = validateTemplateVariables(variables);
  if (problems.length) {
    const message = problems.slice(0, 4).map(describeTemplateVariableProblem).join(" ");
    const more = problems.length > 4 ? ` (och ${problems.length - 4} till)` : "";
    const back = parsed.data.templateId ? `/app/templates/${parsed.data.templateId}` : `/app/templates?product_id=${parsed.data.productId}`;
    redirect(`${back}${back.includes("?") ? "&" : "?"}error=${encodeURIComponent(message + more)}`);
  }

  let pdfTemplate = null;
  if (value(form, "pdf_template")) {
    try {
      pdfTemplate = validatePdfTemplate(JSON.parse(value(form, "pdf_template")), ctx.tenantId);
      const { data, error } = await createAdminClient().storage.from("contract-documents").download(pdfTemplate.storagePath);
      if (error || !data) throw new Error("pdf_template_source_missing");
      const bytes = new Uint8Array(await data.arrayBuffer());
      if (hashPdfBytes(bytes) !== pdfTemplate.sha256 || JSON.stringify(await inspectTemplatePdf(bytes)) !== JSON.stringify(pdfTemplate.pageSizes)) throw new Error("pdf_template_source_changed");
    } catch (error) {
      redirect(`/app/templates?error=${encodeURIComponent(error instanceof Error ? error.message : "PDF-mallen är ogiltig.")}`);
    }
  }
  const method = value(form, "signature_method") || "simple_click";
  if (!["simple_click", "external_esign"].includes(method)) redirect("/app/templates?error=Signeringsmetoden är inte tillgänglig.");
  const signaturePolicy = parseSignaturePolicy({ method, identityAssuranceLevel: "low", orderedSigning: false, requireFinalProviderDocument: method === "external_esign" });
  if (pdfTemplate?.fields.some(field => field.type === "signature") && method !== "external_esign") redirect("/app/templates?error=En PDF med underskriftsfält behöver extern signering.");
  if (method === "external_esign" && !pdfTemplate?.fields.some(field => field.type === "signature")) redirect("/app/templates?error=Lägg till kundens underskriftsfält i PDF-mallen.");
  const supabase = await createClient();
  // Versionen och produktkopplingen i samma transaktion: ett avtal som skapas
  // men inte hinner kopplas är en mall ingen säljare kan välja.
  const { data: versionId, error } = await supabase.rpc("create_product_contract_template_version", {
    p_product_id: parsed.data.productId,
    p_template_id: parsed.data.templateId || null,
    p_name: parsed.data.name,
    p_contract_type: parsed.data.contractType,
    p_audience: parsed.data.audience,
    p_description: parsed.data.description || null,
    p_legal_entity_id: parsed.data.legalEntityId,
    p_title_template: parsed.data.titleTemplate,
    p_body_template: parsed.data.bodyTemplate,
    p_terms_template: parsed.data.termsTemplate,
    p_variables: variables,
    // The schema used to mark every field required, which was both untrue and
    // unread. A field is required only when the template asks for it without the
    // `?` marker, and now the stored schema says so.
    p_variables_schema: Object.fromEntries(variables.map((name) => [name, { type: "string", required: required.includes(name) }])),
    p_signing_configuration: { methods: ["web", "sms"], require_explicit_acceptance: true, signature_policy: signaturePolicy, provider_key: method === "external_esign" ? "kundexa_native" : null, ...(pdfTemplate ? { pdf_template: pdfTemplate } : {}) },
  });
  // Tillbaka dit man kom ifrån. Den som redigerar en mall står inne i den och
  // vill se resultatet, inte kastas ut i listan.
  if (error || !versionId) {
    const origin = parsed.data.templateId ? `/app/templates/${parsed.data.templateId}` : `/app/templates?product_id=${parsed.data.productId}`;
    redirect(`${origin}${origin.includes("?") ? "&" : "?"}error=${encodeURIComponent(describeTemplateSaveError(error?.message ?? ""))}`);
  }
  // En ny mall får sitt id först nu. Den som skapade den vill se den, inte listan.
  const { data: saved } = await supabase.from("contract_template_versions").select("template_id").eq("id", versionId).maybeSingle();
  const origin = saved?.template_id ? `/app/templates/${saved.template_id}` : "/app/templates";
  revalidatePath("/app/templates");
  revalidatePath("/app/products");
  revalidatePath(origin);
  redirect(`${origin}?message=${encodeURIComponent("Sparat som utkast. En ägare eller administratör godkänner det, sedan kan säljarna välja produkten.")}`);
}

function describeTemplateSaveError(message: string) {
  if (message.includes("product_already_has_contract")) return "Produkten har redan ett avtal. Öppna det avtalet och spara en ny version i stället.";
  if (message.includes("product_not_found")) return "Produkten finns inte.";
  if (message.includes("contract_template_permission_required")) return "Din roll kan inte skriva avtal.";
  if (message.includes("legal_entity_not_found")) return "Det juridiska bolaget finns inte eller är inaktivt.";
  return message || "Avtalet kunde inte sparas.";
}

export async function approveContractTemplateVersion(form: FormData) {
  const ctx = await getAppContext();
  if (!["owner", "admin"].includes(ctx.role)) redirect("/app/templates?error=Endast ägare eller administratör får godkänna juridiska mallversioner");
  const versionId = value(form, "version_id");
  if (!z.uuid().safeParse(versionId).success) redirect("/app/templates?error=Ogiltig mallversion");
  const supabase = await createClient();
  // Mallen bakom versionen, så godkännandet kan lämna tillbaka en till samma
  // sida man stod på. Ett läsfel här är inte ett skäl att avbryta godkännandet
  // -- då hamnar man i listan i stället, och det är en sämre plats, inte ett fel.
  const { data: version } = await supabase.from("contract_template_versions")
    .select("template_id").eq("id", versionId).maybeSingle();
  const origin = version?.template_id ? `/app/templates/${version.template_id}` : "/app/templates";
  const { error } = await supabase.rpc("approve_contract_template_version", { p_version_id: versionId });
  if (error) redirect(`${origin}?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/app/templates");
  if (version?.template_id) revalidatePath(`/app/templates/${version.template_id}`);
  revalidatePath("/app/contracts");
  redirect(`${origin}?message=${encodeURIComponent("Versionen är godkänd och kan nu användas för nya avtal.")}`);
}

/**
 * Raderar ett mallutkast.
 *
 * Ett utkast är ingenting: det är ett förslag som aldrig godkänts och som
 * därför inte kan ligga bakom ett enda avtal. Att inte kunna ta bort ett
 * betydde att varje felskrivning, varje halvfärdigt försök och varje
 * dubblett låg kvar i listan för alltid, och gjorde listan svårare att läsa
 * för varje gång någon provade sig fram.
 *
 * En godkänd version raderas aldrig. Den är den text kunden faktiskt fick, och
 * avtalen pekar på den -- `contract_versions.template_version_id`. Att kunna
 * radera den vore att kunna radera bevisningen.
 *
 * Sista utkastet tar mallen med sig. En mall utan versioner går inte att
 * använda och går inte att fylla på; den skulle bara stå kvar och se ut som ett
 * val.
 */
export async function deleteContractTemplateVersion(form: FormData) {
  const ctx = await getAppContext();
  // Den som får skriva en mall får ta bort sitt eget utkast. Ett utkast bär
  // ingen juridisk vikt, så det vore en märklig ordning att behöva be någon
  // annan städa efter ett stavfel.
  if (!can(ctx.role, "contracts.manage_templates")) {
    redirect("/app/templates?error=" + encodeURIComponent("Du saknar behörighet att ta bort avtalsmallar."));
  }
  const versionId = value(form, "version_id");
  if (!z.uuid().safeParse(versionId).success) redirect("/app/templates?error=Ogiltig mallversion");

  const admin = createAdminClient();
  const { data: version, error: readError } = await admin.from("contract_template_versions")
    .select("id,template_id,version,status")
    .eq("tenant_id", ctx.tenantId).eq("id", versionId).maybeSingle();
  if (readError) redirect("/app/templates?error=" + encodeURIComponent("Mallversionen kunde inte läsas. Inget raderades."));
  if (!version) redirect("/app/templates?error=" + encodeURIComponent("Mallversionen finns inte."));
  const origin = `/app/templates/${version.template_id}`;
  if (version.status !== "draft") {
    redirect(`${origin}?error=${encodeURIComponent(`Version ${version.version} är godkänd och kan inte raderas. Den är den text kunden fick, och avtal pekar på den.`)}`);
  }

  // Ett utkast ska inte kunna ligga bakom ett avtal, men frågan ställs ändå:
  // ett rått foreign key-fel säger inte vilken post som står i vägen, och ett
  // "kunde inte raderas" utan skäl är ett sämre besked än inget alls.
  const { count: inUse, error: useError } = await admin.from("contract_versions")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", ctx.tenantId).eq("template_version_id", versionId);
  if (useError) redirect(`${origin}?error=${encodeURIComponent("Kunde inte kontrollera om versionen används. Inget raderades.")}`);
  if ((inUse ?? 0) > 0) {
    redirect(`${origin}?error=${encodeURIComponent(`Version ${version.version} används av ${inUse} avtal och kan därför inte raderas.`)}`);
  }

  const { count: siblings } = await admin.from("contract_template_versions")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", ctx.tenantId).eq("template_id", version.template_id);
  const lastOne = (siblings ?? 0) <= 1;

  if (lastOne) {
    const { count: contracts, error: contractError } = await admin.from("contracts")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", ctx.tenantId).eq("template_id", version.template_id);
    if (contractError) redirect(`${origin}?error=${encodeURIComponent("Kunde inte kontrollera mallens avtal. Inget raderades.")}`);
    if ((contracts ?? 0) > 0) {
      redirect(`${origin}?error=${encodeURIComponent(`Mallen har ${contracts} avtal kopplade till sig. Utkastet är dess enda version, så mallen kan inte tas bort.`)}`);
    }
  }

  await admin.from("audit_logs").insert({
    tenant_id: ctx.tenantId, actor_user_id: ctx.userId,
    action: lastOne ? "contract_template.deleted" : "contract_template_version.deleted",
    entity_type: "contract_template_version", entity_id: versionId,
    before_data: { template_id: version.template_id, version: version.version, status: version.status },
  });

  // Mallen pekar på sin aktuella version. Pekaren släpps först, annars vägrar
  // databasen raden som pekas på.
  await admin.from("contract_templates").update({ current_version_id: null })
    .eq("tenant_id", ctx.tenantId).eq("id", version.template_id).eq("current_version_id", versionId);
  const { error: deleteError } = await admin.from("contract_template_versions")
    .delete().eq("tenant_id", ctx.tenantId).eq("id", versionId);
  if (deleteError) redirect(`${origin}?error=${encodeURIComponent(deleteError.message)}`);

  if (lastOne) {
    const { error: templateError } = await admin.from("contract_templates")
      .delete().eq("tenant_id", ctx.tenantId).eq("id", version.template_id);
    if (templateError) redirect(`/app/templates?error=${encodeURIComponent(templateError.message)}`);
    revalidatePath("/app/templates");
    redirect(`/app/templates?message=${encodeURIComponent("Mallen och dess enda utkast är raderade.")}`);
  }

  revalidatePath("/app/templates");
  revalidatePath(origin);
  redirect(`${origin}?message=${encodeURIComponent(`Utkastet version ${version.version} är raderat.`)}`);
}
