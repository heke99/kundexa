# Completed work

## 2026-07-30 central Rinkel-cutover

- Ersatte tenantägda Rinkel-credentials med en central plattformsintegration och en server-side miljönyckel.
- Lade centralt användar-/nummerinventarium, historiserade tenantallokeringar, nummergrants, säljar­mappningar, capabilities, webhookstatus, konfliktkö, event och jobb.
- Backfillar entydig legacydata, flaggar multi-tenantanspråk och nollställer/inaktiverar gamla Rinkel-credentials utan permanent fallback.
- Lade plattformsvy för test, synk, webhookar, allokering/flytt/återkallning, konflikter och nödstopp.
- Bytte dial, status, webhook, recording, transcription och workers till central väg och lade `rinkel-platform-worker`.
- Verifierade 38 migrationer samt realistisk tvåtenantisolering, atomisk reservation, idempotens och oföränderlig historik.

## 2026-07-30 Rinkel-telefoni

- Implementerade tenantägd Rinkel-anslutning, krypterad API-nyckel, katalogsynk och atomisk säljar-/enhets-/nummermappning.
- Ersatte den exekverbara 46elks/WebRTC-voicevägen med server-side Rinkel `/dial`; 46elks kvarstår endast för SMS.
- Återanvände kanoniska `calls`, listclaims, callbacks och efterarbete; lade till providerförsök, webhookhändelser, inspelningar, transkript, Insights och konfliktspår.
- Gjorde automatisk dialer beroende av friska webhookar både i UI och databas, med en aktiv säljare/enhet åt gången.
- Implementerade idempotenta webhookar, eventordning, okända `/dial`-utfall, reconciliation och faktisk retention av privata/providerägda ljudobjekt.
- Skärpte RLS och kolumnprivilegier för providerdata samt dead-letterade gamla voice-jobb utan provideranrop.
- Lade Rinkel-enhetstest, statiska regressioner och exekverade SQL-runtimeflöden.

## Verifierat 2026-07-30

- `npm run verify`: PASS under Node 24.14.0/npm 11.9.0.
- SQL-resultat: 37 migrationer, 157 publika tabeller, 270 publika funktioner och 292 RLS-policies.
- Rinkel-runtime: mappning, webhookhälsogrind, atomisk reservation, idempotent replay, providerfinalisering, samtidighetslås och upplåsning.

## 2026-07-25 hardening

- Reproducerade och rättade FK-felet vid teamuppdelning av plattformsallokerade listmedlemmar.
- Bevarade allokeringspostens `tenant_id` och lineage vid återkallning.
- Relänkade allokeringspost till faktiskt skapad teamlistmedlem före borttagning av källmedlem.
- Låste tenantparametrerade `SECURITY DEFINER`-katalogfunktioner till `service_role`.
- Skapade guarded authenticated wrappers och explicit tenantvaliderade servicewrappers för segmentrefresh och kampanjmaterialisering.
- Lade negativa tvåtenant- och privilege-regressionstest i SQL-verifieringen.
- Rättade discovery-API från ogiltigt `enrichment:write` till `directory:refresh`.
- Lade statisk regressionkontroll för scope-kontraktet.
- Etablerade `.agent-memory`, `AGENTS.md` och Cursor-regler.

## Verifierat

- `npm run verify`: PASS 2026-07-25.
- Inkluderar Edge/Deno check, statiska invarianter, importparserstest, 32 migrationer och runtime-RPC-flöden, TypeScript samt Next.js 16.2.10 produktionsbuild.
- SQL-resultat: 145 publika tabeller, 246 publika funktioner och 273 RLS-policies.
- Ren zip-leverans skapad och integritetstestad utan `node_modules`, `.next` eller `.env.local`.

## 2026-07-30 Rinkel-statuskorrigering

- Rättade dialerns statusendpoint så att säljare kan läsa säker, tenantbegränsad integrationsstatus utan att få credentials eller bred tabellåtkomst.
- Lade explicit felhantering för databas-/migrationsfel i stället för att visa dem som ”Rinkel är inte anslutet”.
- Rättade klientstatusen så att endast `configured === false` visas som en verkligt saknad Rinkel-anslutning.

## 2026-08-02 Rinkel lifecycle/CDR-härdning

