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

## 2026-08-10 — Rinkel device inventory and seller mapping hardening

- Central Rinkel user sync now treats `GET /users` as a catalog, then attempts the documented
  `GET /users/:id` detail endpoint before deciding whether a user's device inventory is complete.
- An incomplete provider user payload is non-destructive: existing active device rows are preserved
  instead of being marked `removed` merely because a summary payload omitted device data.
- Explicit provider device inventory remains authoritative. Unknown/missing device inventory is surfaced
  as a diagnostic state and Kundexa never invents a device id.
- A platform Rinkel user cannot be newly allocated to a tenant unless at least one synchronized active
  device exists for that provider user.
- Tenant integration mapping exposes active-device count and safe inventory diagnostics; a unique active
  device is selected automatically, while multiple devices still require an explicit choice.
- Directory sync repairs an existing seller mapping only when the allocated provider user has exactly one
  active device. Ambiguous multi-device users remain manual.

## 2026-08-14 — migrationsdrift mot live och kanonisk domän

Detta pass hade för första gången läsaccess till det riktiga Supabase-projektet
(`lhvifuxcqghtbiulzkrf`) och Vercel-projektet `kundexa`, så flera punkter som tidigare stod som
`NOT RUN` kunde faktiskt mätas.

- Live hade tre migrationer som saknades i repot: `202608130001_function_execute_least_privilege`,
  `202608130002_rls_auth_uid_initplan` och `20260813222943_secdef_service_only_and_bypass_hardening`.
  De två första låg dessutom i `supabase_migrations.schema_migrations` utan `statements`.
  Samtliga är nu backfillade med samma versionsnummer, så `db push` hoppar över dem i produktion.
- Den verkliga defekten bakom `202608130001`: Postgres ger EXECUTE till PUBLIC som default och
  `anon` ärver PUBLIC. 62 SECURITY DEFINER-funktioner som ingen migration uttryckligen återkallat
  var därmed anropbara oautentiserat via PostgREST med definierarens rättigheter, förbi RLS.
  Produktionen var redan lagad; repot var det inte.
- Efter backfill reproducerar repots PGlite-replay produktionens policydefinitioner exakt
  (md5 över alla 301 `public`-policyer identisk) med noll anon-körbara definer-funktioner.
- Båda invarianterna är nu byggrindar i `scripts/verify-sql.mjs`, inte engångsfixar. Gaten fångade
  direkt ett försök att bredda `service_role` till de avsiktligt nekade oskopade segment-/
  kampanj-RPC:erna.
- `app.kundexa.se` finns inte i DNS. Den är borttagen ur kod, env-mall och driftdokumentation;
  kanonisk domän är `kundexa.se`.
- `NEXT_PUBLIC_APP_URL` föll tyst tillbaka på `http://localhost:3000`. Kontrollen ligger nu i
  `canonicalAppBaseUrl()` på de fyra länkbyggarna, inte i env-schemat, så en felkonfiguration
  stoppar det utskick som annars fått en trasig länk i stället för all requesthantering.
- `GET /api/ready` rapporterar `appBaseUrl` och `appBaseUrlUsable` så värdet går att verifiera utifrån.

## 2026-09-07 — Rinkel: devicemodell och nummertilldelning i ett steg

Det gick inte att ringa ut. Tre orsaker, varav två var kodfel och en är extern.

1. **Devicemodellen var fel mot leverantören.** Rinkel har inget device-endpoint.
   `GET /users/:id` bär enheten som det nullbara skalära fältet `deviceId`, och `POST /dial`
   kräver `deviceId`, `to` och `numberId` (verifierat mot developers.rinkel.com). Kundexa
   modellerade device som ett eget inventarium och gjorde en synkad devicerad till hårt villkor
   för allokering, säljarmappning, dial och readiness. Ett konto med `deviceId: null` kunde
   därför inte ens tilldelas. Device är nu en **preferens**, inte ett krav:
   `rinkel_effective_provider_device()` löser device vid ringtillfället från explicit val →
   aktiv synkad device → `platform_rinkel_users.external_device_id`. En säljare som mappats
   innan enheten fanns blir ringklar automatiskt vid nästa katalogsynk, utan omtilldelning.
