import { readFile } from "node:fs/promises";
import path from "node:path";

const file = path.join(process.cwd(), "src/lib/supabase/database.types.ts");
const source = await readFile(file, "utf8");

const requiredTables = [
  "dial_attempts",
  "email_delivery_events",
  "signing_envelopes",
  "signing_recipients",
  "signing_attempts",
  "signing_events",
  "signing_documents",
  "contract_post_sign_runs",
];
const requiredFunctions = [
  "ingest_sinch_voice_event",
  "reserve_outbound_call",
  "finalize_dial",
  "resolve_caller_id_phone_number",
  "caller_id_options_for_current_user",
  "release_stale_dial_attempts",
  "apply_resend_delivery_event",
  "finalize_signing_envelope",
  "mark_acceptance_opened",
];
const requiredColumns = [
  "provider_state_updated_at",
  "provider_outcome",
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

console.log("Generated Supabase types include the current production-hardening schema contract.");
