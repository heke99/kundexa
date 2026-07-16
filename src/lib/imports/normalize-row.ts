import { normalizePhone } from "@/lib/domain/phone";
import type { ImportedRow } from "@/lib/imports/file-parser";
const first = (row: ImportedRow, keys: string[]) => keys.map((key) => row[key]).find((value) => value != null && String(value).trim() !== "");
export function normalizeImportedRow(row: ImportedRow) {
  const errors: string[] = []; const displayName = first(row, ["display_name","name","namn","company_name","foretagsnamn","full_name"]); if (!displayName) errors.push("display_name_required");
  const rawPhone = first(row, ["phone","phone_e164","telefon","telefonnummer","mobile","mobil"]); let phone: string | null = null; if (rawPhone) try { phone = normalizePhone(String(rawPhone)); } catch { errors.push("invalid_phone"); }
  const email = first(row, ["email","e_post","epost"]); if (email && !/^\S+@\S+\.\S+$/.test(String(email))) errors.push("invalid_email");
  const rawType = String(first(row, ["customer_type","entity_type","kundtyp","typ"]) ?? "company").toLowerCase();
  return { errors, normalized: { display_name: displayName ? String(displayName).trim() : null, customer_type: ["person","private","privatperson"].includes(rawType) ? "person" : "company", email: email ? String(email).trim() : null, phone_e164: phone, organization_number: String(first(row,["organization_number","org_number","orgnr","organisationsnummer"]) ?? "").trim() || null, city: String(first(row,["city","ort","postort"]) ?? "").trim() || null, county: String(first(row,["county","lan","län"]) ?? "").trim() || null, industry: String(first(row,["industry","bransch"]) ?? "").trim() || null, sni_code: String(first(row,["sni_code","sni"]) ?? "").trim() || null } };
}
