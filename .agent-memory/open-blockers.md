# Open blockers

Uppdaterad 2026-08-07.

## Löst sedan förra passet

- Dependencyinstallation: `npm ci` fungerar i denna miljö. Det var blockeraren som hindrade
  hela verifieringskedjan, och den var orsaken till att fyra verkliga defekter (FAILURE-0012
  till FAILURE-0016) aldrig hade upptäckts.
- Deno, PGlite och full typkontroll är körbara. `npm run verify` är PASS.
- `types:verify` är PASS, och drift mot det faktiska schemat kontrolleras nu maskinellt.

## P0 release gates som kvarstår

- Applicera samtliga migrationer på separat Kundexa Supabase staging: `NOT RUN`.
- Generera och checka in `src/lib/supabase/database.types.ts` från staging: `NOT RUN`.
  (Typerna är i synk med migrationerna lokalt, men är inte genererade från en riktig instans.)
- Verifiera tvåtenant-RLS/Storage med riktiga JWT-sessioner: `NOT RUN`.
- Verifiera central Rinkel API-nyckel, katalogsynk, device, nummer, dial och fem
  webhookevents: `BLOCKED EXTERNALLY`.
- Verifiera CDR-reparation, recording, transcript och Insights mot verklig plan:
  `BLOCKED EXTERNALLY`.
- Juridik/DPIA/retention, backup/restore, belastningstest och extern penetrationstest:
  `NOT RUN`.

## Miljö

- Node 22.22.2 / npm 10.9.7. Ingen Supabase-staging är ansluten i denna miljö, så allt
  DB-arbete är verifierat mot PGlite.

## 2026-08-08 — efter consistency remediation

Följande är fortfarande externa releasegates, inte lokalt bekräftade kodfel:

- Applicera `202608080001_cross_surface_consistency_remediation.sql` mot separat Supabase staging
  och kör hela migration replay där.
- Kör `npm ci && npm run verify` i normal CI/staging. Den här sandboxens interna npm-mirror gav
  404 för `pdf-lib@1.17.1` och Deno saknas, så full gate är `NOT RUN` för denna patch.
- Bekräfta `RINKEL_API_KEY` i både webbruntime och relevanta worker-runtime environments och kör
  ett verkligt dial/webhook/CDR/recording-reconciliation-test.
- Kör tvåtenant negativa RLS-tester med riktiga JWT-sessioner efter de nya platform read policies.
- En konkret BankID/e-sign-provider är fortfarande inte registrerad; providerabstraktionen finns,
  men leverantör, credentials, callbackkontrakt och juridisk/assurance-konfiguration krävs innan
  BankID kan påstås vara live.

## 2026-08-08 — hosted DB lint gate

- Apply `202608080002_database_lint_runtime_hardening.sql` to the linked Supabase project.
- Regenerate types and rerun `npm run verify` after the migration.
- Rerun `supabase db lint --linked --level error`; application-owned errors should be gone.
- PostGIS-owned lint findings may remain because PostGIS is installed in `public`; do not edit extension-owned functions merely to silence plpgsql_check.

## 2026-08-08 — platform auth follow-up

- Deploy the tenant-independent platform auth patch and verify with a real `platform_owner` session that has no usable `active_tenant_id`: `/app/platform` and `/app/platform/telephony` must open.
- Verify negative paths with real sessions: tenant-only user -> no platform access; `platform_support` -> restricted landing/no Rinkel writes; `platform_auditor` -> read-only platform administration/no Rinkel writes.
- This sandbox could not run `npm ci` because its internal mirror returns 404 for `pdf-lib@1.17.1`; full `npm run verify` for this auth-only patch remains to be rerun in the normal project environment.
- Read-only Supabase MCP verification was attempted but the connector denied permission, so live platform membership state was not inspected here.

## 2026-08-10 — Remaining Rinkel release blockers after code remediation

The code-level Rinkel blockers found in this pass are resolved in the forward-only patch. The remaining blockers
are deployment/evidence gates, not reasons to expand the audit:

1. Apply `202608100001_rinkel_webhook_live_verification_and_ingest.sql` to the linked Supabase project.
2. Regenerate Supabase types from that linked schema and run the full project verifier on Node 22 + Deno.
3. Deploy the web commit and keep the Rinkel worker on the same repo revision/runtime secrets.
4. Complete one answered real outbound call and observe processed `outgoingCall`, `callStart`, `callEnd`.
5. Complete one real inbound call to the allocated number and observe processed `incomingCall`; required core state must be 4/4.
6. Confirm zero open allocation/correlation conflicts for the tested number, zero failed/dead-letter jobs, and successful CDR/recording reconciliation.
7. Only after those gates pass, enable automatic dial for the tenant/team under test.