- Separat kanonisk `provider_status`, `provider_outcome` och CRM-disposition.
- Okända välformaterade Rinkel-cause-värden bevaras rått och mappas defensivt till `unknown`.
- Inkommande kund-/kontaktmatchning sker enbart inom tenant som äger mottagande nummer och endast vid entydig träff.
- `callEnd` skapar idempotent inspelningsreferens och köar CDR/enrichment.
- `rinkel-platform-worker` hämtar och applicerar CDR; flera kandidater blir konflikt, aldrig gissning.
- Framåtriktad migration: `202608020001_rinkel_lifecycle_reconciliation_hardening.sql`.
- Statisk verifiering och kontraktsenhetstest: PASS. Rinkel fallback-enhetstest: PASS 8/8.

## 2026-08-07 — Konsistensgenomgång och verifierad byggkedja

- `202608070001_import_execution_key_atomicity.sql`: `process_import_run` sätter själv
  `execution_idempotency_key` (FAILURE-0012).
- `202608070002_rate_limit_counter_retention.sql`: `prune_rate_limit_counters` + index,
  anropad från maintenance-workern (FAILURE-0013).
- `202608070003_recency_listing_indexes.sql`: `updated_at desc`-index för kunder, avtal och
  kampanjkandidater (FAILURE-0014).
- `src/lib/postgrest-filter.ts` + `npm run test:api`: sanering av söktermer (FAILURE-0016).
- `src/lib/supabase/proxy.ts`: `private, no-store` och `Vary` på autentiserade ytor.
- `src/hooks/use-call-realtime.ts` och `src/components/app-shell/realtime-refresh.tsx`:
  begränsad polling och refresh (FAILURE-0015).
- `scripts/verify-sql.mjs`: rate limit-täckning, driftkontroll av genererade typer, och två
  fixturer som testade fel kodväg.
- `npm run verify` PASS i sin helhet för första gången.


## 2026-08-08 — cross-surface consistency remediation

- Stängde platform-support service-role read bypass med capability-check och RLS-baserade reads.
- Ersatte Auth-listningens 20k-tak med paginerad lookup/direkt lookup för relevanta IDs.
- Gjorde Rinkel runtime key till explicit readiness-invariant före dial reservation.
- Gjorde customer API-idempotency concurrency-safe med atomisk reservation.
- Gjorde product + initial price transaktionellt fail-closed.
- Gjorde compliance-block projection och befintlig-data-backfill canonical/atomisk.
- Flyttade Resend delivery projections till den befintliga atomiska RPC-signaturen och reparerade replay.
- Synkade contract expiry timezone och seller identity mellan email/SMS/API.
- Lade database readiness endpoint.
- Lade 46elks SMS submit-reconciliation och lokal message-id-korrelation för delivery callback.
- Lade dedikerade remediation-regressionstester i standard `npm test`-kedjan.

## 2026-08-08 — DB lint runtime hardening

- Added forward-only `202608080002_database_lint_runtime_hardening.sql`.
- Fixed hosted pgcrypto resolution for affected SECURITY DEFINER functions.
- Fixed freshness enum typing in `fail_enrichment_job`.
- Fixed bigint/uuid mismatch in `apply_import_row_normalization`.
- Added regression assertions for all three invariants.

## 2026-08-08 — platform control-plane auth remediation

- Decoupled platform owner/admin/auditor/support identity from tenant workspace state.
- Routed `/app/platform/*` through an independent platform shell before tenant context resolution.
- Fixed `/app/platform/telephony` and platform Rinkel actions to use the canonical platform context.
- Made tenant switching reachable from a platform-only shell while preserving RPC authorization.
- Added a non-sensitive restricted landing for support to avoid redirect loops.
- Corrected bootstrap guidance and removed its arbitrary Auth-user pagination ceiling.
- Expanded regression and general verification gates to lock the architecture in place.

## 2026-08-10 — Rinkel device mapping remediation

- Added provider user-detail hydration for device discovery and compatibility parsing for common casing variants.
- Made incomplete Rinkel device inventory non-destructive so a summary response cannot erase known devices.
- Added central sync metadata and platform/tenant diagnostics for device completeness and provider detail failures.
- Blocked platform allocation of a Rinkel user with no synchronized active device.
- Added deterministic repair/auto-selection when exactly one active device exists; ambiguous multi-device users remain explicit.
- Added SQL/runtime regression coverage for device-less allocation rejection and tenant projection diagnostics.
