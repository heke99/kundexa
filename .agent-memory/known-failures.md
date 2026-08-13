# Known failures

## FAILURE-0001 — Composite FK nollade tenant_id

- Upptäckt: `split_customer_list_to_team` misslyckades med SQLSTATE 23502 när källmedlem raderades.
- Orsak: sammansatt FK använde generell `ON DELETE SET NULL`, vilket försökte nolla obligatorisk `tenant_id`.
- Fix: `202607250001_platform_allocation_reference_hardening.sql` använder kolumnspecifik SET NULL och relänkar allokeringsspår före delete.
- Regressionstest: teamfördelning och återkallning i `scripts/verify-sql.mjs`.
- Status: `RESOLVED`.

## FAILURE-0002 — Tenantparametrerade katalog-RPC:er var körbara av authenticated

- Risk: direkt anrop till `SECURITY DEFINER` kunde substituera annan tenants ID eller resurser.
- Fix: `202607250002_directory_tenant_boundary_hardening.sql` gör explicita tenantprojektioner service-only och skapar guarded wrappers.
- Regressionstest: privilege checks och negativa tvåtenanttest för segment/kampanj.
- Status: `RESOLVED`.

## FAILURE-0003 — Ogiltigt API-scope för discovery

- Orsak: routen krävde `enrichment:write`, som saknas i den kanoniska scope-modellen.
- Fix: routen kräver `directory:refresh`; statisk regressionkontroll tillagd.
- Status: `RESOLVED`.

## FAILURE-0004 — Leveransmiljön avviker från runtime

- Miljö: Node 24.14.0/npm 11.9.0; projektet kräver Node 22.x/npm 10.9.2.
- Effekt: engine-varning. Komplett verifiering kan köras men måste upprepas i kanonisk runtime.
- Status: `OPEN ENVIRONMENT LIMITATION`.

## FAILURE-0005 — Rinkel-reservation saknade obligatorisk callbackhash

- Upptäckt: exekverat SQL-runtimeprov mot hela migrationskedjan.
- Orsak: kanoniska `calls.callback_token_hash` är obligatorisk men fylldes inte av den nya reservationen.
- Fix: deterministisk hash av idempotency-nyckeln lagras vid samma atomiska reservation.
- Regressionstest: Rinkel-flödet i `scripts/verify-sql.mjs`.
- Status: `RESOLVED`.

## FAILURE-0006 — Providerartefakter hade tenantbred läsning

- Upptäckt: slutlig RLS-/privilegegranskning.
- Risk: generiska tenantpolicies var bredare än kanonisk samtals-, team- och användaråtkomst; rå providerdata kunde följa tabellprivilegiet.
- Fix: precisa roll-/team-/samtalspolicies, borttagen klientskrivning av samtalsförsök samt kolumnspecifika grants utan `raw_provider_data`.
- Regressionstest: SQL-exekvering och statiska invarianter i `scripts/verify.mjs`.
- Status: `RESOLVED`.

## FAILURE-0007 — Säljare såg felaktigt ”Rinkel är inte anslutet”

- Upptäckt: granskning av dialerns statusflöde 2026-07-30.
- Orsak: statusendpointen läste `tenant_integrations` med användarens Supabase-session, medan tabellens SELECT-policy endast tillåter tenantadmin. Ett RLS-tomt resultat behandlades som `not_configured`.
- Fix: endpointen använder nu service role efter verifierad auth/tenant och alla frågor är explicit tenant- och anslutningsfiltrerade. UI skiljer dessutom ett serverfel från en verkligt saknad anslutning.
- Status: `RESOLVED IN CODE`; live Supabase/Rinkel-verifiering återstår.

## FAILURE-0008 — Nya Rinkel-cause-värden stoppade callEnd

- Risk: strikt enumvalidering kunde avvisa framtida providerorsaker och förhindra terminal projektion.
- Fix: begränsat men öppet providerformat, rå cause bevaras och okända värden mappas till `provider_outcome=unknown`.
- Regression: `scripts/rinkel-unit-tests.mts` och `scripts/verify-sql.mjs`.
- Status: `RESOLVED IN CODE`; SQL-runtime mot staging återstår.

