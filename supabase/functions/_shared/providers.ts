// Kanoniska scraper-/provideradaptrar för tillåtna externa källor (Allabolag, Merinfo).
// Modulen är körbar både i Deno (Edge Functions) och Node (verifieringstester):
// den använder inga Deno-, Node- eller nätverks-API:er. All hämtning, kryptering,
// kvot- och checkpointhantering sker i respektive worker; adaptern ansvarar för
// URL-variabler, filtrering, parsning, validering, normalisering och källmetadata.

export type JsonObject = Record<string, unknown>;

export type ScrapeParseContract = {
  /** Regex som matchar varje resultatblock i källdokumentet (flaggor gis). */
  record_regex: string;
  /** Fält -> regex med fångstgrupp 1 eller namngiven grupp "value". */
  field_patterns: Record<string, string>;
};

export type ScraperFilterDefinition = {
  query?: string;
  organizationNumber?: string;
  companyName?: string;
  sniCode?: string;
  legalForm?: string;
  county?: string;
  municipality?: string;
  city?: string;
  postalCode?: string;
  employeeMin?: number;
  employeeMax?: number;
  revenueMin?: number;
  revenueMax?: number;
  onlyActive?: boolean;
  role?: string;
  personName?: string;
};

export type NormalizedScrapeRecord = {
  external_id: string;
  fields: JsonObject;
  confidence: Record<string, number>;
  source_url: string | null;
};

export type ScraperAdapterDefaults = {
  allowedDomains: string[];
  allowedPaths: string[];
  searchEndpointTemplate: string;
  detailEndpointTemplate: string;
  pageParameter: string;
  pageStart: number;
  pageSize: number;
  maxPagesPerRun: number;
  maxRecordsPerRun: number;
  scheduleIntervalSeconds: number;
  freshnessTtlDays: number;
  quotaUnits: number;
  quotaWindowSeconds: number;
  maxConcurrency: number;
  minimumDelayMs: number;
  timeoutMs: number;
  maxRetries: number;
};

export type ScraperAdapter = {
  key: "allabolag" | "merinfo";
  name: string;
  entityTypes: Array<"organization" | "person">;
  sourceClass: "permitted_scrape";
  /** Persondata hanteras mer restriktivt: kräver uttryckligt tillstånd per entitetstyp. */
  personDataRestricted: boolean;
  defaults: ScraperAdapterDefaults;
  fieldKeys: string[];
  listContract: ScrapeParseContract;
  detailContract: ScrapeParseContract;
  buildSearchVariables(filter: ScraperFilterDefinition): Record<string, string>;
  normalizeRecord(raw: JsonObject, entityType: "organization" | "person"): NormalizedScrapeRecord | null;
};

// ---------------------------------------------------------------------------
// Normalisering (delas av båda adaptrarna och av importflödet i tester).
// ---------------------------------------------------------------------------

const HTML_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  aring: "å", auml: "ä", ouml: "ö", Aring: "Å", Auml: "Ä", Ouml: "Ö", eacute: "é", Eacute: "É", uuml: "ü", Uuml: "Ü",
};

export function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-zA-Z]+);/g, (_m, name: string) => HTML_ENTITIES[name] ?? `&${name};`);
}

