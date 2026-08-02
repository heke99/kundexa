# Current state

Datum: 2026-08-02

## Kodstatus

- 40 ordnade migrationer; senaste är `202608020001_rinkel_lifecycle_reconciliation_hardening.sql`.
- Rinkel är fortsatt exakt en central plattformsintegration med en server-side API-nyckel och centralt ägda/allokerade resurser.
- Dial skickas exakt en gång. Timeout/osäkert utfall går till `unknown` och CDR/webhook-reparation, inte automatisk omringning.
- Rinkels tekniska status och utfall är separerade från CRM-disposition.
- Okända providerorsaker bevaras rått och avvisar inte hela webhooken.
- Inkommande kundmatchning är tenantlokal och endast entydiga träffar kopplas automatiskt.
- `callEnd` skapar recordingreferens och köar CDR/enrichment.
- CDR-worker utför verklig idempotent reparation och skapar konflikt vid flera kandidater.
- Genererade Supabase-typer är medvetet föråldrade tills den nya migrationen körts på staging och `types:generate` har körts.

## Lokal verifiering

- `node scripts/verify.mjs`: PASS.
- `node scripts/contract-delivery-unit-tests.mjs`: PASS.
- Rinkel fallback-unit: PASS 8/8.
- Ändrade TS/TSX-filer: transpileringssyntax PASS.
- `npm run types:verify`: FAIL EXPECTED — saknar den nya staginggenererade kolumnen/RPC:n.
- Full `npm ci`, Deno, SQL-runtime, typecheck, test, build och komplett verify: NOT RUN/PASS saknas på grund av sandboxens dependency-/runtimebegränsningar.

## Externa gates

- Ingen identifierbar Kundexa Supabase staging är ansluten i tillgänglig Supabase-miljö.
- Riktig Rinkel API-nyckel, device, nummer, webhookar, dial, CDR, recording, transcript och Insights är NOT RUN.
- Tvåtenant-RLS/Storage med riktiga JWT-sessioner är NOT RUN.