## FAILURE-0009 — Inkommande samtal saknade tenantlokal kundmatchning

- Risk: samtalet skapades utan säker kund-/kontaktkoppling.
- Fix: matchning efter tenant från aktiv nummerallokering; endast exakt en kund/kontakt kopplas automatiskt.
- Regression: tvåtenant- och dublettfall i `scripts/verify-sql.mjs`.
- Status: `RESOLVED IN CODE`; SQL-runtime mot staging återstår.

## FAILURE-0010 — callEnd skapade ingen kanonisk recordingrad

- Risk: UI kunde visa providerstatus men saknade åtkomstkontrollerad recordingreferens.
- Fix: idempotent upsert av en aktiv recordingrad per tenant/call/provider med retentionpolicy.
- Regression: `scripts/verify-sql.mjs`.
- Status: `RESOLVED IN CODE`; riktig Rinkel-recording återstår.

## FAILURE-0011 — Reconciliation markerade bara avvikelse

- Risk: fastnade samtal reparerades inte från Rinkels slutliga CDR.
- Fix: workerhämtning, strikt kandidatmatchning, konfliktkö och atomisk `reconcile_rinkel_call_from_cdr`.
- Regression: statiska invarianter och SQL-runtimefall.
- Status: `RESOLVED IN CODE`; provider/staging-verifiering återstår.

## FAILURE-0012 — `process_import_run` bröt mot sin egen hardening-trigger

- Risk: `202608010001` kräver `execution_idempotency_key` när en import går till `processing`,
  men RPC:n satte aldrig nyckeln. Varje anropare som inte förbokade en nyckel utanför RPC:n
  avbröt med `execution_idempotency_key_required`. Serveraktionen förbokar; ParseHubs
  automatiska commit (`process_parsehub_import_run`) gör det inte, så automatisk import var
  helt trasig i produktion.
- Fix: `202608070001` sätter nyckeln inne i RPC:n, i samma transaktion som statusbytet,
  härledd från `validation_fingerprint` med `run:<id>` som fallback. Invarianten gäller nu
  för alla anropare i stället för att bero på att varje anropare minns att förboka.
- Regression: `scripts/verify-sql.mjs` (fixturen anropar RPC:n utan förbokad nyckel, precis
  som ParseHub-vägen gör).
- Status: `RESOLVED IN CODE`; SQL-runtime PASS lokalt, staging återstår.

## FAILURE-0013 — `rate_limit_counters` städades aldrig

- Risk: `consume_rate_limit` skriver en rad per (tenant, bucket, 60s-fönster) vid *varje*
  autentiserad request och ingenting tog bort dem. Tabellen som grindar hela API:t växte
  obegränsat och drog med sig den upsert som varje request väntar på.
- Fix: `202608070002` lägger till `prune_rate_limit_counters` (begränsad radmängd,
  `for update skip locked`) plus index på `window_started_at`; maintenance-workern anropar den.
- Regression: `scripts/verify-sql.mjs` verifierar både gränsen (true/true/false vid limit 2)
  och att pruning tar bort exakt det gamla fönstret och behåller det levande.
- Status: `RESOLVED IN CODE`.

## FAILURE-0014 — Recency-listningar saknade index

- Risk: `/api/v1/customers`, listvyns kundväljare, avtalstavlan och compliancetavlan sorterar
  på `updated_at desc` medan samtliga täckande index låg på `created_at desc`. Postgres kunde
  inte använda något av dem för sorteringen, så varje sådan vy blev tenantscan + extern sort.
- Fix: `202608070003` lägger till `updated_at desc`-index som speglar varje frågas predikat.
- Status: `RESOLVED IN CODE`; verklig planmätning mot produktionsvolym `NOT RUN`.

## FAILURE-0015 — Klientens fallback-polling och workspace-refresh var obegränsade

- Risk: `useCallRealtime` pollade var 2,5 s även när realtime-kanalen var frisk, dvs 24 av
  sessionens 120 requests/minut per öppen dialer. `RealtimeRefresh` körde full
  `router.refresh()` 350 ms efter *varje* ändring på `calls`, `activities`,
  `customer_list_members`, `customer_lists` och `sales_orders`, för varje användare på varje
  sida — vid aktiv uppringning en kontinuerlig omrenderingsstorm.
