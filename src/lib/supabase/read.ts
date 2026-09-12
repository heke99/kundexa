import type { PostgrestError } from "@supabase/supabase-js";

/**
 * PostgREST does not throw. A failed read comes back as `{ data: null, error }`,
 * and every page in this app destructured only `data` — so a query that failed
 * rendered exactly like a query that found nothing: "Inga poster ännu". On a
 * tenant that is still being filled, that is the difference between "you have
 * not added customers yet" and "the customer list is broken", shown identically.
 *
 * `ok()` wraps a read so the failure reaches the error boundary instead of being
 * rendered as emptiness. It returns the result untouched — `count`, `status` and
 * a legitimately null `data` from `.maybeSingle()` all pass through — so it can
 * be dropped around an existing query without changing what the page reads.
 *
 * What it does NOT catch: a row-level security policy that hides rows returns an
 * empty result, not an error. `ok()` makes a broken query loud; it cannot make a
 * policy that quietly excludes rows visible. That needs the RLS tests.
 */
type ReadResult = { error?: PostgrestError | null };

export class SupabaseReadError extends Error {
  readonly code: string | null;
  constructor(error: PostgrestError) {
    // The message reaches the server log; React replaces it with a generic
    // sentence before it reaches the browser, so detail here is safe.
    super(`supabase_read_failed:${error.code ?? "unknown"}:${error.message}`);
    this.name = "SupabaseReadError";
    this.code = error.code ?? null;
  }
}

/**
 * PGRST116 is `.single()` saying "no row matched" — a legitimate answer, not a
 * failure, and the pages that use it already handle it with `notFound()`.
 * Throwing on it would turn "den här kunden finns inte" into "något gick fel",
 * which is a worse answer and a behaviour change rather than a fix.
 */
const NO_ROWS = "PGRST116";

export async function ok<T extends ReadResult>(query: PromiseLike<T>): Promise<T> {
  const result = await query;
  if (result.error && result.error.code !== NO_ROWS) throw new SupabaseReadError(result.error);
  return result;
}
