"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getAppContext } from "@/lib/auth";
import { normalizePhone } from "@/lib/domain/phone";
import { normalizeOrganizationNumber } from "@/lib/imports/organization-number";
import { zonedLocalDateTimeToIso } from "@/lib/domain/time";
import { assertPermission } from "@/lib/permissions";

const value=(fd:FormData,key:string)=>String(fd.get(key)??"").trim();
export async function createCustomer(fd:FormData){const ctx=await getAppContext(); assertPermission(ctx.role,"customers.write"); const schema=z.object({type:z.enum(["person","company"]),displayName:z.string().min(2),email:z.union([z.email(),z.literal("")]),phone:z.string().optional(),city:z.string().optional(),lifecycle:z.enum(["prospect","lead","customer"])}); const parsed=schema.safeParse({type:value(fd,"customer_type"),displayName:value(fd,"display_name"),email:value(fd,"email"),phone:value(fd,"phone"),city:value(fd,"city"),lifecycle:value(fd,"lifecycle")}); if(!parsed.success) redirect('/app/customers?error=Kontrollera kunduppgifterna'); let phone:string|null=null; if(parsed.data.phone){try{phone=normalizePhone(parsed.data.phone)}catch{redirect('/app/customers?error=Ogiltigt telefonnummer')}} const supabase=await createClient(); const {data:status}=await supabase.from('customer_statuses').select('id').eq('key','new').single(); const {data,error}=await supabase.from('customers').insert({tenant_id:ctx.tenantId,customer_type:parsed.data.type,display_name:parsed.data.displayName,email:parsed.data.email||null,phone_e164:phone,city:parsed.data.city||null,lifecycle:parsed.data.lifecycle,status_id:status?.id,created_by:ctx.userId,assigned_user_id:ctx.userId}).select('id').single(); if(error) redirect(`/app/customers?error=${encodeURIComponent(error.message)}`); await supabase.from('audit_logs').insert({tenant_id:ctx.tenantId,actor_user_id:ctx.userId,action:'customer.created',entity_type:'customer',entity_id:data.id,after_data:{display_name:parsed.data.displayName}}); revalidatePath('/app/customers'); redirect(`/app/customers/${data.id}`)}
// Registering a customer needs identity and contact details, but calling one does
// not: the card is created with a name and a number, and everything else is filled
// in here afterwards. Only fields present in the submission are written, so a
// partially filled form never clears data the seller did not touch.
export async function updateCustomerDetails(fd: FormData) {
  const ctx = await getAppContext();
  assertPermission(ctx.role, "customers.write");
  const customerId = value(fd, "customer_id");
  if (!customerId) redirect("/app/customers?error=Kundens id saknas");
  // Explicitly typed so TypeScript treats it as never-returning and narrows after each guard.
  const fail: (message: string) => never = (message) => redirect(`/app/customers/${customerId}?error=${encodeURIComponent(message)}`);

  const schema = z.object({
    displayName: z.string().min(2, "Namnet måste vara minst två tecken"),
    customerType: z.enum(["person", "company"]),
    lifecycle: z.enum(["prospect", "lead", "customer", "former_customer"]),
    email: z.union([z.email("Ogiltig e-postadress"), z.literal("")]),
  });
  const parsed = schema.safeParse({
    displayName: value(fd, "display_name"),
    customerType: value(fd, "customer_type"),
    lifecycle: value(fd, "lifecycle"),
    email: value(fd, "email"),
  });
  if (!parsed.success) fail(parsed.error.issues[0]?.message ?? "Kontrollera kunduppgifterna");
  const details = parsed.data;

  const optionalText = (field: string) => value(fd, field) || null;
  const optionalPhone = (field: string) => {
    const raw = value(fd, field);
    if (!raw) return null;
    try { return normalizePhone(raw); }
    catch { return fail(`Ogiltigt telefonnummer: ${raw}`); }
  };

  // A personal identity number is never stored in the organisation-number field
  // and vice versa; the checksum decides which of the two it is.
  const identity = value(fd, "identity_number");
  let organizationNumber: string | null = null;
  let personalIdentityNumber: string | null = null;
  if (identity) {
    const normalized = normalizeOrganizationNumber(identity, { allowPerson: details.customerType === "person" });
    if (!normalized.valid || !normalized.canonical) {
      fail(details.customerType === "person"
        ? "Person- eller organisationsnumret är ogiltigt."
        : "Organisationsnumret är ogiltigt. Sätt kundtypen till privatperson först om det är ett personnummer.");
    }
    if (details.customerType === "company" && normalized.kind !== "company") {
      fail("Ett företag måste ha ett organisationsnummer, inte ett personnummer.");
    }
    if (normalized.kind === "person") personalIdentityNumber = normalized.canonical;
    else organizationNumber = normalized.canonical;
  }

  const update = {
    display_name: details.displayName,
    customer_type: details.customerType,
    lifecycle: details.lifecycle,
    email: details.email || null,
    phone_e164: optionalPhone("phone"),
    alternate_phone_e164: optionalPhone("alternate_phone"),
    organization_number: organizationNumber,
    personal_identity_number: personalIdentityNumber,
    address_line1: optionalText("address_line1"),
    postal_code: optionalText("postal_code"),
    city: optionalText("city"),
    company_name: optionalText("company_name"),
    industry: optionalText("industry"),
    website: optionalText("website"),
    legal_basis: optionalText("legal_basis"),
  };

  const supabase = await createClient();
  const { data, error } = await supabase.from("customers")
    .update(update)
    .eq("id", customerId)
    .select("id")
    .maybeSingle();
  if (error) fail(error.message);
  if (!data) fail("Kunden kunde inte uppdateras. Kontrollera att du har åtkomst till kundkortet.");

  const { error: auditError } = await supabase.from("audit_logs").insert({
    tenant_id: ctx.tenantId,
    actor_user_id: ctx.userId,
    action: "customer.details_updated",
    entity_type: "customer",
    entity_id: customerId,
    after_data: {
      customer_type: details.customerType,
      lifecycle: details.lifecycle,
      has_identity_number: Boolean(identity),
      has_legal_basis: Boolean(update.legal_basis),
    },
  });
  if (auditError) fail("Uppgifterna sparades men auditloggen kunde inte skrivas.");

  revalidatePath(`/app/customers/${customerId}`);
  revalidatePath("/app/customers");
  redirect(`/app/customers/${customerId}?message=${encodeURIComponent("Kunduppgifterna är sparade.")}`);
}

