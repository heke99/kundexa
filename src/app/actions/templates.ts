"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getAppContext } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { templateVariableNames } from "@/lib/domain/template";

const value = (form: FormData, key: string) => String(form.get(key) ?? "").trim();

export async function createContractTemplateVersion(form: FormData) {
  const ctx = await getAppContext();
  if (!["owner", "admin", "contract_manager"].includes(ctx.role)) redirect("/app/templates?error=Du saknar behörighet att skapa avtalsmallar");

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
  const allowedRoots = new Set(["seller", "customer", "product", "price", "contract", "today"]);
  const invalid = variables.filter((name) => !allowedRoots.has(name.split(".")[0]));
  if (invalid.length) redirect(`/app/templates?error=${encodeURIComponent(`Ogiltiga mallvariabler: ${invalid.join(", ")}`)}`);

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
    p_variables_schema: Object.fromEntries(variables.map((name) => [name, { type: "string", required: true }])),
    p_signing_configuration: { methods: ["web", "sms"], require_explicit_acceptance: true },
  });
  if (error) redirect(`/app/templates?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/app/templates");
  redirect("/app/templates?message=Ny mallversion skapad som utkast. En ägare eller administratör måste godkänna den.");
}

export async function approveContractTemplateVersion(form: FormData) {
  const ctx = await getAppContext();
  if (!["owner", "admin"].includes(ctx.role)) redirect("/app/templates?error=Endast ägare eller administratör får godkänna juridiska mallversioner");
  const versionId = value(form, "version_id");
  if (!z.uuid().safeParse(versionId).success) redirect("/app/templates?error=Ogiltig mallversion");
  const supabase = await createClient();
  const { error } = await supabase.rpc("approve_contract_template_version", { p_version_id: versionId });
  if (error) redirect(`/app/templates?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/app/templates");
  revalidatePath("/app/contracts");
  redirect("/app/templates?message=Mallversionen är godkänd och kan nu användas för nya avtal");
}
