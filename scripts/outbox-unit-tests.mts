import { permanentResendFailure } from "../supabase/functions/_shared/outbox-policy.ts";

Deno.test("Resend concurrent request retries, conflicting payload stops", () => {
  if (permanentResendFailure(409, "concurrent_idempotent_requests")) throw new Error("Concurrent request must retry unchanged");
  if (!permanentResendFailure(409, "invalid_idempotent_request")) throw new Error("A conflicting payload must stop");
  if (!permanentResendFailure(409, "unknown_conflict")) throw new Error("Unknown conflicts need investigation");
  for (const status of [429, 500, 502, 503]) {
    if (permanentResendFailure(status, "provider_error")) throw new Error(`Transient ${status} must retry`);
  }
  for (const status of [400, 401, 403, 404, 422]) {
    if (!permanentResendFailure(status, "validation_error")) throw new Error(`Permanent ${status} must stop`);
  }
});