2. **Tilldelning var flerstegs och endast teambaserad.** `assign_platform_rinkel_number`
   ersätter det: ett anrop, scope `tenant`/`team`/`user`, som allokerar numret, skapar
   dial-granten på rätt nivå, sätter scopets standard-caller-ID, aktiverar telefoni och
   `outbound_calls`, allokerar Rinkel-användare och skapar säljarmappningar.
   `assign_platform_rinkel_number_to_teams` behåller sin signatur och delegerar dit.
3. **Externt och kvarstående:** Rinkel-kontot har fortfarande ingen registrerad device
   (`external_device_id is null`, `platform_rinkel_devices` tom). Utgående samtal kan inte gå
   förrän användaren loggat in i Rinkels webbtelefon/app och katalogen synkats om. Koden failar
   stängt med `PROVIDER_DEVICE_MISSING` som säger exakt det.

Sidoeffekter som också åtgärdats: `staleRinkelDeviceIds` avaktiverar nu devices utifrån ett
lyckat detaljanrop i stället för en `devices[]`-array som Rinkel aldrig skickar;
`external_device_id` följer leverantörens sanning inklusive borttagning; säljarmappningsformuläret
tillåter mappning utan device; dialer-, calls-API- och statusmeddelanden pekar på rätt åtgärd.

### Migrationsdrift mot live (andra gången)

Produktionen hade `20260814124751_rinkel_seller_number_assignment_without_device` som saknades i
repot. Den innehöll en tidigare, partiell version av samma diagnos (device-gate borttagen ur
`allocate_platform_rinkel_resource` och `replace_rinkel_user_mapping_v3`, med autoval vid exakt en
device och `DEVICE_SELECTION_REQUIRED` vid flera). Den är nu backfillad **verbatim** — repofilen
har samma md5 som `supabase_migrations.schema_migrations.statements[1]` — och den nya migrationen
`202609070001` är ombyggd så att den bygger *ovanpå* den i stället för att skriva över den.

Dessutom hade live `get_tenant_rinkel_resources` med `is_tenant_admin` medan repot hade
`is_tenant_member`. Livevarianten är strängare och behållen; repot är anpassat till den.

Efter applicering är alla nio berörda funktioner identiska i produktion och i PGlite-replayen
(md5 över `pg_get_functiondef` matchar för samtliga).

## 2026-09-07 — samtalsspärr: diagnos och två kodfel

En manuell uppringning nekades med "Numret får inte ringas enligt spärr- och samtyckesreglerna".
Den verkliga orsaken var `nix_check_required`: kunden är `customer_type='person'` och `lifecycle`
`prospect`, vilket ger syftet `direct_marketing`, och svensk NIX-kontroll krävs då innan samtal.
Tenanten har noll rader i `nix_provider_configurations`, så ingen kontroll kan utföras och varje
B2C-marknadsföringssamtal är blockerat. Det är korrekt regelefterlevnad, inte en bugg.

Två faktiska kodfel åtgärdades:

1. **FAILURE-0037** — legal-basis-grinden i `evaluate_contact_policy_for_tenant` föll aldrig ut för
   kunder helt utan `contact_permissions`-rad, på grund av trevärd logik. `202609070002`.
2. **Felmeddelandet var oanvändbart.** `/api/v1/calls` mappade allt policyavslag till en generisk
   text. Reservations-RPC:n reser `exact_call_policy_denied:<reason>`; routen tolkar nu den koden och
   svarar med vad som faktiskt stoppade samtalet och vad säljaren ska göra
   (`NIX_CHECK_REQUIRED`, `LEGAL_BASIS_REQUIRED`, `OUTSIDE_CONTACT_HOURS`, `COMPLIANCE_BLOCK` m.fl.).
   Kontrollen ligger först i `reservationFailure` så att den inte skuggas av en bredare substrängmatch.

