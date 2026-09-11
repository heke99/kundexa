// The one declaration of what a contract template may refer to.
//
// A template is written once and rendered by two different paths — the seller's
// screen and the public API — so the set of placeholders has to mean the same
// thing in both. Without a shared declaration the two drift apart silently: a
// template that renders on screen fails over the API with
// `unresolved_template_variables`, and nobody finds out until a seller is on the
// phone with a customer.
//
// It also moves the moment of failure. Validating only the root (`customer.*`)
// accepts `{{customer.address}}` — a plausible guess for a field actually named
// `address_line1` — and the mistake surfaces weeks later, for every customer, in
// front of the seller rather than the person who wrote the template.

/**
 * Every placeholder a template may use, grouped by root. Only scalar fields
 * appear: `renderStrictTemplate` refuses to substitute an object, so advertising
 * a structured field like the seller's branding would hand the author a
 * placeholder that always fails.
 */
export const templateContextFields = {
  seller: [
    "id", "legal_name", "organization_number", "address_line1",
    "postal_code", "city", "country_code", "email", "phone_e164", "website",
  ],
  customer: [
    "id", "customer_type", "display_name", "first_name", "last_name", "company_name",
    "personal_identity_number", "organization_number", "email", "phone_e164",
    "address_line1", "postal_code", "city", "country_code",
  ],
  product: ["id", "name", "sku", "description"],
  price: [
    "currency", "setup_fee", "recurring_fee", "variable_fee",
    "binding_months", "notice_months", "payment_terms_days",
  ],
  contract: ["title", "sales_channel", "audience", "starts_on", "ends_on", "language", "special_terms"],
} as const satisfies Record<string, readonly string[]>;

/** Roots that are a value in themselves rather than a group of fields. */
export const templateScalarRoots = ["today"] as const;

export type TemplateContextRoot = keyof typeof templateContextFields;

export const templateContextRoots = Object.keys(templateContextFields) as TemplateContextRoot[];

/** Every valid placeholder, as it is written in a template. */
export function allTemplatePlaceholders(): string[] {
  return [
    ...templateContextRoots.flatMap((root) => templateContextFields[root].map((field) => `${root}.${field}`)),
    ...templateScalarRoots,
  ].sort();
}

export type TemplateVariableProblem = {
  name: string;
  reason: "unknown_root" | "unknown_field" | "root_is_not_a_value" | "too_deep";
  suggestion: string | null;
};

// Levenshtein over two short field names. A misremembered field name is the
// common case here, so naming the closest real field turns a rejection into an
// instruction.
function editDistance(left: string, right: string) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const next = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
      diagonal = previous[j];
      previous[j] = next;
    }
  }
  return previous[right.length];
}

function closestField(root: TemplateContextRoot, field: string): string | null {
  const candidates = templateContextFields[root] as readonly string[];
  const needle = field.toLowerCase();

  // The most common mistake is a shortened or lengthened name rather than a
  // misspelling — `address` for `address_line1`, `phone` for `phone_e164` — and
  // edit distance scores those as badly as unrelated words. A shared prefix is
  // the stronger signal, so it is checked first.
  const byPrefix = candidates
    .filter((candidate) => candidate.startsWith(needle) || needle.startsWith(candidate))
    .sort((left, right) => left.length - right.length);
  if (byPrefix.length) return `${root}.${byPrefix[0]}`;

  let best: { name: string; distance: number } | null = null;
  for (const candidate of candidates) {
    const distance = editDistance(needle, candidate);
    if (!best || distance < best.distance) best = { name: candidate, distance };
  }
  // Beyond roughly half the name being different it is a guess, not a typo, and
  // a confident wrong suggestion is worse than none.
  if (!best || best.distance > Math.max(2, Math.floor(needle.length / 2))) return null;
  return `${root}.${best.name}`;
}

/**
 * Check placeholders against the declaration. Returns one entry per problem,
 * each with the closest real field where there is a plausible one.
 */
export function validateTemplateVariables(names: readonly string[]): TemplateVariableProblem[] {
  const problems: TemplateVariableProblem[] = [];
  for (const name of names) {
    const segments = name.split(".");
    const [root, field] = segments;

    if ((templateScalarRoots as readonly string[]).includes(root)) {
      if (segments.length > 1) problems.push({ name, reason: "too_deep", suggestion: root });
      continue;
    }
    if (!templateContextRoots.includes(root as TemplateContextRoot)) {
      problems.push({ name, reason: "unknown_root", suggestion: null });
      continue;
    }
    const typedRoot = root as TemplateContextRoot;
    if (segments.length === 1) {
      problems.push({ name, reason: "root_is_not_a_value", suggestion: `${root}.${templateContextFields[typedRoot][0]}` });
      continue;
    }
    if (segments.length > 2) {
      problems.push({ name, reason: "too_deep", suggestion: closestField(typedRoot, segments.slice(1).join(".")) });
      continue;
    }
    if (!(templateContextFields[typedRoot] as readonly string[]).includes(field)) {
      problems.push({ name, reason: "unknown_field", suggestion: closestField(typedRoot, field) });
    }
  }
  return problems;
}

