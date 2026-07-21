export type JsonPathToken = string | number | "*";

const SEGMENT_PATTERN = /^[A-Za-z0-9_\-åäöÅÄÖ]+$/u;

export function parseJsonPath(path: string): JsonPathToken[] {
  const trimmed = path.trim();
  if (!trimmed || trimmed === "$" || trimmed === "[*]" || trimmed === "$[*]") return [];
  const normalized = trimmed.replace(/^\$\.?/, "");
  const tokens: JsonPathToken[] = [];
  for (const segment of normalized.split(".")) {
    if (!segment) throw new Error("json_path_empty_segment");
    const match = /^([^\[]+)?((?:\[(?:\d+|\*)\])*)$/.exec(segment);
    if (!match) throw new Error("json_path_invalid_segment");
    if (match[1]) {
      if (!SEGMENT_PATTERN.test(match[1])) throw new Error("json_path_unsafe_segment");
      tokens.push(match[1]);
    }
    for (const bracket of match[2].matchAll(/\[(\d+|\*)\]/g)) {
      tokens.push(bracket[1] === "*" ? "*" : Number(bracket[1]));
    }
  }
  return tokens;
}

function resolveTokens(value: unknown, tokens: JsonPathToken[], index: number): unknown[] {
  if (index >= tokens.length) return [value];
  const token = tokens[index];
  if (token === "*") {
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry) => resolveTokens(entry, tokens, index + 1));
  }
  if (typeof token === "number") {
    if (!Array.isArray(value) || token >= value.length) return [];
    return resolveTokens(value[token], tokens, index + 1);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  if (!(token in record)) return [];
  return resolveTokens(record[token], tokens, index + 1);
}

export function resolveJsonPath(value: unknown, path: string): unknown[] {
  const tokens = parseJsonPath(path);
  if (!tokens.length) return [value];
  return resolveTokens(value, tokens, 0);
}

export function resolveFirstJsonPath(value: unknown, path: string): unknown {
  return resolveJsonPath(value, path)[0];
}

export function resolveRecordsPath(value: unknown, path?: string | null): unknown[] {
  if (!path?.trim()) {
    if (Array.isArray(value)) return value;
    throw new Error("json_records_path_required");
  }
  const matches = resolveJsonPath(value, path);
  const rows = matches.flatMap((match) => Array.isArray(match) ? match : [match]);
  if (!rows.length) throw new Error("json_records_path_not_found");
  return rows;
}
