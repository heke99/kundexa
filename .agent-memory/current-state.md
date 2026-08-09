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

## 2026-08-08 — Cross-surface consistency remediation

En forward-only remediation har lagts ovanpå 2026-08-07-baselinen i
`202608080001_cross_surface_consistency_remediation.sql`.

- Plattformens lässidor använder nu användarsession + RLS. `platform_support` får inte längre
  indirekt service-role-läsning av tenant/list/audit-data som rollen saknar RLS-rätt till.
- Auth-användarsökning paginerar utan den tidigare hårda 20 000-användargränsen.
- Rinkel runtime readiness kontrollerar den faktiska servernyckeln före call reservation och
  exponeras konsekvent i status-API, OpenAPI och dialer-hook.
- Customer API-idempotens reserverar ett stabilt customer-id atomiskt under request key.
- Produkt och första prisversion skapas i samma databastransaktion via private trigger.
- Compliance-block är canonical write och projiceras atomiskt till kund; befintliga aktiva
  block backfillas av migrationen.
- Resend delivery-event, suppression, contract/reminder-projektion och webhook-status ligger
  i samma RPC-transaktion; webhook replay kan återuppta icke-terminal tidigare leverans.
- Kontraktsutgång tolkas i tenantens tidszon och email/SMS använder samma seller snapshot.
- SMS-submit har provider-reconciliation och callbacken bär Kundexas lokala message-id så ett
  provider-success/local-failure-fönster kan repareras utan blind dubbelsändning.
- `/api/ready` skiljer database readiness från ren `/api/health` liveness.

Lokal `npm run verify` startades: `types:verify` passerade men kedjan stoppades därefter på
`typecheck:edge` eftersom Deno saknas. En ren `npm ci` stoppas dessutom av den interna npm-spegeln
(`pdf-lib@1.17.1` 404). Detta ersätter inte
2026-08-07-baselinens tidigare gröna fullverifiering; de nya ändringarna verifieras med de
fristående kontroller som listas i `verification-matrix.md`.

## 2026-08-08 — hosted DB lint follow-up

User-provided hosted Supabase verification after `202608080001` is now green for generated types,
Edge/Deno checks, all test suites, 50-migration static verification and Next.js production build.
Remote migration history is synchronized through `202608080001`.

Hosted `supabase db lint --linked --level error` exposed three application-owned runtime issues that
local replay did not catch: pgcrypto functions were outside SECURITY DEFINER search paths,
`fail_enrichment_job` produced text for `directory_freshness_state`, and
`apply_import_row_normalization` declared bigint `import_rows.id` as uuid.

Forward-only migration `202608080002_database_lint_runtime_hardening.sql` fixes those without changing
public RPC signatures. Remaining lint findings in `st_findextent`, `populate_geometry_columns`,
`postgis_full_version`, `lockrow` and `addauth` are PostGIS-owned extension functions and are not patched
by Kundexa.

## 2026-08-08 — tenant-independent platform control-plane

- `platform_owner`/`platform_admin`/`platform_auditor`/`platform_support` authenticate through `platform_memberships` independently of `profiles.active_tenant_id`.
- `/app/platform/*` is detected in the shared layout from an internal path header overwritten by the proxy; those routes no longer enter tenant `getAppContext()` first.
- Tenant pages still require an active tenant membership. A platform principal that lacks a usable tenant is redirected to `/app/platform`, not onboarding.
- `/app/platform/telephony` and all platform Rinkel server actions use `getPlatformContext()`; tenant Rinkel settings continue to use `getAppContext()`.
- A platform-only user can choose an existing tenant from the platform shell because `switchTenant` authenticates the user and lets the database RPC validate membership instead of requiring a pre-existing tenant context.
- `platform_support` gets a safe restricted platform landing rather than a redirect loop; support/auditor still cannot perform Rinkel platform writes.
- Bootstrap documentation no longer claims tenant onboarding is required for platform access, and its Auth-user pagination no longer has an arbitrary 100k cap.
