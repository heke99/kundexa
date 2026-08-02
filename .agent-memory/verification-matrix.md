# Verification matrix

| Område | Kontroll | Status 2026-08-02 |
|---|---|---|
| Statiska invarianter | `node scripts/verify.mjs` | PASS |
| Kontraktsenhetstest | `node scripts/contract-delivery-unit-tests.mjs` | PASS |
| Rinkel-enhetstest | fallback via faktisk TS-källa | PASS 8/8 |
| Ändrade TS/TSX-filer | TypeScript `transpileModule` | PASS syntax |
| Genererat schema | `node scripts/verify-generated-schema.mjs` | FAIL EXPECTED: stagingtyper ej regenererade |
| Dependencyinstallation | `npm ci` | BLOCKED: registry/proxy |
| Web TypeScript | `npm run typecheck` | NOT RUN efter dependencyfel |
| Edge Functions | `npm run typecheck:edge` | NOT RUN: Deno/dependencies saknas |
| SQL-migrationer/RPC | `node scripts/verify-sql.mjs` | NOT RUN: PGlite saknas |
| Produktionsbuild | `npm run build` | NOT RUN efter dependencyfel |
| Komplett gate | `npm run verify` | NOT RUN/PASS saknas |
| Live Supabase + typer | separat staging | NOT RUN |
| RLS/Storage riktiga JWT | två tenants | NOT RUN |
| Rinkel dial + fem webhookar | riktig staging | NOT RUN |
| CDR/recording/transcript/Insights | riktig staging | NOT RUN |

`NOT RUN` och `FAIL EXPECTED` får endast ersättas efter att det verkliga steget har körts.
