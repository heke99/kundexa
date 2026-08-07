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