export function stripHtmlTags(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

/** Normaliserar svenska organisationsnummer till 10 siffror och validerar Luhn. */
export function normalizeOrganizationNumber(raw: unknown): string | null {
  if (raw == null) return null;
  let digits = String(raw).replace(/\D/g, "");
  if (digits.length === 12 && (digits.startsWith("16") || digits.startsWith("18") || digits.startsWith("19") || digits.startsWith("20"))) {
    digits = digits.slice(2);
  }
  if (digits.length !== 10) return null;
  if (!luhnValid(digits)) return null;
  return digits;
}

/** Normaliserar svenska telefonnummer till E.164; behåller redan giltiga internationella nummer. */
export function normalizeSwedishPhone(raw: unknown): string | null {
  if (raw == null) return null;
  let value = String(raw).trim().replace(/[\s\-().]/g, "");
  if (!value) return null;
  if (value.startsWith("00")) value = `+${value.slice(2)}`;
  if (value.startsWith("0")) value = `+46${value.slice(1)}`;
  if (!value.startsWith("+")) {
    if (/^46\d{7,12}$/.test(value)) value = `+${value}`;
    else return null;
  }
  if (value.startsWith("+460")) value = `+46${value.slice(4)}`;
  return /^\+[1-9]\d{7,14}$/.test(value) ? value : null;
}

/** Tolkar svenska heltal med tusentalsavgränsare, exempelvis "1 234" eller intervallets lägsta värde "10-19". */
export function parseSwedishInteger(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === "number") return Number.isInteger(raw) && raw >= 0 ? raw : null;
  const text = String(raw).replace(/[\u00a0\u202f\s]/g, "");
  const match = /^(\d+)/.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/** Tolkar svenska belopp, inklusive "tkr"/"mkr"-skalning och negativa parentesbelopp. */
export function parseSwedishAmount(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  let text = String(raw).toLowerCase().replace(/[\u00a0\u202f]/g, " ").trim();
  if (!text) return null;
  let negative = false;
  const parenMatch = /^\(([^)]*)\)(.*)$/.exec(text);
  if (parenMatch) { negative = true; text = `${parenMatch[1]} ${parenMatch[2]}`.trim(); }
  if (text.startsWith("-") || text.startsWith("−")) { negative = true; text = text.slice(1); }
  let scale = 1;
  if (/\bmkr\b|\bmsek\b/.test(text)) scale = 1_000_000;
  else if (/\btkr\b|\bksek\b/.test(text)) scale = 1_000;
  const cleaned = text.replace(/[^\d,.]/g, "").replace(/\./g, "").replace(",", ".");
  if (!cleaned) return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  return (negative ? -value : value) * scale;
}

export function normalizeSwedishPostalCode(raw: unknown): string | null {
  if (raw == null) return null;
  const digits = String(raw).replace(/\D/g, "");
  return digits.length === 5 ? digits : null;
}

