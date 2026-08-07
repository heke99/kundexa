/**
 * PostgREST parses the value of an `or=(...)` parameter as its own filter grammar *after*
 * URL decoding, so reserved characters that survive into the value are read as grammar, not
 * as data. A caller-supplied search term containing `)` or `,` can therefore close the
 * filter group early and append conditions the endpoint never intended to expose.
 *
 * Tenant isolation does not depend on this — the tenant filter is a separate query
 * parameter and RLS is enforced underneath — but the term is still untrusted input feeding
 * a query grammar, so it is neutralised before it gets there.
 *
 * `%` and `_` are stripped as well: inside an `ilike` pattern they are wildcards, so leaving
 * them in lets a caller widen the match to the whole table instead of searching for them.
 */
const POSTGREST_RESERVED = /[(),.:*\\"'%_]/g;

export function sanitizeFilterTerm(term: string, maxLength = 120): string {
  return term.replace(POSTGREST_RESERVED, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

/**
 * Builds an `ilike`-anywhere `or` filter across `columns` for a single search term.
 * Returns `null` when the term holds nothing searchable once sanitised, so callers can
 * skip the filter rather than send a match-everything pattern.
 */
export function buildIlikeOrFilter(columns: readonly string[], term: string): string | null {
  const safe = sanitizeFilterTerm(term);
  if (!safe) return null;
  return columns.map((column) => `${column}.ilike.%${safe}%`).join(",");
}
