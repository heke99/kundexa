"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getAppContext } from "@/lib/auth";
import { normalizePhone } from "@/lib/domain/phone";
import { normalizeOrganizationNumber } from "@/lib/imports/organization-number";
import { can } from "@/lib/permissions";

/**
 * Kundkortet under samtalet.
 *
 * `updateCustomerDetails` avslutar med en omdirigering, och en sidladdning mitt
 * i ett samtal river webbtelefonen. De här två åtgärderna läser och sparar samma
 * kort utan att lämna sidan. Bara fälten som skickas skrivs, så ett fält som
 * inte visas under samtalet (kundstatus, rättslig grund, huvudnummer) rörs inte.
 * Huvudnumret är numret som rings och ändras inte mitt i samtalet.
 */

export type CallCustomer = {
  id: string;
  customerType: "person" | "company";
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  organizationNumber: string | null;
  personalIdentityNumber: string | null;
  email: string | null;
  phone: string | null;
  alternatePhone: string | null;
  addressLine1: string | null;
  postalCode: string | null;
  city: string | null;
  website: string | null;
  canEdit: boolean;
};

export type CallCustomerResult = { ok: true; customer: CallCustomer } | { ok: false; error: string };

const customerColumns = "id,customer_type,display_name,first_name,last_name,company_name,organization_number,personal_identity_number,email,phone_e164,alternate_phone_e164,address_line1,postal_code,city,website";

type CustomerRow = {
  id: string; customer_type: string; display_name: string; first_name: string | null; last_name: string | null;
  company_name: string | null; organization_number: string | null; personal_identity_number: string | null;
  email: string | null; phone_e164: string | null; alternate_phone_e164: string | null; address_line1: string | null;
  postal_code: string | null; city: string | null; website: string | null;
};

function toCallCustomer(row: CustomerRow, canEdit: boolean): CallCustomer {
  return {
    id: row.id,
    customerType: row.customer_type === "person" ? "person" : "company",
    displayName: row.display_name,
    firstName: row.first_name,
    lastName: row.last_name,
    companyName: row.company_name,
    organizationNumber: row.organization_number,
    personalIdentityNumber: row.personal_identity_number,
    email: row.email,
    phone: row.phone_e164,
    alternatePhone: row.alternate_phone_e164,
    addressLine1: row.address_line1,
    postalCode: row.postal_code,
    city: row.city,
    website: row.website,
    canEdit,
  };
}

export async function loadCallCustomer(customerId: string): Promise<CallCustomerResult> {
  if (!z.uuid().safeParse(customerId).success) return { ok: false, error: "Ogiltigt kundkort." };
  const ctx = await getAppContext();
  if (!can(ctx.role, "customers.read")) return { ok: false, error: "Din roll kan inte läsa kundkort." };
  const supabase = await createClient();
  const { data, error } = await supabase.from("customers").select(customerColumns).eq("id", customerId).is("deleted_at", null).maybeSingle();
  if (error || !data) return { ok: false, error: "Kundkortet kunde inte läsas." };
  return { ok: true, customer: toCallCustomer(data as CustomerRow, can(ctx.role, "customers.write")) };
}

const plainTextColumns = {
  firstName: "first_name",
  lastName: "last_name",
  companyName: "company_name",
  addressLine1: "address_line1",
  postalCode: "postal_code",
  city: "city",
  website: "website",
} as const;

export type CallCustomerPatch = Partial<Record<
  "displayName" | "firstName" | "lastName" | "companyName" | "organizationNumber" | "personalIdentityNumber"
  | "email" | "alternatePhone" | "addressLine1" | "postalCode" | "city" | "website",
  string
>>;

const patchSchema = z.object({
  displayName: z.string().max(200).optional(),
  firstName: z.string().max(100).optional(),
  lastName: z.string().max(100).optional(),
  companyName: z.string().max(200).optional(),
  organizationNumber: z.string().max(20).optional(),
  personalIdentityNumber: z.string().max(20).optional(),
  email: z.string().max(320).optional(),
  alternatePhone: z.string().max(40).optional(),
  addressLine1: z.string().max(200).optional(),
  postalCode: z.string().max(20).optional(),
  city: z.string().max(100).optional(),
  website: z.string().max(300).optional(),
}).strict();

