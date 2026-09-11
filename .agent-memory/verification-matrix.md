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

## 2026-08-10 — Rinkel device mapping remediation

| Kontroll | Resultat | Evidens |
|---|---|---|
| `node scripts/remediation-regression-tests.mjs` | PASS | Device hydration, non-destructive sync, allocation gate and UI mapping invariants |
| `node scripts/verify.mjs` | PASS | Static verification recognizes 51 migrations; run with temporary global TypeScript link only for verifier execution |
| Rinkel runtime/unit harness | PASS 15/15 | Includes `/users/:id` hydration, incomplete-inventory preservation, authoritative empty inventory and existing dial/webhook contracts |
| Historical migration immutability | PASS | Only forward-only `202608100001_rinkel_device_inventory_mapping_hardening.sql` added |
| Full `npm ci` | BLOCKED ENVIRONMENT | Internal mirror lacks `pdf-lib@1.17.1` |
| Full `npm run verify` | NOT RUN | Project dependency set unavailable in sandbox; do not report as PASS |
| PGlite SQL runtime replay | NOT RUN | Internal mirror lacks `@electric-sql/pglite` |
| Linked Supabase migration/query | NOT RUN | Connector permission denied; must run from user's linked CLI/environment |
| Real Rinkel device inventory + dial | NOT RUN | Requires provider account and real device allocation |

## 2026-09-07 — Rinkel device resolution and one-click number assignment

| Check | Result | Notes |
| --- | --- | --- |
| `npm ci` | PASS | 150 packages; no mirror blocker in this environment |
| `npm run verify` (full chain) | PASS | types:verify, typecheck, typecheck:edge, all test suites, openapi:verify and production build |
| PGlite SQL replay | PASS | 69 migrations, 180 tables, 337 functions, 309 RLS policies; zero anon-executable definer functions |
| New Rinkel runtime path | PASS | Scalar device resolution, seller/organisation/team scope, idempotent re-assignment, `PROVIDER_DEVICE_MISSING` blocker and platform authorization negative test |
| `deno test scripts/rinkel-unit-tests.mts` | PASS 15/15 | Device staleness now keyed on a successful detail fetch |
| Rinkel API contract | VERIFIED | `POST /dial` requires `deviceId`/`to`/`numberId`; `GET /users/:id` exposes `deviceId` as nullable; no devices endpoint exists (developers.rinkel.com OpenAPI payloads) |
| Applied to linked Supabase project | PASS | `202609070001` applied to `lhvifuxcqghtbiulzkrf`; all nine affected functions have identical `md5(pg_get_functiondef())` in production and in the PGlite replay |
| Generated types regenerated from live | PASS | `assign_platform_rinkel_number`, `rinkel_effective_provider_device`, `rinkel_link_seller_to_provider_user` present; zero column drift |
| Production dry run of assignment | PASS (rolled back) | Real Gridex data: `linked_seller_count=1`, `unresolved_seller_count=0`, `telephony_activated_tenant_count=1`, `provider_device_missing_count=1` |
| Real outbound Rinkel call | BLOCKED EXTERNALLY | Provider reports no device for the account; requires a Rinkel webphone/app sign-in first |

## 2026-09-10 — flödesgenomgång

| Kontroll | Status | Bevis |
|---|---|---|
| `npm run verify` (typecheck, edge, test, types, openapi, build) | PASS | kört efter varje fix |
| Avtalskedja utkast -> utskick -> acceptans -> bevis -> aktivering | PASS | runtime mot PGlite |
| Manuell uppringning: reservation v2 -> finalize -> efterarbete | PASS | runtime mot PGlite |
| Listdialer: claim -> reservation med listkontext -> efterarbete | PASS | runtime mot PGlite |
| Filimport -> `process_import_run` -> mållista och kontaktpersoner | PASS | runtime mot PGlite |
| Workerlivstecken vid `degraded` | PASS | nytt test, bevisat falla utan fixen |
| Uppringningslåset släpps efter gräns, utfallet hittas inte på | PASS | nytt test, bevisat falla utan fixen |
| ParseHub-commit bunden till körningens tenant | PASS | nytt test, bevisat falla utan fixen |
| Parserns mime-typer mot bucketens allowlist | PASS | nytt test i `test:imports` |
| RPC-signaturer mot migrerat schema | PASS | 179 anropsställen, noll avvikelser |
| Kolumnreferenser i otypade edge functions | PASS | efter FAILURE-0044 |
| Statuslitteraler mot enum/check-villkor | PASS | noll avvikelser |
| Jobbtyper producerade mot workerhanterare | PASS | inga föräldralösa jobb |
| Service-role-anrop mot tenantfiltrering och plattformsgrind | PASS | manuellt granskade träffar |
| Live Supabase, Rinkel, Resend och 46elks | NOT RUN | ingen ansluten miljö |

## 2026-09-10 — dialer- och avtalsflöde, tillägg