export async function addNote(fd:FormData){const ctx=await getAppContext(); assertPermission(ctx.role,"customers.write"); const customerId=value(fd,'customer_id'); const body=value(fd,'body'); if(!body)return; const visibility=value(fd,'visibility')||'team'; const noteType=value(fd,'note_type')||'general'; const supabase=await createClient(); const {error}=await supabase.from('notes').insert({tenant_id:ctx.tenantId,customer_id:customerId,body,visibility,note_type:noteType,is_pinned:fd.get('is_pinned')==='on',created_by:ctx.userId}); if(error)redirect(`/app/customers/${customerId}?error=${encodeURIComponent(error.message)}`); revalidatePath(`/app/customers/${customerId}`)}
export async function updateNote(fd:FormData){const ctx=await getAppContext();assertPermission(ctx.role,"customers.write");const customerId=value(fd,"customer_id");const noteId=value(fd,"note_id");const body=value(fd,"body");if(!body)redirect(`/app/customers/${customerId}?error=Anteckningen får inte vara tom`);const supabase=await createClient();const {error}=await supabase.from("notes").update({body,visibility:value(fd,"visibility")||"team",is_pinned:fd.get("is_pinned")==="on"}).eq("id",noteId).eq("customer_id",customerId);if(error)redirect(`/app/customers/${customerId}?error=${encodeURIComponent(error.message)}`);revalidatePath(`/app/customers/${customerId}`);redirect(`/app/customers/${customerId}?note=updated`)}
export async function archiveNote(fd:FormData){const ctx=await getAppContext();assertPermission(ctx.role,"customers.write");const customerId=value(fd,"customer_id");const noteId=value(fd,"note_id");const supabase=await createClient();const {error}=await supabase.from("notes").update({archived_at:new Date().toISOString()}).eq("id",noteId).eq("customer_id",customerId);if(error)redirect(`/app/customers/${customerId}?error=${encodeURIComponent(error.message)}`);revalidatePath(`/app/customers/${customerId}`);redirect(`/app/customers/${customerId}?note=archived`)}
export async function addActivity(fd:FormData){const ctx=await getAppContext();assertPermission(ctx.role,"customers.write");const customerId=value(fd,'customer_id');const title=value(fd,'title');const due=value(fd,'due_at');if(!title)return;const supabase=await createClient();await supabase.from('activities').insert({tenant_id:ctx.tenantId,customer_id:customerId,type:'task',title,assigned_user_id:ctx.userId,due_at:due||null,created_by:ctx.userId});revalidatePath(`/app/customers/${customerId}`)}
// The block itself has always worked: `evaluate_exact_call_policy` refuses on an
// active compliance_blocks row alone. What did not work was the customer card,
// which reads `customers.do_not_call` for both its badge and whether to show the
// dialer — so a blocked customer kept showing "Kontakt tillåten" with a working
// call button, and the refusal only arrived once the seller pressed it.
// `apply_call_block_disposition` sets both; this now does too.
export async function blockCustomer(fd:FormData){const ctx=await getAppContext();assertPermission(ctx.role,"customers.write");const customerId=value(fd,'customer_id');const reason=value(fd,'reason')||'Kundens invändning';const supabase=await createClient();const {error}=await supabase.from('compliance_blocks').insert({tenant_id:ctx.tenantId,customer_id:customerId,channels:['call','sms','email'],reason,source:'manual_customer_block',active:true,created_by:ctx.userId});if(error)redirect(`/app/customers/${customerId}?error=${encodeURIComponent(error.message)}`);const {error:cardError}=await supabase.from('customers').update({do_not_call:true,blocked_reason:reason}).eq('id',customerId);if(cardError)redirect(`/app/customers/${customerId}?error=${encodeURIComponent('Spärren är lagd men kundkortet kunde inte märkas som spärrat. Ladda om sidan.')}`);const {error:auditError}=await supabase.from('audit_logs').insert({tenant_id:ctx.tenantId,actor_user_id:ctx.userId,action:'customer.blocked',entity_type:'customer',entity_id:customerId,after_data:{reason}});if(auditError)console.error('customer_block_audit_failed',{customerId});revalidatePath(`/app/customers/${customerId}`)}