export async function saveCallCustomer(customerId: string, patch: CallCustomerPatch): Promise<CallCustomerResult> {
  if (!z.uuid().safeParse(customerId).success) return { ok: false, error: "Ogiltigt kundkort." };
  const ctx = await getAppContext();
  if (!can(ctx.role, "customers.write")) return { ok: false, error: "Din roll kan inte ändra kunduppgifter." };
  const parsed = patchSchema.safeParse(patch);
  if (!parsed.success) return { ok: false, error: "Kontrollera uppgifterna." };
  const input = parsed.data;

  const supabase = await createClient();
  const { data: current } = await supabase.from("customers").select("customer_type").eq("id", customerId).is("deleted_at", null).maybeSingle();
  if (!current) return { ok: false, error: "Kundkortet finns inte eller är inte tillgängligt." };

  type CustomerUpdate = {
    display_name?: string; first_name?: string | null; last_name?: string | null; company_name?: string | null;
    organization_number?: string | null; personal_identity_number?: string | null; email?: string | null;
    alternate_phone_e164?: string | null; address_line1?: string | null; postal_code?: string | null;
    city?: string | null; website?: string | null;
  };
  const update: CustomerUpdate = {};
  const text = (raw: string | undefined) => (raw ?? "").trim() || null;

  if (input.displayName !== undefined) {
    const name = input.displayName.trim();
    if (name.length < 2) return { ok: false, error: "Namnet måste vara minst två tecken." };
    update.display_name = name;
  }
  for (const [field, column] of Object.entries(plainTextColumns) as Array<[keyof typeof plainTextColumns, (typeof plainTextColumns)[keyof typeof plainTextColumns]]>) {
    if (input[field] !== undefined) update[column] = text(input[field]);
  }
  if (input.email !== undefined) {
    const email = text(input.email);
    if (email && !z.email().safeParse(email).success) return { ok: false, error: "Ogiltig e-postadress." };
    update.email = email;
  }
  if (input.alternatePhone !== undefined) {
    const raw = text(input.alternatePhone);
    if (raw) {
      try { update.alternate_phone_e164 = normalizePhone(raw); }
      catch { return { ok: false, error: `Ogiltigt telefonnummer: ${raw}` }; }
    } else update.alternate_phone_e164 = null;
  }
  if (input.organizationNumber !== undefined) {
    const raw = text(input.organizationNumber);
    if (raw) {
      const normalized = normalizeOrganizationNumber(raw, { allowPerson: false });
      if (!normalized.valid || !normalized.canonical || normalized.kind !== "company") {
        return { ok: false, error: "Organisationsnumret är ogiltigt." };
      }
      update.organization_number = normalized.canonical;
    } else update.organization_number = null;
  }
  if (input.personalIdentityNumber !== undefined) {
    const raw = text(input.personalIdentityNumber);
    if (raw) {
      if (current.customer_type !== "person") return { ok: false, error: "Ett företag har inget personnummer." };
      const normalized = normalizeOrganizationNumber(raw, { allowPerson: true });
      if (!normalized.valid || !normalized.canonical || normalized.kind !== "person") return { ok: false, error: "Personnumret är ogiltigt." };
      update.personal_identity_number = normalized.canonical;
    } else update.personal_identity_number = null;
  }
  if (!Object.keys(update).length) return loadCallCustomer(customerId);

  const { data, error } = await supabase.from("customers").update(update).eq("id", customerId).select(customerColumns).maybeSingle();
  if (error) return { ok: false, error: error.message.includes("duplicate") ? "Ett annat kundkort har redan det numret." : "Uppgifterna kunde inte sparas." };
  if (!data) return { ok: false, error: "Kunden kunde inte uppdateras. Kontrollera att du har åtkomst till kundkortet." };

  const { error: auditError } = await supabase.from("audit_logs").insert({
    tenant_id: ctx.tenantId,
    actor_user_id: ctx.userId,
    action: "customer.details_updated",
    entity_type: "customer",
    entity_id: customerId,
    after_data: { fields: Object.keys(update), source: "call_workspace" },
  });
  if (auditError) return { ok: false, error: "Uppgifterna sparades men auditloggen kunde inte skrivas." };

  revalidatePath(`/app/customers/${customerId}`);
  return { ok: true, customer: toCallCustomer(data as CustomerRow, true) };
}