| Kontroll | Status | Bevis |
|---|---|---|
| Efterarbete på obesvarat, telefonsvarare och providervägran | PASS | nytt test, bevisat falla utan fixen (`call_not_finished`) |
| Automatisk dialer: obesvarat registreras, nästa prospekt hämtas | PASS | nytt runtimetest |
| Automatisk dialer stannar vid svar | PASS | nytt runtimetest |
| Obesvarat prospekt schemaläggs för nytt försök i framtiden | PASS | nytt runtimetest |
| Avtalsutgång: länk går ut, påminnelser avbryts | PASS | nytt runtimetest |
| Utgånget avtal kan skickas igen som ny generation | PASS | nytt test, bevisat falla utan fixen |
| Utgångssvepet rör inte ett avtal med levande länk | PASS | nytt runtimetest |
| SMS-signering: kod krävs, fel/saknad kod nekas, koden lagras aldrig | PASS | nytt runtimetest |

## 2026-09-11 — deployverifiering av hela Edge Function-ytan

Repot beskriver vad som *borde* köra. Den här omgången jämför i stället den
**körande** koden mot repot, för varenda funktion — det är den kontroll som
saknades när FAILURE-0055 kunde ligga overksam i 34 dagar.

| Funktion | Version | Status | Bevis |
|---|---|---|---|
| `process-outbox` | 5 | PASS | 3/4 filer byte-identiska; `index.ts` skiljer sig bara i att fyra radbrytningar i en mallsträng står som `\n`. Bevisat i körning att båda formerna ger samma sträng. |
| `rinkel-platform-worker` | 3 | PASS | båda filerna byte-identiska |
| `automation-runner` | 4 | PASS | byte-identisk |
| `compliance-worker` | 3 | PASS | båda filerna byte-identiska |
| `data-worker` | 3 | PASS | alla tre filerna byte-identiska |
| `ingestion-worker` | 3 | PASS | alla tre filerna byte-identiska |
| `maintenance-worker` | 5 | PASS | byte-identisk |
| `parsehub-worker` | 3 | PASS | båda filerna byte-identiska |

| Driftkontroll | Status | Bevis |
|---|---|---|
| `process-outbox` körd efter omdeploy | PASS | två anrop, båda HTTP 200 |
| Outboxkön töms i skarp drift | PASS | `rinkel.retention` köad 00:00, klar 00:01, `attempts = 1`, inget fel |
| Alla sju workers har livstecken | PASS | `platform_worker_heartbeats`, ingen med `last_error_code` |
| Aktiva pg_cron-jobb | PASS | 0 (FAILURE-0056 kvarstår avstängd) |
| Fastnade jobb i någon kö | PASS | 0 väntande, 0 låsta |

**Ett observandum, inte ett fel:** ett `rinkel.reconcile_call`-jobb ligger i
`dead_letter` sedan 2026-08-18 med `Rinkel API-nyckeln nekades.` efter tio
försök. Det är från innan plattformsnyckeln var konfigurerad, och det är
dead-letter-mekaniken som gör sitt jobb — inte ett fel i dagens system.

## 2026-09-11 — go-live-kontroll mot produktionens faktiska data

| Kontroll | Status | Bevis |
|---|---|---|
| Säljarens organisationsnummer valideras på skrivvägen | PASS | nytt runtimetest, bevisat falla utan fixen (`accepted (5594616-7149): saved`) |
| Varje stavning av samma nummer normaliseras till en form | PASS | `556123-4567`, `5561234567`, `SE556123456701`, `165561234567` → ett värde |
| Enskild firma och utländskt bolag nekas inte | PASS | nytt runtimetest |
| Redan ogiltig rad förblir skrivbar och går att rätta | PASS | nytt runtimetest |
| SQL-normaliseraren håller med TypeScript-normaliseraren | PASS | samma Luhn-utfall på fyra nummer |
| Avtal kan skapas utan produkt | PASS | `productId` är valfri i `createContract`; priset anges manuellt |
| Utkastmallens platshållare är alla giltiga | PASS | alla tolv validerar mot `templateContextFields` |
| Säkerhetsrådgivare utan PostGIS-artefakter | PASS | endast `auth_leaked_password_protection` kvarstår |

**Tre fynd i produktionens data som bara ägaren kan rätta:** båda
organisationsnumren är ogiltiga, båda avsändarbolagen saknar adress/postnummer/ort,
och `outbound_email` är av för Gridex trots att `contract_delivery_email` är på.

**Rättelse av ett tidigare påstående:** jag skrev att `outgoingCall` och
`callStart` verifieras med "en knapptryckning". Det är fel.
`record_platform_rinkel_webhook_processed` sätter `verified` först när en
verklig leverans kommer in — `callEnd` och `incomingCall` blev verifierade
2026-08-18 av riktiga samtal. De två återstående verifierar sig själva vid det
första skarpa utringda samtalet. Provider-testet för `callStart` föll dessutom på
`RINKEL_INVALID_REQUEST`, vilket är noterat men inte åtgärdat: jag kan inte
anropa Rinkels API härifrån och vill inte ändra en fungerande registrering på en
gissning.
