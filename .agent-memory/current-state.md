# Current state

Datum: 2026-08-07

## Kodstatus

- 43 ordnade migrationer i repot; PGlite kör 48 filer inklusive de tre nya från detta pass.
  Senaste är `202608070003_recency_listing_indexes.sql`.
- Rinkel är fortsatt exakt en central plattformsintegration med en server-side API-nyckel och
  centralt ägda/allokerade resurser.
- Dial skickas exakt en gång. Timeout/osäkert utfall går till `unknown` och CDR/webhook-
  reparation, inte automatisk omringning.
- Rinkels tekniska status och utfall är separerade från CRM-disposition.
- Inkommande kundmatchning är tenantlokal och endast entydiga träffar kopplas automatiskt.
- CDR-worker utför verklig idempotent reparation och skapar konflikt vid flera kandidater.
- `process_import_run` sätter numera själv `execution_idempotency_key`, så ParseHubs
  automatiska commit fungerar igen (FAILURE-0012).
- Genererade Supabase-typer är **i synk** med migrationerna: 179 tabeller, noll kolumndrift,
  numera maskinellt verifierat vid varje körning i stället för via en handunderhållen namnlista.

## Lokal verifiering

`npm run verify` går igenom i sin helhet. Se `verification-matrix.md` för raderna.

- `npm ci`: PASS. Den tidigare registry/proxy-blockeraren finns inte längre i denna miljö,
  vilket var det som gjorde att hela kedjan aldrig kunde köras.
- `npm run typecheck`, `typecheck:edge`, `test` (verify/rinkel/contracts/imports/api/sql),
  `types:verify` och `build`: PASS.
- SQL-runtime är verklig körning mot PGlite, inte statisk analys.

## Externa gates

Oförändrade sedan förra passet — inget av detta kan köras härifrån:

- Ingen identifierbar Kundexa Supabase staging är ansluten.
- Riktig Rinkel API-nyckel, device, nummer, webhookar, dial, CDR, recording, transcript och
  Insights är `NOT RUN`.
- Tvåtenant-RLS/Storage med riktiga JWT-sessioner är `NOT RUN`.
- Juridik/DPIA/retention, backup/restore, belastningstest och extern pentest är `NOT RUN`.

Viktigt: de tre nya migrationerna har körts mot PGlite, inte mot en riktig Supabase-staging.
`npm run db:push` och `npm run types:generate` mot staging återstår innan produktion.
