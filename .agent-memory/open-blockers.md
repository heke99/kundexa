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

## 2026-08-10 — Rinkel device live gate

- Apply `202608100001_rinkel_device_inventory_mapping_hardening.sql` to the linked project and regenerate
  generated types before final delivery verification.
- Run the central Rinkel directory sync against the real account and confirm at least one active
  `platform_rinkel_devices` row exists for the provider user intended for the seller.
- If Rinkel's real `GET /users/:id` response for this account still exposes no usable device id, the code now
  fails closed with an explicit device-inventory diagnostic; provider/account capability must then be resolved
  with Rinkel rather than fabricating a device id.
- Full `npm run verify` and PGlite SQL replay remain NOT RUN in this sandbox because the internal npm mirror
  does not provide the required project dependencies. Rinkel runtime contract tests and static verifier are PASS.

## 2026-08-14 — externa åtgärder efter driftreconciliation

Se `docs/PRODUCTION_READINESS.md` för fullständig formulering och verifieringssteg.

- `kundexa.se` svarar `308 → https://www.kundexa.se/`. Primär domän måste bytas i Vercels
  domäninställningar; MCP-integrationen exponerar inga domän- eller env-verktyg.
- `NEXT_PUBLIC_APP_URL`, `APP_URL` och `RINKEL_WEBHOOK_PUBLIC_BASE_URL` går inte att läsa
  härifrån. Om något av dem fortfarande är `https://app.kundexa.se` pekar varje utskickad
  signeringslänk på en domän som inte finns i DNS. Måste sättas till `https://kundexa.se`.
- Live dial/CDR/recording mot Rinkel och skarpt Resend-utskick kräver testnummer respektive
  testmottagare och är fortsatt `NOT RUN`.
- Rinkel-kontot har ingen device: leverantörens payload för `hekmat.h@gridex.se` har
  `"deviceId": null`, `platform_rinkel_devices` är tom och `platform_rinkel_capabilities` visar
  `dial=false`, `dial_endpoint_reachable=false`, `webhooks=false` trots `api_access=true`.
  `POST /dial` kräver `deviceId`, så dialern kan inte ringa förrän en device är provisionerad och
  abonnemanget bekräftat täcka dial och webhooks. Koden failar korrekt stängt.
- De fem webhookarna är registrerade mot `https://kundexa.se/...`, men alla fem har
  `last_error_code='RINKEL_INVALID_REQUEST'` och `test_received_at=null`. Eftersom apex i dag
  308-redirectar till `www` möter varje leverans en redirect innan den når appen.