Kundkortet kräver redan bara namn och typ vid skapande — organisationsnummer, personnummer, e-post och
ort är valfria och kan fyllas i efteråt. Det som faktiskt krävs för att *ringa* en privatperson är
rättslig grund plus giltig NIX-kontroll, vilket är juridik och inte ett formulärkrav.

## 2026-09-07 — kundkortet: två blockerande fel

- **FAILURE-0038**: `customers_scoped_select` anropade `can_access_customer(id)`, som läser tillbaka
  raden ur samma tabell. SELECT-policyer gäller för `INSERT ... RETURNING`, och en `STABLE`-funktion
  ser inte raden satsen håller på att skapa. Ingen kund kunde skapas från "Ny kund". Dialerns
  skapande fungerade eftersom det går via SECURITY DEFINER-RPC:n `create_or_match_manual_prospect`.
  Policyerna för `customers` och `contracts` utvärderar nu radens egna kolumner.
- **FAILURE-0039**: kundkortet saknade helt uppdateringsfunktion. `updateCustomerDetails` och ett
  formulär på kortet är tillagda, inklusive `legal_basis` som är det som låser upp B2C-samtal.

`.span-2` användes av compliance- och kundformulären men saknades i CSS; nu definierad.

## 2026-09-07 — NIX som säljarrapporterat undantag, och två blockerare till

Tenanten köper NIX-tvättade nummerkällor. Modellen som krävde en egen `nix_checks`-rad före varje
B2C-samtal gjorde varje sådant samtal omöjligt. `tenant_settings.compliance` styr nu:

- `nix_screening_mode`: `provider_check` (default, oförändrat) eller `pre_screened_source`.
- `default_marketing_legal_basis`: en rättslig grund som gäller kunder utan egen grund på kortet.

En **registrerad** notering som inte är `not_listed` spärrar samtalet i båda lägena; läget styr bara
om ett *okontrollerat* nummer får ringas. Säljarens `nix_listed`-utfall skriver `nix_checks`,
`customers.do_not_call` och en `compliance_blocks`-rad på numret, så spärren följer numret även till
ett kundkort som skapas senare. `apply_call_block_disposition` är den enda definitionen och delas av
manuell dialer och listdialer.

Två blockerare hittades genom att torrköra den riktiga reservations-RPC:n mot produktionsdata:

- **FAILURE-0040**: pgcrypto-search_path hade tyst reverterats; varje utgående samtal hade fallit på
  `digest(text, unknown) does not exist`. PGlite maskerade det via sin egen `public.digest`. Ny
  invariant i `verify-sql.mjs` kontrollerar `proconfig` direkt.
- **FAILURE-0041**: reservationens NIX-grind gällde även företag, till skillnad från contact policy.

Efter fixarna reserverar `rinkel_reserve_platform_outbound_call_v2` ett riktigt samtal mot Gridex
produktion (device `6a9e8624…`, nummer `6a6b1c70…`); verifieringen rullades tillbaka.

## 2026-09-10 — Genomgång av avtals-, samtals-, kundkorts- och importflödet

Hela kedjan kördes som runtime mot PGlite, inte lästes: `create_contract_draft_v3` ->
`prepare_contract_delivery_v2` -> `record_contract_acceptance_v3` -> bevispaket ->
`activate_completed_contract`, samt `rinkel_reserve_platform_outbound_call_v2` ->
`rinkel_finalize_platform_dial` -> `complete_manual_call_work_v2`/`complete_dialer_work_v2`
och `process_import_run` mot mållista. Kedjorna håller.

Sex defekter hittades och åtgärdades: FAILURE-0044 till FAILURE-0049. De två som
faktiskt bröt drift var telefoniworkerns livstecken (ett misslyckat jobb stängde av
auto-dialern plattformsbrett) och uppringningslåset utan utgång (ett samtal utan
providerutfall låste säljaren ute permanent).

