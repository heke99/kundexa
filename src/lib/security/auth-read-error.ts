/** An unavailable identity service is not proof that a session has expired. */
export function isTemporaryAuthReadError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { name, status } = error as { name?: unknown; status?: unknown };
  return name === "AuthRetryableFetchError" || status === 0 || (typeof status === "number" && status >= 500);
}
