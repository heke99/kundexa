"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getAppContext } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { can } from "@/lib/permissions";
import { requiredTemplateVariableNames, templateVariableNames } from "@/lib/domain/template";
import { validateTemplateVariables, describeTemplateVariableProblem } from "@/lib/contracts/template-context";

const value = (form: FormData, key: string) => String(form.get(key) ?? "").trim();

export async function createContractTemplateVersion(form: FormData) {
  const ctx = await getAppContext();
  if (!["owner", "admin", "contract_manager", "team_lead"].includes(ctx.role)) redirect("/app/templates?error=Du saknar behörighet att skapa avtalsmallar");

  const parsed = z.object({
    templateId: z.union([z.uuid(), z.literal("")]),
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
    name: value(form, "name"),
    contractType: value(form, "contract_type"),
    audience: value(form, "audience"),
    description: value(form, "description"),
    legalEntityId: value(form, "legal_entity_id"),
    titleTemplate: value(form, "title_template"),
    bodyTemplate: value(form, "body_template"),
    termsTemplate: value(form, "terms_template"),
  });
  if (!parsed.success) redirect("/app/templates?error=Kontrollera mallens namn, målgrupp, juridiska bolag och fullständiga villkor");

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
    redirect(`/app/templates?error=${encodeURIComponent(message + more)}`);
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("create_contract_template_version", {
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
    p_signing_configuration: { methods: ["web", "sms"], require_explicit_acceptance: true },
  });
  // Tillbaka dit man kom ifrån. Den som redigerar en mall står inne i den och
  // vill se resultatet, inte kastas ut i listan.
  const origin = parsed.data.templateId ? `/app/templates/${parsed.data.templateId}` : "/app/templates";
  if (error) redirect(`${origin}?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/app/templates");
  if (parsed.data.templateId) revalidatePath(`/app/templates/${parsed.data.templateId}`);
  redirect(`${origin}?message=${encodeURIComponent("Ny version sparad som utkast. En ägare eller administratör måste godkänna den innan den kan användas.")}`);
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
