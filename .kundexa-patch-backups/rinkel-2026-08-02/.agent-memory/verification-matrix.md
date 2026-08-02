# Verification matrix

| Område | Kontroll | Status 2026-07-30 |
|---|---|---|
| Web TypeScript | `npm run typecheck` | PASS |
| Edge Functions | `npm run typecheck:edge` | PASS |
| Statiska invarianter | `node scripts/verify.mjs` | PASS |
| Rinkel-enhetstest | `npm run test:rinkel` | PASS, 8/8 |
| Kontrakt/import | `npm run test:contracts && npm run test:imports` | PASS |
| Migrationer/RPC | `node scripts/verify-sql.mjs` | PASS: 38/170/277/297 |
| Central Rinkel två tenants | SQL-runtime | PASS |
| Produktionsbuild | `npm run build` | PASS |
| Komplett lokal gate | `npm run verify` | PASS |
| Node 22/npm 10.9.2 | samma gate | NOT RUN |
| Live Supabase + genererade typer | staging | NOT RUN |
| RLS/Storage med riktiga JWT | staging, två tenants | NOT RUN |
| Rinkel dial + fem webhookar | live staging | NOT RUN |
| Recording/transcript/Insights | live staging | NOT RUN |
| Backup/load/SAST/DAST/pentest | externa gates | NOT RUN |

`NOT RUN` får endast ersättas efter att det verkliga steget har körts.