export async function scheduleCallback(fd:FormData){const ctx=await getAppContext();assertPermission(ctx.role,"callbacks.create");const customerId=value(fd,'customer_id');const due=value(fd,'due_at');const scope=value(fd,'scope');if(!customerId||!due)redirect(`/app/customers/${customerId}?error=Tid för återkomst krävs`);let iso:string;try{iso=zonedLocalDateTimeToIso(due,ctx.tenantTimezone)}catch{redirect(`/app/customers/${customerId}?error=Ogiltig tid för tenantens tidszon`)}const supabase=await createClient();const {error}=await supabase.rpc('schedule_customer_callback',{p_customer_id:customerId,p_list_id:value(fd,'list_id')||null,p_scope:scope,p_due_at:iso,p_title:value(fd,'title')||'Återkomst',p_description:value(fd,'description')});if(error)redirect(`/app/customers/${customerId}?error=${encodeURIComponent(error.message)}`);revalidatePath(`/app/customers/${customerId}`);revalidatePath('/app/callbacks');redirect(`/app/customers/${customerId}?callback=created`)}

export async function createManualProspect(fd:FormData){const ctx=await getAppContext();assertPermission(ctx.role,"customers.write");let phone:string;try{phone=normalizePhone(value(fd,'phone'))}catch{redirect('/app/dialer?error=Ogiltigt telefonnummer')}const supabase=await createClient();const {data,error}=await supabase.rpc('create_or_match_manual_prospect',{p_display_name:value(fd,'display_name')||phone,p_phone_e164:phone,p_customer_type:value(fd,'customer_type')==='company'?'company':'person'});if(error)redirect(`/app/dialer?error=${encodeURIComponent(error.message)}`);const result=data as {customerId?:string};if(!result.customerId)redirect('/app/dialer?error=Prospektet kunde inte skapas');revalidatePath('/app/prospects');redirect(`/app/customers/${result.customerId}`)}

// A seller learns a number is NIX-listed in ways that are not a finished call —
// the customer says so on an inbound call, it arrives by email, a colleague
// passes it on. The report therefore belongs on the customer card and not only
// in the dialer's after-work, and it goes through the same RPC either way so the
// two surfaces record identical evidence.
export async function reportCustomerNix(fd: FormData) {
  const ctx = await getAppContext();
  assertPermission(ctx.role, "customers.write");
  const customerId = value(fd, "customer_id");
  if (!z.uuid().safeParse(customerId).success) redirect("/app/customers?error=Ogiltigt kundkort");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("report_customer_nix_listing", {
    p_customer_id: customerId,
    p_notes: value(fd, "notes") || null,
  });
  if (error) {
    // The database speaks in codes; the seller needs to know what to do next.
    const message = error.message.includes("customer_has_no_phone_number")
      ? "Kundkortet saknar telefonnummer, så det finns inget nummer att spärra."
      : error.message.includes("customer_write_permission_required")
        ? "Du saknar behörighet att spärra den här kunden."
        : error.message;
    redirect(`/app/customers/${customerId}?error=${encodeURIComponent(message)}`);
  }
  const result = (data ?? {}) as { status?: string; blockedNumbers?: number };
  revalidatePath(`/app/customers/${customerId}`);
  revalidatePath("/app/compliance");
  redirect(`/app/customers/${customerId}?message=${encodeURIComponent(
    result.status === "already_reported"
      ? "Numret är redan registrerat som NIX-spärrat."
      : `Numret är registrerat som NIX och ${result.blockedNumbers ?? 1} nummer är spärrade för utgående samtal.`,
  )}`);
}
