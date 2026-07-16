export type TemplateContext = Record<string, unknown>;

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
  const rendered = template.replace(/{{\s*([a-zA-Z0-9_.-]+)\s*}}/g, (_match, path: string) => {
    const value = readPath(context, path);
    if (value === undefined || value === null || value === "") unresolved.add(path);
    return stringifyTemplateValue(value);
  });
  if (unresolved.size) throw new Error(`unresolved_template_variables:${[...unresolved].sort().join(",")}`);
  return rendered;
}

export function templateVariableNames(...templates: Array<string | null | undefined>): string[] {
  const names = new Set<string>();
  for (const template of templates) {
    if (!template) continue;
    for (const match of template.matchAll(/{{\s*([a-zA-Z0-9_.-]+)\s*}}/g)) names.add(match[1]);
  }
  return [...names].sort();
}