- Fix: polling backar till 30 s när kanalen är `subscribed` och stramas till 2,5 s först vid
  degradering; refresh fick ett golv på 3 s mellan körningar, pausas helt i dolda flikar och
  körs en gång när fliken blir synlig igen.
- Status: `RESOLVED IN CODE`; belastningsmätning mot verklig tenant `NOT RUN`.

## FAILURE-0016 — Sökterm interpolerades in i PostgREST-grammatik

- Risk: `/api/v1/customers?q=` byggde ett `or=(...)`-uttryck och tog bara bort `%` och `,`.
  PostgREST tolkar värdet som grammatik *efter* URL-avkodning, så `)` och `.` överlevde in i
  en position där de läses som grammatik. Tenantisolering hänger inte på detta (tenantfiltret
  är en egen parameter och RLS gäller under), men det är otillförlitlig indata i en frågesyntax.
- Fix: `src/lib/postgrest-filter.ts` saneras centralt (reserverade tecken + wildcards + längd)
  och returnerar `null` när ingenting sökbart återstår, i stället för ett matcha-allt-mönster.
- Regression: `npm run test:api`.
- Status: `RESOLVED IN CODE`.


## FAILURE-0017 — Rinkel status kunde vara redo utan runtime API key — FIXED 2026-08-08
Status härleddes från databaskatalogen men verifierade inte att den aktuella webbruntimen faktiskt
hade `RINKEL_API_KEY`. Call route blockerar nu före reservation och status/OpenAPI/UI använder samma invariant.

## FAILURE-0018 — platform_support kunde läsa för brett via service role — FIXED 2026-08-08
Plattformssidor accepterade support och läste tenant/list/audit-data med admin-client. Reads går nu via
session/RLS och capabilityn för administrationsläsning exkluderar support.

## FAILURE-0019 — Auth user lookup hade 20 000-user cap — FIXED 2026-08-08
Flera adminflöden listade högst 20 sidor x 1000. Gemensam paginerad helper saknar godtyckligt tak.

## FAILURE-0020 — Customer API idempotency var race-känslig — FIXED 2026-08-08
Två samtidiga POST kunde båda passera lookup före audit-insert. En unik reservation med stabilt customer UUID
är nu source of truth för varje tenant/request key och fingerprint skyddar payload-reuse.

## FAILURE-0021 — Product + initial price var inte atomiskt — FIXED 2026-08-08
Applikationen försökte kompensera med delete om prisinsert misslyckades. Initial price skapas nu av en private
trigger i samma INSERT-transaktion; fel rullar tillbaka hela produkten.

## FAILURE-0022 — Resend projection/replay hade crash-window — FIXED 2026-08-08
Webhookstatus och downstream contract/customer/reminder-projektion var separata commits och conflict-replay
kunde felaktigt returnera duplicate. Projektionen och processed-status ligger nu i samma RPC-transaktion och
icke-terminala webhookrader kan återupptas.

## FAILURE-0023 — Contract expiry/seller identity kunde drifta — FIXED 2026-08-08
`datetime-local` tolkades i serverns tidszon och SMS kunde använda dagens tenantnamn medan email använde
snapshot. Expiry använder tenant timezone och båda kanalerna använder samma immutable seller identity.

## FAILURE-0024 — Compliance-block och customer flags hade write-order gap — FIXED 2026-08-08
Canonical compliance block projiceras nu i samma DB-transaktion och migrationen backfillar aktiva äldre block.

## FAILURE-0025 — SMS provider success/local failure kunde leda till blind resend — FIXED 2026-08-08
`submitting` reconciliation söker först providerhistorik och delivery callback kan korrelera via lokalt message-id.

## FAILURE-0026 — Health var endast liveness — FIXED 2026-08-08
`/api/ready` verifierar databasåtkomst separat från den avsiktligt enkla `/api/health` liveness-endpointen.