Viktig lärdom om testtäckningen: `scripts/verify-sql.mjs` körde v1-funktionerna
(`rinkel_reserve_platform_outbound_call`, `complete_dialer_work`) medan applikationen
anropar v2, och avtalsflödet kontrollerades bara med regex i `verify.mjs`. Båda
defekterna låg i den glipan. Nya runtimetester täcker nu workerlivstecken, det
tidsbegränsade uppringningslåset och tenantbunden ParseHub-commit, och vart och ett
är bevisat falla utan sin fix.

Konsistenskontroller körda över hela repot, samtliga rena efter åtgärd:
RPC-namn och parameternamn mot migrerat schema (179 anropsställen), tabell- och
kolumnreferenser i otypade edge functions, statuslitteraler mot enum/check-villkor,
producerade jobbtyper mot workerhanterare, storage-buckets, feature keys och
service-role-användning mot tenantfiltrering.

Kvar som scope, inte defekt: det finns inget API-nyckelautentiserat endpoint för
listimport. Import via API sker genom ParseHub-webhooken.

## 2026-09-10 — död kod, referensintegritet och permanent flödestest

Borttaget: `.kundexa-patch-backups/` (tre incheckade ögonblicksbilder av gamla
källträd, 60 filer), `ui/button.tsx`, `webrtc-dialer.tsx`, `use-webrtc-voice.ts`,
`domain/feature-policy.ts`, `integrations/rinkel/normalizers.ts` och fyra oanvända
e-postmallar som process-outbox ändå bygger själv. `recording.download` blev en
gravsten i stil med `call.start` och dess 46elks-implementation togs bort — 46elks
röstwebhookar svarar redan 410. Det avstängda `if (false)`-blocket i verify-sql är
borta med en notering om varför.

Behållet med avsikt: `signing/provider.ts` och `signing/policy.ts` (verify.mjs
kontrollerar kontraktets fyra metoder — det är extensionspunkten för BankID),
`runtime-database.typecheck.ts` (kompileringstidskontrakt för RPC-argument som får
vara SQL NULL), samt 410-gravstenarna för 46elks röst.

`npm run test` kör nu hela säljarresan som runtime: grundande samtal, avtalsutkast,
låst utskick, publik webbacceptans bunden till exakt dokumenthash, bevisgrindad
aktivering — plus uppringning via v2-reservationen med finalisering och efterarbete.
Tidigare kontrollerades avtalsvägen bara med regex.

## 2026-09-10 — deploy till länkat produktionsprojekt (lhvifuxcqghtbiulzkrf)

Sex migrationer applicerade mot produktion via Supabase MCP, efter förkontroll av
att varje textankare fanns i den *live* funktionen och att noll rader korsade
tenantgränsen. Alla fixar verifierade live efteråt:

| Fix | Live |
|---|---|
| FAILURE-0045 workerlivstecken vid `degraded` | ja |
| FAILURE-0046 `rinkel_release_stale_call_attempts` | ja |
| FAILURE-0047 ParseHub tenantkontext | ja |
| FAILURE-0050 13 sammansatta tenant-FK | ja, noll enkolumnsnycklar kvar |
| FAILURE-0051 efterarbete på obesvarade samtal | ja |
| FAILURE-0053 omutskick av utgånget avtal | ja |

Efter deploy: 181 tabeller, 301 policies, 0 SECURITY DEFINER utan `search_path`,
0 dead-letter, 0 workers som aldrig lyckats. Radantal oförändrade.

Två saker upptäcktes under deployen:

1. **MCP-verktyget registrerar migrationer med tidsstämpelversion**, inte repots
   filnamnsversion. Det förklarar även varför `self_dial_guard` låg som
   `20260907160639`. Historiken är reparerad: repots sex versioner är införda i
   `supabase_migrations.schema_migrations`, så `db push` hittar inget att köra.
   De sex tidsstämpelraderna ligger kvar som sanningsenlig körhistorik.
