import { readFile } from "node:fs/promises";
import path from "node:path";

const file = path.join(process.cwd(), "src/lib/supabase/database.types.ts");
const source = await readFile(file, "utf8");

const requiredTables = [
  "email_delivery_events",
  "signing_envelopes",
  "signing_recipients",
  "signing_attempts",
  "signing_events",
  "signing_documents",
  "contract_post_sign_runs",
];
const requiredFunctions = [
  "apply_rinkel_call_event",
  "correlate_rinkel_incoming_event",
  "correlate_rinkel_outgoing_event",
  "apply_resend_delivery_event",
  "finalize_signing_envelope",
  "mark_acceptance_opened",
];
const requiredColumns = [
  "provider_state_updated_at",
  "validation_fingerprint",
  "execution_idempotency_key",
  "source_row_count",
  "truncated",
  "provider_status_at",
  "signature_policy",
  "identity_assurance_level",
];

const missing = [];
for (const table of requiredTables) {
  if (!source.includes(`      ${table}: {`)) missing.push(`table:${table}`);
}
for (const fn of requiredFunctions) {
  if (!source.includes(`      ${fn}: {`)) missing.push(`function:${fn}`);
}
for (const column of requiredColumns) {
  if (!source.includes(`          ${column}:`)) missing.push(`column:${column}`);
}

if (missing.length) {
  console.error("Generated Supabase types are stale after the latest migrations.");
  console.error(`Missing: ${missing.join(", ")}`);
  console.error("Run npm run db:push and npm run types:generate against the linked staging project, then rerun npm run types:verify.");
  process.exit(1);
}

console.log("Generated Supabase types include the production-hardening schema contract.");
