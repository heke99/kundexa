/** Resend distinguishes an in-flight request from incompatible key reuse. */
export function permanentResendFailure(status: number, errorName: unknown): boolean {
  return [400, 401, 403, 404, 422].includes(status)
    || (status === 409 && errorName !== "concurrent_idempotent_requests");
}
