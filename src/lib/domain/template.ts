export type TemplateContext = Record<string, unknown>;

// A placeholder is either required or optional, and the template text itself says
// which. `{{customer.email}}` must have a value; `{{customer.email?}}` may be
// empty, and `{{customer.email?Ej angivet}}` puts that text in its place.
//
// One rule: a `?` makes the field optional, and whatever follows it is what shows
// instead. Everything else behaves as before.
//
// Optional had to be opt-in rather than the default. A contract is a binding
// document, and silently dropping a field the author meant to be there —
// "Organisationsnummer: " followed by nothing — is worse than refusing to render
// it. But forcing every field to be present was wrong too: a private individual
// has no organisation number, plenty of customers have no e-mail, and the author
// is the one who knows which of those matter in their agreement.
const PLACEHOLDER = /{{\s*([a-zA-Z0-9_.-]+)\s*(\?([^}]*))?}}/g;

export type TemplatePlaceholder = { name: string; optional: boolean; fallback: string };

/** Every placeholder occurrence in a template, in the order it appears. */
export function parseTemplatePlaceholders(template: string | null | undefined): TemplatePlaceholder[] {
  if (!template) return [];
  return [...template.matchAll(PLACEHOLDER)].map((match) => ({
    name: match[1],
    optional: match[2] !== undefined,
    fallback: (match[3] ?? "").trim(),
  }));
}

function readPath(context: TemplateContext, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    return (value as Record<string, unknown>)[key];
  }, context);
}

function stringifyTemplateValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  throw new Error("template_value_must_be_scalar");
}

export function renderStrictTemplate(template: string, context: TemplateContext): string {
  const unresolved = new Set<string>();
  const rendered = template.replace(PLACEHOLDER, (_match, path: string, marker: string | undefined, fallback: string | undefined) => {
    const value = readPath(context, path);
    const missing = value === undefined || value === null || value === "";
    if (!missing) return stringifyTemplateValue(value);
    // Optional: the author already decided what an empty value should look like.
    if (marker !== undefined) return (fallback ?? "").trim();
    unresolved.add(path);
    return "";
  });
  if (unresolved.size) throw new Error(`unresolved_template_variables:${[...unresolved].sort().join(",")}`);
  return rendered;
}

/**
 * The distinct field names a template refers to, whether or not they are optional.
 *
 * Validation cares about whether the field exists at all — `{{customer.adress?}}`
 * is just as misspelled as `{{customer.adress}}` — so the marker is stripped here
 * and the optionality is carried separately by `parseTemplatePlaceholders`.
 */
export function templateVariableNames(...templates: Array<string | null | undefined>): string[] {
  const names = new Set<string>();
  for (const template of templates) {
    for (const placeholder of parseTemplatePlaceholders(template)) names.add(placeholder.name);
  }
  return [...names].sort();
}

/** Which of a template's fields must have a value, for the schema stored on the version. */
export function requiredTemplateVariableNames(...templates: Array<string | null | undefined>): string[] {
  const optionalEverywhere = new Map<string, boolean>();
  for (const template of templates) {
    for (const placeholder of parseTemplatePlaceholders(template)) {
      // Mentioned required anywhere means required: one optional use does not
      // excuse a required one somewhere else in the same document.
      optionalEverywhere.set(placeholder.name, (optionalEverywhere.get(placeholder.name) ?? true) && placeholder.optional);
    }
  }
  return [...optionalEverywhere.entries()].filter(([, optional]) => !optional).map(([name]) => name).sort();
}