2. **FAILURE-0054**: `maintenance-worker` hade `verify_jwt=true` och svarade 401 på
   varje schemalagd körning — den hade aldrig lyckats. Omdeployad med
   `verify_jwt=false`; första lyckade körningen 11:30:21.

Edge-deploy 2026-09-10 (andra passet)
-------------------------------------

Innan deployen jämfördes den **körande** koden i produktion mot repot, fil för fil.
Det avslöjade en drift som ingen statisk kontroll hade fångat: både
`process-outbox` och `rinkel-platform-worker` körde en `_shared/rinkel.ts` från
före 2026-09-07. I produktion saknades alltså hela device-inventeringen
(`getUser`, `listUsersWithDeviceDetails`, `staleRinkelDeviceIds`),
`testWebhook(event, url)`, tolkningen av Rinkels felkoder (`DIALING_SELF` m.fl.)
och snake_case-normaliseringen — levererat arbete som aldrig hade nått driften.
`process-outbox` körde dessutom en manifestversion (`kundexa.evidence.v2`) utan
generationsbindning.

- **`rinkel-platform-worker` är omdeployad (version 3).** Efter deployen hämtades
  den körande koden tillbaka och jämfördes byte för byte mot repot: båda filerna
  identiska (37 509 respektive 31 302 tecken). Första körningen efter deployen
  var `healthy` 13:43:03. FAILURE-0046:s release-RPC anropas nu på riktigt.
- **`process-outbox` går inte att deploya genom MCP-verktyget.** Verktyget tar
  filinnehåll som text i ett anrop, och funktionen kräver alla fyra filerna
  samtidigt: 102,8 kB. Ett försök avvisades av servern (`Entrypoint path does not
  exist`) eftersom `index.ts` inte fick plats i anropet — inget deployades och
  produktionen står kvar orörd på version 4. Den behöver kommandoraden.
- Övriga sex funktioner är i fas med repot: deras egna kataloger och de
  `_shared`-filer de importerar (`crypto.ts`, `providers.ts`) har inte ändrats
  sedan respektive deploy. Endast `rinkel.ts` låg efter, och den importeras bara
  av de två ovan.
- Alla sju workers med livstecken är `healthy`. `process-outbox` skriver inget
  livstecken alls — den enda kritiska worker som saknar övervakning.

Kvar att deploya, kräver kommandoraden:

- `npm run functions:deploy -- --project-ref lhvifuxcqghtbiulzkrf` för
  `process-outbox` (FAILURE-0044 samt bevismanifest v3 och generationsbundna
  signeringsbekräftelser). Skriptet deployar alla åtta; de sju andra är redan i
  fas, så det blir en no-op för dem.
- Vercel-deploy av grenen för UI-fixarna: automatisk dialer-loop, kundkortets
  kontaktpersoner, importens innehållstyp och knappen för omutskick. Samma deploy
  aktiverar `testWebhook(event, url)` i webbappen, som är det som verifierar
  `outgoingCall` och `callStart` — den kontrollen kan alltså inte gå igenom förrän
  grenen är ute.

Utrullat till main 2026-09-10
-----------------------------

Grenen `claude/system-flow-integration-check-y4natb` var 11 commits före
`origin/main` och 0 efter — en ren fast-forward, inga konflikter och inget att
rebasa. Hela `npm run verify` kördes om innan pushen (typer, edge-typkontroll,
tester, OpenAPI-täckning, produktionsbygge) och gick igenom.

`main` står nu på `7e03a30`, och Vercels produktionsdeploy för den committen är
`READY` (`dpl_4yDMPGCN2GUrNMQjh4grDuaByLjw`). Därmed är webbappens fixar live:
den automatiska dialer-loopen, kundkortets kontaktpersoner och ägarnamn,
importens kanoniska innehållstyp, knappen för omutskick av utgånget avtal — och
`testWebhook(event, url)`, som är förutsättningen för att verifiera
`outgoingCall` och `callStart`.

Kvar: `process-outbox` är fortfarande den enda komponenten som inte är utrullad.