export function normalizeWebsite(raw: unknown): string | null {
  if (raw == null) return null;
  let text = String(raw).trim();
  if (!text) return null;
  if (!/^https?:\/\//i.test(text)) text = `https://${text}`;
  try {
    const url = new URL(text);
    if (!/^https?:$/.test(url.protocol) || !url.hostname.includes(".")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function normalizeIsoDate(raw: unknown): string | null {
  if (raw == null) return null;
  const text = String(raw).trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (!match) return null;
  const timestamp = Date.parse(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
  return Number.isNaN(timestamp) ? null : `${match[1]}-${match[2]}-${match[3]}`;
}

function cleanText(raw: unknown): string | null {
  if (raw == null) return null;
  const text = stripHtmlTags(String(raw));
  return text || null;
}

// ---------------------------------------------------------------------------
// Generisk kontraktsbaserad parsning. Varje fält extraheras separat så att ett
// saknat fält inte fäller hela posten; strukturförändringar upptäcks nedströms
// via parser_versions/parser_observations när match rate sjunker.
// ---------------------------------------------------------------------------

export function parseWithContract(text: string, contract: ScrapeParseContract): JsonObject[] {
  let recordPattern: RegExp;
  try {
    recordPattern = new RegExp(contract.record_regex, "gis");
  } catch {
    throw new Error("scrape_record_regex_invalid");
  }
  const records: JsonObject[] = [];
  for (const match of text.matchAll(recordPattern)) {
    const block = match[0];
    const record: JsonObject = {};
    for (const [key, pattern] of Object.entries(contract.field_patterns)) {
      let fieldPattern: RegExp;
      try {
        fieldPattern = new RegExp(pattern, "is");
      } catch {
        throw new Error(`scrape_field_regex_invalid:${key}`);
      }
      const fieldMatch = fieldPattern.exec(block);
      if (fieldMatch) {
        const value = (fieldMatch.groups?.value ?? fieldMatch[1] ?? fieldMatch[0]).trim();
        if (value) record[key] = value;
      }
    }
    if (Object.keys(record).length) records.push(record);
  }
  return records;
}

export function mergeContract(base: ScrapeParseContract, overrides?: { record_regex?: string; regex_mapping?: Record<string, string> }): ScrapeParseContract {
  return {
    record_regex: overrides?.record_regex || base.record_regex,
    field_patterns: { ...base.field_patterns, ...(overrides?.regex_mapping ?? {}) },
  };
}

// ---------------------------------------------------------------------------
// Robots-tolkning. Workers hämtar robots.txt och adaptern avgör om en path är
// tillåten för User-Agent "*" eller den specifika agenten. Systemet försöker
// aldrig kringgå blockeringar: disallow innebär att jobbet avbryts.
// ---------------------------------------------------------------------------

export function isPathAllowedByRobots(robotsTxt: string, path: string, userAgent = "kundexabot"): boolean {
  const groups: Array<{ agents: string[]; disallow: string[]; allow: string[] }> = [];
  let current: { agents: string[]; disallow: string[]; allow: string[] } | null = null;
  let lastWasAgent = false;
  for (const rawLine of robotsTxt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const directive = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (directive === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], disallow: [], allow: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (current && (directive === "disallow" || directive === "allow")) {
      if (directive === "disallow") current.disallow.push(value);
      else current.allow.push(value);
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }
  const agent = userAgent.toLowerCase();
  const applicable = groups.filter((group) => group.agents.some((a) => a === "*" || agent.includes(a) || a.includes(agent)));
  const specific = applicable.filter((group) => group.agents.some((a) => a !== "*"));
  const selected = specific.length ? specific : applicable;
  if (!selected.length) return true;
  const matchLength = (rule: string): number => {
    if (!rule) return -1;
    const pattern = rule.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    const anchored = pattern.endsWith("\\$") ? `^${pattern.slice(0, -2)}$` : `^${pattern}`;
    return new RegExp(anchored).test(path) ? rule.length : -1;
  };
  let allowLength = -1;
  let disallowLength = -1;
  for (const group of selected) {
    for (const rule of group.allow) allowLength = Math.max(allowLength, matchLength(rule));
    for (const rule of group.disallow) disallowLength = Math.max(disallowLength, matchLength(rule));
  }
  if (disallowLength < 0) return true;
  return allowLength >= disallowLength;
}

// ---------------------------------------------------------------------------
// Filter -> URL-variabler. Samma filterdefinition används av frontend, API,
// jobbkö och scraper. Endast validerade nycklar exponeras som variabler.
// ---------------------------------------------------------------------------

const FILTER_TEXT_KEYS = [
  "query", "organizationNumber", "companyName", "sniCode", "legalForm", "county", "municipality", "city", "postalCode", "role", "personName",
] as const;
const FILTER_NUMBER_KEYS = ["employeeMin", "employeeMax", "revenueMin", "revenueMax"] as const;

export function validateScraperFilter(raw: unknown): ScraperFilterDefinition {
  if (raw == null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("scraper_filter_must_be_object");
  const input = raw as JsonObject;
  const filter: ScraperFilterDefinition = {};
  for (const key of FILTER_TEXT_KEYS) {
    const value = input[key];
    if (value == null || value === "") continue;
    const text = String(value).trim().slice(0, 200);
    if (text) filter[key] = text;
  }
  for (const key of FILTER_NUMBER_KEYS) {
    const value = input[key];
    if (value == null || value === "") continue;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`scraper_filter_invalid_number:${key}`);
    filter[key] = parsed;
  }
  if (filter.employeeMin != null && filter.employeeMax != null && filter.employeeMin > filter.employeeMax) throw new Error("scraper_filter_employee_range_invalid");
  if (filter.revenueMin != null && filter.revenueMax != null && filter.revenueMin > filter.revenueMax) throw new Error("scraper_filter_revenue_range_invalid");
  if (input.onlyActive != null) filter.onlyActive = input.onlyActive === true || input.onlyActive === "true";
  if (filter.organizationNumber) {
    const normalized = normalizeOrganizationNumber(filter.organizationNumber);
    if (!normalized) throw new Error("scraper_filter_invalid_organization_number");
    filter.organizationNumber = normalized;
  }
  return filter;
}

function baseSearchVariables(filter: ScraperFilterDefinition): Record<string, string> {
  const variables: Record<string, string> = {};
  const queryParts = [filter.query, filter.companyName, filter.personName, filter.organizationNumber].filter(Boolean) as string[];
  variables.query = queryParts.join(" ").trim();
  variables.organization_number = filter.organizationNumber ?? "";
  variables.county = filter.county ?? "";
  variables.municipality = filter.municipality ?? "";
  variables.city = filter.city ?? "";
  variables.postal_code = filter.postalCode ?? "";
  variables.sni_code = filter.sniCode ?? "";
  variables.legal_form = filter.legalForm ?? "";
  variables.employee_min = filter.employeeMin != null ? String(filter.employeeMin) : "";
  variables.employee_max = filter.employeeMax != null ? String(filter.employeeMax) : "";
  variables.revenue_min = filter.revenueMin != null ? String(filter.revenueMin) : "";
  variables.revenue_max = filter.revenueMax != null ? String(filter.revenueMax) : "";
  variables.only_active = filter.onlyActive ? "true" : "";
  variables.role = filter.role ?? "";
  return variables;
}

// ---------------------------------------------------------------------------
// Allabolag-adapter: företagsdata (organisationer). Kontraktet (regexmönster)
// är en konfigurerbar utgångspunkt: det exakta liveformatet fastställs som
// produktionsgrind och kan bytas via adapter_configuration utan koddeploy.
// ---------------------------------------------------------------------------

const ALLABOLAG_LIST_CONTRACT: ScrapeParseContract = {
  record_regex: '<article[^>]*class="[^"]*search-result[^"]*"[\\s\\S]*?</article>',
  field_patterns: {
    canonical_name: '<h2[^>]*class="[^"]*company-name[^"]*"[^>]*>\\s*<a[^>]*>(?<value>[\\s\\S]*?)</a>',
    organization_number: 'data-orgnr="(?<value>[\\d-]+)"',
    legal_form: '<span[^>]*class="[^"]*legal-form[^"]*"[^>]*>(?<value>[\\s\\S]*?)</span>',
    organization_status: '<span[^>]*class="[^"]*company-status[^"]*"[^>]*>(?<value>[\\s\\S]*?)</span>',
    address_line1: '<span[^>]*class="[^"]*street-address[^"]*"[^>]*>(?<value>[\\s\\S]*?)</span>',
    postal_code: '<span[^>]*class="[^"]*postal-code[^"]*"[^>]*>(?<value>[\\s\\S]*?)</span>',
    city: '<span[^>]*class="[^"]*locality[^"]*"[^>]*>(?<value>[\\s\\S]*?)</span>',
    municipality: '<span[^>]*class="[^"]*municipality[^"]*"[^>]*>(?<value>[\\s\\S]*?)</span>',
    county: '<span[^>]*class="[^"]*county[^"]*"[^>]*>(?<value>[\\s\\S]*?)</span>',
    sni_code: 'data-sni="(?<value>[\\d]+)"',
    industry: '<span[^>]*class="[^"]*industry[^"]*"[^>]*>(?<value>[\\s\\S]*?)</span>',
    employee_count: '<span[^>]*class="[^"]*employees[^"]*"[^>]*>(?<value>[\\s\\S]*?)</span>',
    revenue: '<span[^>]*class="[^"]*revenue[^"]*"[^>]*>(?<value>[\\s\\S]*?)</span>',
    result: '<span[^>]*class="[^"]*profit[^"]*"[^>]*>(?<value>[\\s\\S]*?)</span>',
    registration_date: 'data-registered="(?<value>[\\d-]+)"',
    phone: '<span[^>]*class="[^"]*phone[^"]*"[^>]*>(?<value>[\\s\\S]*?)</span>',
    website: '<a[^>]*class="[^"]*website[^"]*"[^>]*href="(?<value>[^"]+)"',
    source_url: '<a[^>]*class="[^"]*company-link[^"]*"[^>]*href="(?<value>[^"]+)"',
  },
};

const ALLABOLAG_DETAIL_CONTRACT: ScrapeParseContract = {
  record_regex: '<main[^>]*class="[^"]*company-profile[^"]*"[\\s\\S]*?</main>',
  field_patterns: ALLABOLAG_LIST_CONTRACT.field_patterns,
};

function normalizeAllabolagRecord(raw: JsonObject): NormalizedScrapeRecord | null {
  const organizationNumber = normalizeOrganizationNumber(raw.organization_number);
  if (!organizationNumber) return null;
  const fields: JsonObject = { organization_number: organizationNumber };
  const confidence: Record<string, number> = { organization_number: 1 };
  const assign = (key: string, value: unknown, conf: number) => {
    if (value == null || value === "") return;
    fields[key] = value;
    confidence[key] = conf;
  };
  assign("canonical_name", cleanText(raw.canonical_name), 0.9);
  assign("legal_form", cleanText(raw.legal_form), 0.8);
  assign("organization_status", cleanText(raw.organization_status), 0.8);
  assign("address_line1", cleanText(raw.address_line1), 0.8);
  assign("postal_code", normalizeSwedishPostalCode(raw.postal_code), 0.9);
  assign("city", cleanText(raw.city), 0.8);
  assign("municipality", cleanText(raw.municipality), 0.8);
  assign("county", cleanText(raw.county), 0.8);
  assign("sni_code", cleanText(raw.sni_code), 0.8);
  assign("industry", cleanText(raw.industry), 0.7);
  assign("employee_count", parseSwedishInteger(raw.employee_count), 0.7);
  assign("revenue", parseSwedishAmount(raw.revenue), 0.7);
  assign("result", parseSwedishAmount(raw.result), 0.7);
  assign("registration_date", normalizeIsoDate(raw.registration_date), 0.9);
  assign("phone_e164", normalizeSwedishPhone(raw.phone), 0.8);
  assign("website", normalizeWebsite(raw.website), 0.8);
  const sourceUrl = typeof raw.source_url === "string" && raw.source_url.trim() ? decodeHtmlEntities(raw.source_url.trim()) : null;
  return { external_id: organizationNumber, fields, confidence, source_url: sourceUrl };
}

// ---------------------------------------------------------------------------
// Merinfo-adapter: personer och företag. Persondata hanteras restriktivt:
// person-entiteter kräver uttryckligt tillstånd (provider_permissions +
// provider_field_permissions) och stabil källidentifierare krävs för dedup.
// ---------------------------------------------------------------------------

const MERINFO_LIST_CONTRACT: ScrapeParseContract = {
  record_regex: '<div[^>]*class="[^"]*result-card[^"]*"[\\s\\S]*?</div>\\s*</div>',
  field_patterns: {
    canonical_name: '<a[^>]*class="[^"]*result-name[^"]*"[^>]*>(?<value>[\\s\\S]*?)</a>',
    organization_number: 'data-orgnr="(?<value>[\\d-]+)"',
    external_id: 'data-mid="(?<value>[a-zA-Z0-9_-]+)"',
    address_line1: '<span[^>]*class="[^"]*result-street[^"]*"[^>]*>(?<value>[\\s\\S]*?)</span>',
    postal_code: '<span[^>]*class="[^"]*result-zip[^"]*"[^>]*>(?<value>[\\s\\S]*?)</span>',
    city: '<span[^>]*class="[^"]*result-city[^"]*"[^>]*>(?<value>[\\s\\S]*?)</span>',
    municipality: '<span[^>]*class="[^"]*result-municipality[^"]*"[^>]*>(?<value>[\\s\\S]*?)</span>',
    county: '<span[^>]*class="[^"]*result-county[^"]*"[^>]*>(?<value>[\\s\\S]*?)</span>',
    phone: '<a[^>]*class="[^"]*result-phone[^"]*"[^>]*>(?<value>[\\s\\S]*?)</a>',
    role_title: '<span[^>]*class="[^"]*result-role[^"]*"[^>]*>(?<value>[\\s\\S]*?)</span>',
    company_name: '<span[^>]*class="[^"]*result-company[^"]*"[^>]*>(?<value>[\\s\\S]*?)</span>',
    source_url: '<a[^>]*class="[^"]*result-name[^"]*"[^>]*href="(?<value>[^"]+)"',
  },
};

const MERINFO_DETAIL_CONTRACT: ScrapeParseContract = {
  record_regex: '<section[^>]*class="[^"]*profile-details[^"]*"[\\s\\S]*?</section>',
  field_patterns: MERINFO_LIST_CONTRACT.field_patterns,
};

function normalizeMerinfoRecord(raw: JsonObject, entityType: "organization" | "person"): NormalizedScrapeRecord | null {
  const organizationNumber = normalizeOrganizationNumber(raw.organization_number);
  const sourceId = typeof raw.external_id === "string" && raw.external_id.trim() ? raw.external_id.trim() : null;
  const externalId = entityType === "organization" ? (organizationNumber ?? sourceId) : sourceId;
  if (!externalId) return null;
  const fields: JsonObject = {};
  const confidence: Record<string, number> = {};
  const assign = (key: string, value: unknown, conf: number) => {
    if (value == null || value === "") return;
    fields[key] = value;
    confidence[key] = conf;
  };
  if (entityType === "organization" && organizationNumber) assign("organization_number", organizationNumber, 1);
  assign("canonical_name", cleanText(raw.canonical_name), 0.85);
  assign("address_line1", cleanText(raw.address_line1), 0.8);
  assign("postal_code", normalizeSwedishPostalCode(raw.postal_code), 0.9);
  assign("city", cleanText(raw.city), 0.8);
  assign("municipality", cleanText(raw.municipality), 0.8);
  assign("county", cleanText(raw.county), 0.8);
  assign("phone_e164", normalizeSwedishPhone(raw.phone), 0.8);
  if (entityType === "person") {
    assign("role_title", cleanText(raw.role_title), 0.7);
    assign("company_name", cleanText(raw.company_name), 0.7);
    if (organizationNumber) assign("company_organization_number", organizationNumber, 0.9);
  }
  if (!fields.canonical_name) return null;
  const sourceUrl = typeof raw.source_url === "string" && raw.source_url.trim() ? decodeHtmlEntities(raw.source_url.trim()) : null;
  return { external_id: externalId, fields, confidence, source_url: sourceUrl };
}

// ---------------------------------------------------------------------------
// Adapterregister.
// ---------------------------------------------------------------------------

export const SCRAPER_ADAPTERS: Record<string, ScraperAdapter> = {
  allabolag: {
    key: "allabolag",
    name: "Allabolag",
    entityTypes: ["organization"],
    sourceClass: "permitted_scrape",
    personDataRestricted: false,
    defaults: {
      allowedDomains: ["allabolag.se"],
      allowedPaths: [],
      searchEndpointTemplate: "https://www.allabolag.se/what/{{query}}?page={{page}}",
      detailEndpointTemplate: "https://www.allabolag.se/{{external_identifier}}",
      pageParameter: "page",
      pageStart: 1,
      pageSize: 20,
      maxPagesPerRun: 250,
      maxRecordsPerRun: 5000,
      scheduleIntervalSeconds: 432000,
      freshnessTtlDays: 20,
      quotaUnits: 5000,
      quotaWindowSeconds: 432000,
      maxConcurrency: 1,
      minimumDelayMs: 1500,
      timeoutMs: 30000,
      maxRetries: 5,
    },
    fieldKeys: [
      "canonical_name", "organization_number", "legal_form", "organization_status", "address_line1", "postal_code",
      "city", "municipality", "county", "sni_code", "industry", "employee_count", "revenue", "result",
      "registration_date", "phone_e164", "website",
    ],
    listContract: ALLABOLAG_LIST_CONTRACT,
    detailContract: ALLABOLAG_DETAIL_CONTRACT,
    buildSearchVariables: baseSearchVariables,
    normalizeRecord: (raw) => normalizeAllabolagRecord(raw),
  },
  merinfo: {
    key: "merinfo",
    name: "Merinfo",
    entityTypes: ["organization", "person"],
    sourceClass: "permitted_scrape",
    personDataRestricted: true,
    defaults: {
      allowedDomains: ["merinfo.se"],
      allowedPaths: [],
      searchEndpointTemplate: "https://www.merinfo.se/search?q={{query}}&page={{page}}",
      detailEndpointTemplate: "https://www.merinfo.se/{{external_identifier}}",
      pageParameter: "page",
      pageStart: 1,
      pageSize: 25,
      maxPagesPerRun: 200,
      maxRecordsPerRun: 5000,
      scheduleIntervalSeconds: 432000,
      freshnessTtlDays: 20,
      quotaUnits: 5000,
      quotaWindowSeconds: 432000,
      maxConcurrency: 1,
      minimumDelayMs: 2000,
      timeoutMs: 30000,
      maxRetries: 5,
    },
    fieldKeys: [
      "canonical_name", "organization_number", "address_line1", "postal_code", "city", "municipality", "county", "phone_e164",
    ],
    listContract: MERINFO_LIST_CONTRACT,
    detailContract: MERINFO_DETAIL_CONTRACT,
    buildSearchVariables: baseSearchVariables,
    normalizeRecord: (raw, entityType) => normalizeMerinfoRecord(raw, entityType),
  },
};

export function getScraperAdapter(adapterKey: string | null | undefined): ScraperAdapter | null {
  if (!adapterKey) return null;
  return SCRAPER_ADAPTERS[adapterKey] ?? null;
}

/** Identitetsmappning för adapterfält: adaptern returnerar redan kanoniska nycklar. */
export function identityFieldMapping(adapter: ScraperAdapter): Record<string, string> {
  return Object.fromEntries(adapter.fieldKeys.map((key) => [key, key]));
}
