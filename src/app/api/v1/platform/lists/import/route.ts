import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { getPlatformContext, isPlatformAdmin } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseImportFile } from "@/lib/imports/file-parser";
import { normalizeImportedRow } from "@/lib/imports/normalize-row";
import { scanImportFile } from "@/lib/imports/malware-scan";

export const runtime = "nodejs";
const MAX_BYTES = 50 * 1024 * 1024;
const MAX_ROWS = 50_000;

const redirectWith = (request: Request, key: "message" | "error", value: string) => {
  const url = new URL("/app/platform/lists", request.url);
  url.searchParams.set(key, value);
  return NextResponse.redirect(url, 303);
};

function nullableText(value: unknown) {
  const text = value == null ? "" : String(value).trim();
  return text || null;
}

function nullableNumber(value: unknown) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nullableInteger(value: unknown) {
  const number = nullableNumber(value);
  return number == null || !Number.isInteger(number) ? null : number;
}

export async function POST(request: Request) {
  let createdListId: string | null = null;
  try {
    const context = await getPlatformContext();
    if (!isPlatformAdmin(context.platformRole)) return redirectWith(request, "error", "Plattformsadmin krävs");
    const form = await request.formData();
    const file = form.get("file");
    const name = String(form.get("name") ?? "").trim();
    const description = String(form.get("description") ?? "").trim();
    const sourceProvider = String(form.get("source_provider") ?? "file").trim() || "file";
    const sourceWebsite = String(form.get("source_website") ?? "").trim() || null;
    const exclusivityMode = String(form.get("exclusivity_mode") ?? "exclusive");
    const recordsPath = String(form.get("records_path") ?? "").trim() || null;
    const worksheetName = String(form.get("worksheet_name") ?? "").trim() || null;
    const headerRow = Number(form.get("header_row") ?? 1);
    const defaultExclusiveDaysRaw = String(form.get("default_exclusive_days") ?? "").trim();
    const defaultExclusiveDays = defaultExclusiveDaysRaw ? Number(defaultExclusiveDaysRaw) : null;

    if (!name || !(file instanceof File) || file.size <= 0 || file.size > MAX_BYTES) throw new Error("invalid_platform_list_file");
    if (!["exclusive", "shared", "time_limited"].includes(exclusivityMode)) throw new Error("invalid_exclusivity_mode");
    if (!Number.isInteger(headerRow) || headerRow < 1 || headerRow > 100) throw new Error("invalid_header_row");
    if (defaultExclusiveDays !== null && (!Number.isInteger(defaultExclusiveDays) || defaultExclusiveDays < 1 || defaultExclusiveDays > 3650)) throw new Error("invalid_default_exclusive_days");

    const buffer = Buffer.from(await file.arrayBuffer());
    const scan = await scanImportFile(buffer, file.name, file.type);
    if (scan.status === "infected") throw new Error("platform_list_file_infected");
    if (scan.status === "failed") throw new Error("platform_list_scan_failed");
    const parsed = await parseImportFile(buffer, file.name, file.type, { recordsPath, worksheetName, headerRow, maxRows: MAX_ROWS });
    if (!parsed.rows.length) throw new Error("platform_list_contains_no_rows");

    const supabase = createAdminClient();
    const existing = await supabase.from("platform_lists").select("id,name").eq("source_file_sha256", scan.sha256).neq("status", "archived").maybeSingle();
    if (existing.error) throw existing.error;
    if (existing.data) return redirectWith(request, "message", `Samma fil finns redan som ${existing.data.name}`);

    const firstNormalized = normalizeImportedRow(parsed.rows[0]);
    const listResult = await supabase.from("platform_lists").insert({
      name,
      description: description || null,
      source_provider: sourceProvider,
      source_website: sourceWebsite,
      source_file_name: file.name,
      source_file_sha256: scan.sha256,
      status: "active",
      exclusivity_mode: exclusivityMode,
      default_exclusive_days: defaultExclusiveDays,
      mapping_snapshot: firstNormalized.mapping,
      import_report: {
        source_type: parsed.sourceType,
        parser_errors: parsed.parserErrors,
        columns: parsed.columns,
        worksheet: parsed.selectedWorksheet,
        records_path: parsed.recordsPath,
        malware_scan: { provider: scan.provider, sha256: scan.sha256 },
      },
      created_by: context.userId,
    }).select("id").single();
    if (listResult.error || !listResult.data) throw listResult.error ?? new Error("platform_list_create_failed");
    const platformListId = String(listResult.data.id);
    createdListId = platformListId;

    let valid = 0;
    let invalid = 0;
    const seenHashes = new Set<string>();
    const seenSourceKeys = new Set<string>();
    const entries = parsed.rows.flatMap((row, index) => {
      const normalized = normalizeImportedRow(row, firstNormalized.mapping);
      const company = normalized.normalized as Record<string, unknown>;
      const contacts = Array.isArray(company.contacts) ? company.contacts as Array<Record<string, unknown>> : [];
      const contact = contacts[0] ?? {};
      const canonical = {
        display_name: company.display_name,
        organization_number: company.organization_number,
        phone_e164: company.phone_e164,
        email: company.email,
        contact_name: contact.full_name,
        contact_phone: contact.phone_e164,
        source_external_id: company.source_external_id,
      };
      const dataHash = createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
      const sourceKey = nullableText(company.source_external_id) ?? nullableText(company.organization_number) ?? nullableText(company.phone_e164) ?? dataHash;
      if (seenHashes.has(dataHash) || seenSourceKeys.has(sourceKey)) return [];
      seenHashes.add(dataHash);
      seenSourceKeys.add(sourceKey);
      const isValid = normalized.errors.length === 0 && Boolean(nullableText(company.display_name));
      if (isValid) valid += 1; else invalid += 1;
      return [{
        platform_list_id: platformListId,
        source_key: sourceKey,
        organization_number: nullableText(company.organization_number),
        display_name: nullableText(company.display_name) ?? `Ogiltig rad ${index + 1}`,
        company_name: nullableText(company.company_name) ?? nullableText(company.display_name),
        contact_name: nullableText(contact.full_name),
        contact_role: nullableText(contact.role) ?? nullableText(contact.title),
        phone_e164: nullableText(company.phone_e164),
        alternate_phone_e164: nullableText(company.alternate_phone_e164),
        contact_phone_e164: nullableText(contact.phone_e164),
        email: nullableText(company.email),
        contact_email: nullableText(contact.email),
        website: nullableText(company.website),
        address_line1: nullableText(company.address_line1),
        postal_code: nullableText(company.postal_code),
        city: nullableText(company.city),
        municipality: nullableText(company.municipality),
        county: nullableText(company.county),
        country_code: nullableText(company.country_code) ?? "SE",
        industry: nullableText(company.industry),
        sni_code: nullableText(company.sni_code),
        revenue: nullableNumber(company.revenue),
        employee_count: nullableInteger(company.employee_count),
        source_external_id: nullableText(company.source_external_id),
        state: isValid ? "available" : "invalid",
        data_hash: dataHash,
        raw_data: row,
        metadata: { row_number: index + 1, errors: normalized.errors, warnings: normalized.warnings },
      }];
    });

    for (let index = 0; index < entries.length; index += 500) {
      const inserted = await supabase.from("platform_list_entries").insert(entries.slice(index, index + 500));
      if (inserted.error) throw inserted.error;
    }
    const refreshed = await supabase.rpc("refresh_platform_list_counts", { p_platform_list_id: platformListId });
    if (refreshed.error) throw refreshed.error;
    await supabase.from("platform_lists").update({
      import_report: {
        source_type: parsed.sourceType,
        imported_rows: parsed.rows.length,
        unique_rows: entries.length,
        valid_rows: valid,
        invalid_rows: invalid,
        parser_errors: parsed.parserErrors,
        columns: parsed.columns,
        worksheet: parsed.selectedWorksheet,
        records_path: parsed.recordsPath,
        malware_scan: { provider: scan.provider, sha256: scan.sha256 },
      },
    }).eq("id", platformListId);
    return redirectWith(request, "message", `Listan importerades: ${valid} tillgängliga, ${invalid} ogiltiga och ${parsed.rows.length - entries.length} dubletter`);
  } catch (error) {
    const reference = crypto.randomUUID();
    if (createdListId) {
      const cleanup = await createAdminClient().from("platform_lists").delete().eq("id", createdListId);
      if (cleanup.error) console.error("Platform list import cleanup failed", { reference, createdListId, error: cleanup.error });
    }
    console.error("Platform list import failed", { reference, error });
    return redirectWith(request, "error", `Listan kunde inte importeras. Referens: ${reference}`);
  }
}