/** A Swedish sentence the template author can act on. */
export function describeTemplateVariableProblem(problem: TemplateVariableProblem) {
  const suffix = problem.suggestion ? ` Menade du {{${problem.suggestion}}}?` : "";
  switch (problem.reason) {
    case "unknown_root":
      return `{{${problem.name}}} finns inte. Tillåtna grupper är ${[...templateContextRoots, ...templateScalarRoots].join(", ")}.`;
    case "root_is_not_a_value":
      return `{{${problem.name}}} är en grupp, inte ett värde — välj ett fält ur den.${suffix}`;
    case "too_deep":
      return `{{${problem.name}}} går ett steg för djupt.${suffix}`;
    default:
      return `{{${problem.name}}} finns inte på ${problem.name.split(".")[0]}.${suffix}`;
  }
}

/**
 * Which declared placeholders a render context fails to supply. Used by the
 * tests to hold every context builder to the same declaration, so the seller's
 * screen and the API cannot drift apart again.
 */
export function missingContextFields(context: Record<string, unknown>): string[] {
  const missing: string[] = [];
  for (const root of templateContextRoots) {
    const group = context[root];
    if (!group || typeof group !== "object" || Array.isArray(group)) {
      missing.push(...templateContextFields[root].map((field) => `${root}.${field}`));
      continue;
    }
    for (const field of templateContextFields[root]) {
      if (!(field in (group as Record<string, unknown>))) missing.push(`${root}.${field}`);
    }
  }
  for (const root of templateScalarRoots) {
    if (!(root in context)) missing.push(root);
  }
  return missing;
}

type ProductInput = { id?: string | null; name?: string | null; sku?: string | null; description?: string | null } | null;
type PriceInput = {
  currency: string;
  setup_fee: number;
  recurring_fee: number;
  variable_fee: number;
  binding_months: number | null;
  notice_months: number | null;
  payment_terms_days: number | null;
};
type ContractInput = {
  title: string;
  sales_channel: string;
  audience: string;
  starts_on?: string | null;
  ends_on?: string | null;
  language: string;
  special_terms?: string | null;
};

/**
 * Build the render context both paths use.
 *
 * This exists so the shape cannot be written twice and drift.
 *
 * It deliberately invents nothing. It used to substitute Swedish wording for
 * absent values — "Ingen bindningstid", "Ej angivet", "Inga särskilda villkor" —
 * so that `renderStrictTemplate` would not refuse. That solved the right problem
 * the wrong way: it put words the author never wrote into a binding document,
 * and it did so invisibly, on exactly the fields where the wording carries legal
 * weight. A contract that says "Uppsägningstid: Ej angivet" says something
 * different from one that omits the line.
 *
 * The author decides instead, in the template text, with the optional marker:
 * `{{price.notice_months?}}` renders nothing and
 * `{{price.notice_months?Ingen uppsägningstid}}` renders their own words. An
 * unmarked field still refuses when it is empty, which is what makes the marker
 * mean something.
 */
export function buildTemplateRenderContext(input: {
  seller: Record<string, unknown>;
  customer: Record<string, unknown>;
  product: ProductInput;
  price: PriceInput;
  contract: ContractInput;
}): Record<string, unknown> {
  return {
    seller: input.seller,
    customer: input.customer,
    product: {
      id: input.product?.id ?? null,
      name: input.product?.name ?? null,
      sku: input.product?.sku ?? null,
      description: input.product?.description ?? null,
    },
    price: {
      currency: input.price.currency,
      setup_fee: input.price.setup_fee,
      recurring_fee: input.price.recurring_fee,
      variable_fee: input.price.variable_fee,
      binding_months: input.price.binding_months,
      notice_months: input.price.notice_months,
      payment_terms_days: input.price.payment_terms_days,
    },
    contract: {
      title: input.contract.title,
      sales_channel: input.contract.sales_channel,
      audience: input.contract.audience,
      starts_on: input.contract.starts_on || null,
      ends_on: input.contract.ends_on || null,
      language: input.contract.language,
      special_terms: input.contract.special_terms || null,
    },
    today: new Intl.DateTimeFormat("sv-SE", { dateStyle: "long", timeZone: "Europe/Stockholm" }).format(new Date()),
  };
}