## FAILURE-0027 — Hosted pgcrypto functions were outside SECURITY DEFINER search paths — FIXED 2026-08-08
Hosted Supabase exposes pgcrypto through the `extensions` schema while several SECURITY DEFINER functions
fixed their search path to `public`. `digest`/`gen_random_bytes` could therefore fail at runtime. Migration
`202608080002` adds `extensions` to the fixed search path for the affected functions without changing signatures.

## FAILURE-0028 — `fail_enrichment_job` freshness enum branch resolved as text — FIXED 2026-08-08
The INSERT into `entity_freshness.state` used an uncast CASE expression. Hosted plpgsql_check reports a
`directory_freshness_state`/text mismatch. Both branches are now explicitly cast to the enum.

## FAILURE-0029 — Import normalization declared bigint row IDs as UUID — FIXED 2026-08-08
`import_rows.id` is a bigint identity, but `apply_import_row_normalization` parsed incoming row IDs as uuid.
Hosted plpgsql_check identified the invalid `bigint = uuid` comparison. The parser now declares `id bigint`.

## FAILURE-0030 — Platform superadmin was blocked by tenant context — FIXED 2026-08-08

`getPlatformContext()` delegated to `getAppContext()`, `/app` layout always called `getAppContext()`, and `/app/platform/telephony` plus Rinkel platform actions called tenant context directly. A valid `platform_owner` could therefore be redirected to onboarding/login or denied whenever `active_tenant_id` was missing, invalid or suspended. Platform context is now independent and the layout resolves platform routes before tenant context.

## FAILURE-0031 — Tenant switching required a tenant before switching — FIXED 2026-08-08

`switchTenant` called `getAppContext()` before `switch_active_tenant`, so a platform-only principal with valid tenant memberships could not select one. The action now requires authentication only and delegates membership/lifecycle validation to the existing audited database RPC.

## FAILURE-0032 — Platform support could enter a redirect loop — FIXED 2026-08-08

Support has an active platform identity but intentionally lacks broad platform-data read capability. Redirecting support from `/app/platform` to `/app` could send a tenantless support user back into platform routing indefinitely. The root platform page now renders a restricted non-sensitive landing before any platform data query.

## FAILURE-0033 — Rinkel summary sync could remove valid devices — FIXED 2026-08-10

Directory sync treated the normalized `devices[]` from `GET /users` as a complete provider inventory. If the
catalog response omitted device information, `liveDeviceIds` became empty and previously synchronized device rows
were marked `removed`. Seller mapping then rendered `enhet saknas`. Sync now hydrates users from `GET /users/:id`
and only performs destructive stale-device reconciliation when device inventory is authoritative.

## FAILURE-0034 — Device-less Rinkel users could be allocated to tenants — FIXED 2026-08-10

`allocate_platform_rinkel_resource('user', ...)` previously allowed an active central Rinkel user with zero active
provider devices to be allocated to a tenant. That created an allocation that could never pass
`replace_rinkel_user_mapping_v3` or `/dial`. The forward-only replacement now raises
`RINKEL_USER_DEVICE_MISSING` unless a synchronized active device exists.

## FAILURE-0035 — Äldre SECURITY DEFINER-rutiner var körbara av anon — FIXED 2026-08-13
62 rutiner skapade före revoke-konventionen behöll Supabases standardgrants, så de kunde anropas
via `/rest/v1/rpc/...` utan inloggning. `202608130001` återkallar `public`/`anon` och tar bort alla
klientgrants från triggerrutiner. `verify-sql.mjs` failar nu om något återfaller.

## FAILURE-0036 — RLS utvärderade auth.uid() per rad — FIXED 2026-08-13
37 policies anropade `auth.uid()` direkt i USING/WITH CHECK. `202608130002` lindar anropen i en
skalär subquery så de blir InitPlan. Policynamn, permissiveness, kommando och rollista tas från
katalogen och återskapas oförändrade.

## FAILURE-0037 — Webhookregistrering accepterade en omdirigerande adress — FIXED 2026-08-13
Registreringen kontrollerade providerkatalogen men aldrig om Kundexas egen publika adress svarar
direkt. Produktionen registrerade `https://kundexa.se/...` som svarar 308, och inget event har
mottagits. Registreringen gör nu en förkontroll och vägrar 3xx/onåbara mål.
