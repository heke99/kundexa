# Verification matrix

| Område | Kontroll | Status 2026-08-07 |
|---|---|---|
| Dependencyinstallation | `npm ci` | PASS (150 paket, Node 22.22.2/npm 10.9.7) |
| Statiska invarianter | `node scripts/verify.mjs` | PASS |
| Kontraktsenhetstest | `node scripts/contract-delivery-unit-tests.mjs` | PASS |
| Rinkel-enhetstest | `npm run test:rinkel` (deno) | PASS 10/10 |
| Importkärna | `npm run test:imports` | PASS |
| API-kärna | `npm run test:api` (ny) | PASS |
| SQL-migrationer/RPC | `node scripts/verify-sql.mjs` | PASS, 48 migrationer, 179 tabeller, 306 funktioner, 304 policies |
| Genererat schema (namnlista) | `npm run types:verify` | PASS |
| Genererat schema (faktisk drift) | driftkontroll i `verify-sql.mjs` (ny) | PASS, 179 tabeller, noll kolumndrift |
| Web TypeScript | `npm run typecheck` | PASS |
| Edge Functions | `npm run typecheck:edge` | PASS (11 filer) |
| Produktionsbuild | `npm run build` | PASS |
| Komplett gate | `npm run verify` | PASS |
| Live Supabase staging + `types:generate` | separat staging | NOT RUN |
| RLS/Storage riktiga JWT | två tenants | NOT RUN |
| Rinkel dial + fem webhookar | riktig staging | NOT RUN |
| CDR/recording/transcript/Insights | riktig staging | NOT RUN |
| Juridik/DPIA/retention, backup/restore, last, extern pentest | — | NOT RUN |

`NOT RUN` får endast ersättas efter att det verkliga steget har körts.

Not: hela den lokala kedjan kördes denna gång eftersom `npm ci` fungerade. PGlite kör
migrationerna på riktigt, så SQL-runtime är verklig körning, inte statisk analys. Allt som
kräver en riktig Supabase-staging eller riktig Rinkel-provider är fortfarande `NOT RUN`.
