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

## 2026-08-08 remediation

| Kontroll | Resultat | Kommentar |
|---|---|---|
| `node scripts/remediation-regression-tests.mjs` | PASS | Nya konsistens/RBAC/idempotency/readiness invariants |
| `node scripts/verify-generated-schema.mjs` | PASS | Ingen ny public Supabase type-drift introducerad |
| `node scripts/contract-delivery-unit-tests.mjs` | PASS | Snapshot/PDF/reminder/Resend/email-template regressions |
| Changed TS/TSX `transpileModule` syntax check | PASS | 22 ändrade TS/TSX-filer |
| Stale-pattern checks | PASS | Pagination cap, product rollback och server-local expiry-mönster borta |
| `npm ci` | BLOCKED ENVIRONMENT | Intern npm-mirror: `pdf-lib@1.17.1` 404 |
| `npm run verify` | BLOCKED ENVIRONMENT | `types:verify` PASS, därefter stoppar `typecheck:edge` på `deno: not found`; inte rapporterad som PASS |
| Full SQL replay/PGlite | NOT RUN | PGlite kunde inte installeras från samma blockerade mirror |
| Supabase staging/db push | NOT RUN | Extern staging krävs |
| Live Rinkel/Resend/46elks | NOT RUN | Providercredentials och riktig runtime krävs |

## 2026-08-08 — hosted database lint follow-up

- User-provided hosted `npm run verify`: PASS after `202608080001`.
- User-provided migration list: Local=Remote through `202608080001`.
- User-provided hosted `db lint`: identified FAILURE-0027..0029 plus PostGIS-owned diagnostics.
- `scripts/remediation-regression-tests.mjs`: PASS after adding `202608080002` invariants.
- `scripts/verify.mjs`: PASS, recognizes 50 migrations.
- Full PGlite SQL replay for `202608080002`: NOT RUN in this sandbox because `@electric-sql/pglite` is absent.
- Hosted application of `202608080002`: NOT RUN yet.

## 2026-08-08 — platform auth remediation

| Kontroll | Resultat | Evidens |
|---|---|---|
| Platform context independent of tenant context | PASS | `remediation-regression-tests.mjs` asserts no `getAppContext`/`active_tenant_id` in `getPlatformContext` |
| Shared layout selects platform context for `/app/platform/*` | PASS | proxy path header + layout regression assertions |
| Platform telephony page/actions use platform context | PASS | regression assertions and source scan |
| Tenant switch works without pre-existing tenant context | PASS | regression assertion; DB RPC remains authorization boundary |
| Bootstrap no longer requires tenant onboarding / arbitrary page cap | PASS | regression assertions |
| Changed TS/TSX syntax | PASS | TypeScript `transpileModule` over all changed TS/TSX files |
| `node scripts/verify.mjs` | PASS | ran with temporary global-TypeScript symlink; 50 migrations/invariants verified |
| `node scripts/remediation-regression-tests.mjs` | PASS | local execution |
| `npm ci` | BLOCKED ENVIRONMENT | internal mirror 404 for `pdf-lib@1.17.1` |
| Full `npm run verify` after this auth patch | NOT RUN | dependencies/Deno unavailable in this sandbox |
| Live Supabase role/session proof | NOT RUN | Supabase MCP read denied permission |

## 2026-08-10 Rinkel live-flow closure

| Kontroll | Resultat | Kommentar |
|---|---|---|
| `node scripts/remediation-regression-tests.mjs` | PASS | Live webhook verification, atomic ingest, dial timestamp/readiness and single-tenant number invariants |
| `TERM=xterm node scripts/verify.mjs` | PASS | 51 migrationer och kanoniska Rinkel/Resend/tenant-invarianter |
| Rinkel contract/unit suite | PASS 11/11 | Dial 204 contract, no POST retry, directory normalization, webhook registration and payload parsing |
| Changed TS/TSX/MTS `transpileModule` | PASS | Rinkel client, actions, route, page, runtime type fallback and tests |
| New migration structural checks | PASS | One transaction, balanced dollar blocks, no invalid `pg_catalog` special-form qualification |
| Full `verify-sql.mjs` / PGlite replay | BLOCKED ENVIRONMENT | `@electric-sql/pglite` is unavailable in this artifact runtime; must run in normal workspace |
| Linked Supabase SQL/migration inspection via MCP | BLOCKED PERMISSION | Connector returns MCP -32600 permission denied |
| `npm run db:push` + `types:generate` + full `npm run verify` | NOT RUN | Required in linked user workspace before deploy |
| Real outbound `outgoingCall → callStart → callEnd` | NOT RUN | Required provider acceptance gate |
| Real inbound `incomingCall` | NOT RUN | Required provider acceptance gate; closes 4/4 |
| CDR + recording reconciliation on same live call | NOT RUN | Required provider acceptance gate |
