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

## FAILURE-0035 — Outbound calling was impossible because the device model contradicted the provider — FIXED 2026-09-07

Reverses FAILURE-0034's remedy, which treated a symptom as the rule. Rinkel has no devices endpoint; `deviceId` is
a nullable scalar on the user object that only appears after that user signs in on a Rinkel device. Requiring a
synchronized device row before allocation (`RINKEL_USER_DEVICE_MISSING`) and before seller mapping made assignment
impossible for the live account, whose provider payload reports `"deviceId": null`.

Three compounding effects, all fixed in `202609070001`:

1. `rinkel_reserve_platform_outbound_call_v2` and `telephony_status_for_current_user` inner-joined
   `platform_rinkel_devices` on the mapping's frozen `selected_device_id`. A seller mapped before the device
   existed stayed permanently undialable, and a replaced device left the mapping pointing at a removed row.
   Both now resolve through `rinkel_effective_provider_device`.
2. `staleRinkelDeviceIds` keyed staleness on a `devices[]` array that Rinkel never sends, so
   `deviceInventoryComplete` was always false and stale device rows were never deactivated. It now keys on whether
   the detail fetch succeeded.
3. Platform assignment was team-only and multi-step, and its auto-mapping required both an exact email match and
   exactly one active device — neither held for the live account.

Remaining and external: the Rinkel account still has no registered device, so a real outbound call is still not
possible until someone signs in on a Rinkel device. The code now fails closed with `PROVIDER_DEVICE_MISSING`.

## FAILURE-0036 — Second undocumented production migration drift — FIXED 2026-09-07

Production carried `20260814124751_rinkel_seller_number_assignment_without_device`, absent from the repository,
containing an earlier partial fix for FAILURE-0035. Replaying the repo would not have reproduced production, and
this session's first draft would have silently overwritten it (losing single-device auto-selection and
`DEVICE_SELECTION_REQUIRED`). Backfilled verbatim — the repo file's md5 equals the live
`schema_migrations.statements[1]` — and the new migration was rebased on top of it.

Production also had `get_tenant_rinkel_resources` guarded by `is_tenant_admin` while the repo had the looser
`is_tenant_member`. The stricter live behaviour is correct (the projection exposes the whole company's telephony
inventory) and the repo was aligned to it.

## FAILURE-0037 — The marketing legal-basis gate never fired without a consent row — FIXED 2026-09-07

`evaluate_contact_policy_for_tenant` computed

```sql
v_has_legal_basis := <legal_basis present> or v_permission_status='allowed';
```

`v_permission_status` is null whenever the customer has no `contact_permissions` row. In three-valued
logic `false or null` is null, so `not v_has_legal_basis` was null and

```sql
if v_customer.customer_type='person' and not v_has_legal_basis then
```

evaluated to null rather than true and did not fire. A private individual with no recorded legal basis
and no consent record — exactly the case the gate exists to stop — passed the check. The gate only ever
fired when a permission row existed with a status other than `allowed`, which is the narrower case.

No unlawful call resulted, because the NIX control that follows independently refuses a private
individual without a valid screening result. The two are separate controls and the legal-basis one must
stand on its own. Fixed in `202609070002` by coalescing the permission status. Regression coverage in
`verify-sql.mjs` asserts refusal without a consent row, acceptance with one, and that the NIX control
still fires independently.

Found while diagnosing a seller-visible `DIAL_PERMISSION_DENIED`, not by the compliance surface itself.

## FAILURE-0038 — Creating a customer was impossible: RLS policy re-queried its own table — FIXED 2026-09-07

`customers_scoped_select` guarded reads with `can_access_customer(id)`, and that function establishes
access by selecting the row back out of `public.customers`. `contracts_scoped_select` /
`can_access_contract` had the same shape.

PostgreSQL applies SELECT policies to `INSERT ... RETURNING`, and a STABLE function evaluates against
the statement's snapshot, in which the row being inserted does not yet exist. The lookup inside the
policy therefore found nothing and the insert failed with

    new row violates row-level security policy for table "customers"

even for the tenant owner who was also the creator and the assignee. Proven by isolating the clause:
the same INSERT without RETURNING succeeded, and `can_access_customer` on the new id returned true in
the next statement. Every application write goes through PostgREST's `.insert().select()`, which always
adds RETURNING, so the "Ny kund" form could never create a customer.

Fixed in `202609070003`: the policies now evaluate the candidate row's own columns via
`can_access_customer_row` / `can_access_contract_row`, and the id-based functions delegate to the same
helpers so the two forms cannot drift. Authorization rules are unchanged.

The dialer's own creation path was unaffected because it goes through the SECURITY DEFINER RPC
`create_or_match_manual_prospect`, which is why prospects could be created there but not from the
customer list.

Only these two tables had the self-referential shape; every other policy referencing `can_access_*`
passes a foreign key to an already-existing row.

## FAILURE-0039 — The customer card was read-only — FIXED 2026-09-07

`/app/customers/[id]` rendered `organization_number`, `personal_identity_number`, `email`, address and
`legal_basis`, but no update action existed anywhere in the codebase, so nothing could be filled in
after creation. That made the intended flow — create a minimal card to call, complete it before
registering the customer — impossible, and in particular made `legal_basis` unsettable, which is what
marketing calls to private individuals depend on.

Added `updateCustomerDetails` plus a completion form on the card. The identity field is one input; the
checksum decides whether it is stored as an organisation number or a personal identity number, and a
company is refused a personal identity number.

## FAILURE-0040 — pgcrypto search-path hardening silently reverted; every outbound call failed — FIXED 2026-09-07

`202608080002` set `search_path = public, extensions` on `rinkel_reserve_platform_outbound_call_v2`
because Supabase installs pgcrypto in `extensions`. `202608100006` later redefined that function with
`set search_path=public`. A `create or replace` replaces the whole SET clause, so the hardening was
lost. The reservation hashes its idempotency key with `digest()`, so on the hosted project every
outbound call failed at the call insert with

    function digest(text, unknown) does not exist

`finalize_signing_envelope` carried the same defect and would have failed when finalising a signed
contract. Both are restored in `202609070004`.

The PGlite harness defines its own `public.digest`, so replaying the migrations could never reproduce
this — the bug only existed where pgcrypto lives outside `public`. `verify-sql.mjs` now asserts the
invariant against `proconfig` directly: any SECURITY DEFINER function whose body calls a pgcrypto
function must carry `extensions` on its fixed search_path. That check is independent of the shim, so a
future redefinition fails replay instead of production.

Found by dry-running the real reservation RPC against production data, not by any existing test.

## FAILURE-0041 — The reservation NIX gate applied to companies — FIXED 2026-09-07

`evaluate_exact_call_policy` refused any direct-marketing call whose dialled number had no valid
`nix_checks` row, with no customer-type condition, while `evaluate_contact_policy_for_tenant` scoped the
same control to `customer_type='person'`. NIX-Telefon registers private subscriptions, so a business
call was being refused for a missing consumer-register result. The two policies now agree, and both
honour the tenant screening mode.

This also invalidated advice given earlier in the session that marking a customer as a company would
make it callable — it would not have, because of this second gate.

## FAILURE-0042 — En egen verifiering rullade tillbaka den fix den verifierade — FIXED 2026-09-07

**Symptom:** Användaren fick "Samtalet kunde inte reserveras säkert. Referens:
fcdeb9dc-…" efter att FAILURE-0040 rapporterats som åtgärdad.

**Rotorsak:** `alter function … set search_path = public, extensions` kördes i
SAMMA `execute_sql`-anrop som ett verifierande DO-block vars sista sats var
`raise exception 'RESERVE_OK'`. Hela anropet är en transaktion, så
rollbacken tog med sig ALTER-satserna. `RESERVE_OK` var sant inuti
transaktionen och falskt efteråt: `proconfig` var tillbaka på
`["search_path=public"]` och varje reservation föll på
`42883 function digest(text, unknown) does not exist`.

**Åtgärd:** ALTER-satserna applicerades ensamma, i ett eget anrop. Verifiering
skedde därefter i ett separat anrop.

**Regel:** En verifiering som avslutas med `raise exception` (eller på annat
sätt rullar tillbaka) får aldrig dela transaktion med den ändring den
verifierar. Applicera först, verifiera sedan — i skilda anrop.

## FAILURE-0043 — Självuppringning nådde Rinkel och läckte rått felsvar — FIXED 2026-09-07

**Symptom:** Säljaren fick `{"errors":[{"id":"to","code":"DIALING_SELF"}]}` som
felmeddelande i UI, och samtalet lämnade ett `failed`-radpar efter sig.

**Rotorsak, två delar:**
1. Kundexa kände inte till säljarens egen linje. Rinkel vägrar `POST /dial` när
   `to` är användarens eget nummer, men det upptäcktes först efter att
   `calls` + `rinkel_call_attempts_v2` redan skapats och `dial_requested` satts.
2. `errorForStatus` skickade vidare Rinkels råa svarstext som `RinkelError.message`
   vid HTTP 400, och `message` går rakt ut till säljaren.

**Åtgärd:** `rinkel_reserve_platform_outbound_call_v2` avvisar nu både säljarens
egen linje (`platform_rinkel_users.raw_provider_data->'phoneNumber'->>'e164'`) och
det tilldelade caller-ID-numret med `SELF_DIAL_NOT_ALLOWED`, före all radskapande.
Rinkel-klienten tolkar `errors[].code` och ger svenska meddelanden; den råa
svarstexten flyttades till `RinkelError.providerDetail`, som bara loggas.

**Regel:** Ett providerfel som når säljaren måste vara på svenska och beskriva
åtgärden. Rått svarsinnehåll hör hemma i serverloggen, aldrig i UI.

## FAILURE-0044 — Bevispaketet tappade all e-postbevisning tyst — FIXED 2026-09-10

**Symptom:** Varje genererat bevismanifest och varje bevis-PDF rapporterade
"0 e-postmeddelanden" och saknade leveransbeviset för det avtal de finns till för
att dokumentera. Inget fel syntes någonstans.

**Rotorsak:** `processEvidence` i `process-outbox` läste `error_code` från
`email_messages`. Kolumnen heter `failure_code` där; `error_code` finns på
`sms_messages`. PostgREST svarar med ett fel, inte ett undantag, och resultatet
destrukturerades bara på `data`, så `emails` var alltid `null`.

**Åtgärd:** Rätt kolumn, och samtliga beviskällor felkontrolleras nu — ett
misslyckat läsanrop kastar `evidence_source_read_failed:<tabell>:<orsak>` och
jobbet återförsöks i stället för att producera ett halvt bevis.

**Regel:** Edge functions är otypade mot databasen. En läsning som ingår i ett
juridiskt bevis får aldrig destruktureras utan att `error` kontrolleras.

## FAILURE-0045 — Ett enda misslyckat jobb stängde av auto-dialern för alla — FIXED 2026-09-10

**Symptom:** Automatisk uppringning slogs av med "Automatisk uppringning är pausad"
trots att telefoniworkern kördes varje minut utan problem.

**Rotorsak:** `telephony_status_for_current_user` och auto-dialer-grinden i
reservationen kräver `last_success_at > now() - interval '3 minutes'` för
`rinkel-platform-worker`. `record_platform_worker_heartbeat` uppdaterade
`last_success_at` endast vid status `healthy`, och workern rapporterar `degraded`
så snart *något* jobb i batchen fallerar. Ett återkommande jobbfel — en
CDR-avstämning som ännu inte kan hämtas är normalfallet och återköas med backoff —
gjorde att livstecknet blev inaktuellt och auto-dialern föll bort plattformsbrett.

**Åtgärd:** `degraded` betyder att körningen slutfördes med enskilda jobbfel som
har egen retry och dead letter; det är en levande worker. Endast `running` och
`failed` lämnar livstecknet obevisat. Rapporterad status är oförändrad.

**Regel:** Ett livstecken svarar på "kördes workern?", inte "lyckades varje jobb?".
Blanda inte ihop jobbhälsa med processhälsa i en grind som stänger av en funktion.

## FAILURE-0046 — Ett samtal utan providerutfall låste säljaren ute permanent — FIXED 2026-09-10

**Symptom:** Efter ett samtal där ingen webhook eller CDR kom fram kunde säljaren
inte ringa mer. Felet var dessutom obegripligt: en rå unique-violation, inte
reservationens eget meddelande.

**Rotorsak:** En säljare får ha exakt ett icke-terminalt uppringningsförsök —
reservationen vägrar ett andra, och `rinkel_call_attempts_v2_active_seller_uidx`
/ `..._active_device_uidx` upprätthåller det på lagringsnivå. Ingenting lämnade
det tillståndet när providern tystnade: workern flyttar ett hängande försök till
`reconciliation_required` efter 15 minuter, vilket självt är en blockerande status,
och en CDR som aldrig dyker upp gör att avstämningsjobbet fallerar tills det
dead-letterar. Varken tidsgräns, operatörsåtgärd eller RPC fanns för att släppa låset.

**Åtgärd:** `rinkel_release_stale_call_attempts` (service-only) terminaliserar
*försöket* efter en gräns med `error_code='PROVIDER_OUTCOME_NEVER_REPORTED'` och
loggar `call_events` + `audit_logs`. Samtalet behåller `reconciliation_required`
och `provider_outcome='unknown'`, så inget samtalsutfall hittas på och CDR-repair
fortsätter. Telefoniworkern anropar den varje avstämningspass. Statusar som kan
vara ett pågående samtal (`awaiting_provider_event`, `matched`) släpps aldrig.

**Regel:** Ett lås som bara öppnas av en extern händelse måste ha en egen gräns.
Att sluta vänta är ett sant påstående om försöket — det är inte samma sak som att
påstå ett utfall för samtalet.

## FAILURE-0047 — Automatisk ParseHub-commit hämtade tenant från ett UI-val — FIXED 2026-09-10

**Symptom:** Automatisk import misslyckades med `import_run_not_found` för tenant A
när importprofilens skapare råkade titta på tenant B i webben, och började fungera
igen när personen bytte tillbaka.

**Rotorsak:** `process_parsehub_import_run` impersonerade profilens skapare med
enbart `set_config('request.jwt.claim.sub',...)`, så `process_import_run` löste
tenant via `current_tenant_id()`s fallback: `profiles.active_tenant_id`, alltså
vilken tenant personen senast valde i UI:t. Körningens egen tenant deltog aldrig i
beslutet. Hade skaparen lämnat tenanten var automatisk commit död för gott.

**Åtgärd:** Samma servicekörningskontext som kontrakts-API:t redan använder —
`app.kundexa_tenant_id` sätts till importkörningens tenant och `current_tenant_id()`
accepterar den bara medan aktören har aktivt medlemskap i en aktiv tenant. Aktören
korsvalideras mot körningens tenant, och en aktiv owner/admin i tenanten tar över om
skaparen saknar committande roll.

**Regel:** Tenant härleds från resursen, aldrig från ett UI-val. Explicit tenant är
service-only och ska korsvalideras — kanonregeln i AGENTS.md gäller även workers.

## FAILURE-0048 — Filimportens mime-lista och storage-bucketens gick isär — FIXED 2026-09-10

**Symptom:** En .xlsx som webbläsaren skickade som `application/octet-stream`, eller
en fil utan angiven typ, validerades och parsades klart och dog sedan på
uppladdningen: "Importen kunde inte behandlas. Referens: ...".

**Rotorsak:** `assertExtensionAndMime` accepterar avsiktligt `application/octet-stream`
och tom mime-typ, men uppladdningen lagrade den klientpåstådda typen
(`file.type || "application/octet-stream"`) i bucketen `imports`, vars
`allowed_mime_types` inte innehåller den. Två allowlists för samma sak, ur synk.

**Åtgärd:** Innehållstypen härleds nu ur den parsade `sourceType` —
`canonicalImportMimeTypes` — så det lagrade objektet får serverns bedömning i
stället för klientens påstående. `npm run test:imports` jämför den tabellen mot
bucketens allowlist ur migrationerna, så de kan inte glida isär igen.

**Regel:** När två ställen beskriver samma tillåtna format måste ett test binda ihop
dem. Lagra serverns slutsats om en fil, inte klientens påstående.

## FAILURE-0049 — Kundkortet visade varken kontaktpersoner eller ansvarig — FIXED 2026-09-10

**Symptom:** Importerade kontaktpersoner syntes ingenstans på kundkortet trots att
dialern ringer dem och avtal skickas till dem. "Ansvarig" visade texten "Tilldelad
användare", aldrig vem. "Skapa avtal" länkade till `/app/contracts?customer=<id>`,
en parameter avtalsregistret inte läser, så säljaren hamnade i den ofiltrerade listan.

**Åtgärd:** Kortet hämtar `contact_people` och visar dem med roll, nummer och
ringknapp, löser upp `assigned_user_id` mot `profiles.full_name`, och länkar till
`/app/contracts/new?customer_id=<id>`.

**Regel:** `customers` är det kanoniska kundkortet. Data som andra flöden agerar på
måste synas där, annars är kortet inte kanoniskt i praktiken.

## FAILURE-0050 — Tenantägda rader kunde peka på en annan tenants rad — FIXED 2026-09-10

**Symptom:** Ingen observerad incident. Hittad genom att jämföra samtliga främmande
nycklar mot tenantmodellen.

**Rotorsak:** Tretton främmande nycklar mellan två tenantägda tabeller var
enkolumnsnycklar: barnet bar `tenant_id`, men nyckeln kontrollerade bara `id` mot
föräldern. Ingenting i databasen hindrade
`rinkel_call_attempts_v2.number_allocation_id` från att peka på en annan tenants
nummerallokering, eller `legal_holds.customer_id` på en annan tenants kund. De
RPC:er som skriver raderna slår upp varje förälder tenantfiltrerat, så det var en
saknad backstop snarare än ett känt läckage.

**Åtgärd:** `202609100003_tenant_scoped_reference_integrity.sql` gör samtliga
sammansatta på `(tenant_id, id)`, med kolumnspecifik `on delete set null (kolumn)`
så att obligatoriskt `tenant_id` aldrig nollas (FAILURE-0001). Migrationen
rapporterar överträdande rader med tabell och antal i stället för ett rått
constraintfel. `platform_rinkel_webhook_events.correlated_call_id` och
`.correlated_attempt_id` är medvetet undantagna: den tabellens `tenant_id` är null
till dess korrelationen lyckats.

**Regel:** En tenantgräns upprätthålls av schemat, inte bara av de anropare som råkar
vara korrekta idag. `verify-sql.mjs` avvisar nu varje ny enkolumnsnyckel mellan två
tenantägda tabeller och bevisar att en tvärtenantskrivning nekas.

## FAILURE-0051 — Efterarbete var omöjligt på varje samtal ingen svarade — FIXED 2026-09-10

**Symptom:** Ett listsamtal som ringde ut, gick till telefonsvarare eller avvisades
kunde inte ges något utfall alls. "Inget svar", "Telefonsvarare" och "Ring inte
igen" var oåtkomliga på exakt de samtal som behöver dem. Prospektet låg kvar
reserverat tills reservationen gick ut, och en automatisk dialer kunde inte ta sig
förbi det första obesvarade samtalet.

**Rotorsak, två delar som doldes av varandra:**
1. `complete_dialer_work` godkände ett avslutat samtal endast i
   ('completed','busy','no_answer','failed','cancelled'). Rinkels projektion skriver
   aldrig tre av statusarna den producerar in i den mängden:
   `mapRinkelCauseToCallStatus` ger `unanswered`, `voicemail`, `blocked` och
   `outside_business_hours`.
2. `complete_dialer_work_v2` försökte brygga det genom att skriva om `calls.status`
   till ett godkänt värde, delegera och skriva tillbaka. Bryggan kunde aldrig
   fungera: `call_status_rank` ger varje terminal status rank 100 och
   `protect_rinkel_call_projection` återställer tyst varje ändring mellan två
   rank-100-statusar — helt avsiktligt, så att en sen providerhändelse inte kan
   skriva om ett avgjort utfall. Omskrivningen var alltså en no-op och den
   delegerade funktionen såg fortfarande `unanswered`.

**Åtgärd:** Grinden fixas i stället för statusen. `is_terminal_call_status` är en
delad definition ovanpå `call_status_rank`, och båda funktionerna använder den.
`complete_dialer_work_v2` skriver inte längre om `calls.status` — projektionen
förblir enda källan till vad som hände på linjen.

**Regel:** Om två skydd motsäger varandra vinner det som körs sist och tyst. En
statusomskrivning som ska passera en grind är en ledtråd om att grinden är fel.

## FAILURE-0052 — Automatisk uppringning stannade vid varje obesvarat samtal — FIXED 2026-09-10

**Symptom:** I automatiskt läge öppnade dialern efterarbete efter varje samtal, även
när ingen svarade. Säljaren fick manuellt registrera "inget svar" och klicka vidare
för varje prospekt, vilket gör den automatiska dialern manuell.

**Rotorsak:** `list-dialer-workspace.tsx` gick till `after_call` för varje terminal
status. Ingen skillnad gjordes på ett besvarat samtal och ett som ringde ut.

**Åtgärd:** Statusar där ingen kom på linjen (`unanswered`, `no_answer`, `busy`,
`voicemail`) registreras automatiskt med listans motsvarande disposition via samma
endpoint som säljaren använder, varefter nästa prospekt hämtas och rings upp.
Dialern stannar för efterarbete när någon svarar (`completed`, som Rinkel skriver
för både människa och växel). En policyvägran (`blocked`,
`outside_business_hours`) bränner ingen disposition utan pausar sessionen med skäl.
Ett utfall registreras automatiskt bara om listan har exakt den dispositionen och
den inte kräver anteckning, återkomst eller order — annars får säljaren fylla i.

**Regel:** Automatisk uppringning betyder att systemet arbetar listan tills någon
svarar. Utfallet ska ändå registreras — automatiskt när maskinen kan avgöra det,
av säljaren när en människa svarat.

## FAILURE-0053 — En utgången acceptlänk dödade avtalet för gott — FIXED 2026-09-10

**Symptom:** Kunden svarade inte i tid, länken gick ut, och säljaren kunde inte
skicka samma avtal igen. Enda vägen framåt var att rita om hela avtalet under ett
nytt nummer, trots att version, kanonisk PDF och källsamtal fortfarande var giltiga.

**Rotorsak:** `enqueue_due_contract_reminders` sätter en förfallen acceptbegäran
till `expired` och projicerar det på avtalet som `status='expired'`. Ingenting
flyttar ett avtal ur den statusen, och `assert_contract_sendable_v2` godkände bara
('ready','sent','delivered','opened'). `extend_contract_acceptance_expiry` kunde
inte heller rädda det — den kräver en *pending* begäran, och då finns ingen.

**Åtgärd:** En utgången länk är en egenskap hos begäran, inte ett beslut om avtalet,
så ett nytt utskick är tillåtet från `expired`. `prepare_contract_delivery_v2`
supersederar redan alla tidigare begäranden, höjer `acceptance_generation` och
binder ny token, nytt svarsdatum och dokumenthash — det nya försöket blir en ren
generation och den utgångna ligger kvar i spåret. `declined` och `cancelled`
förblir terminala; de är beslut. Utgångssvepet flyttades till
`expire_contracts_without_pending_acceptance`, som bara utgångsmarkerar avtal vars
*aktuella* generation saknar levande begäran — annars hade svepet dragit tillbaka
ett nyss omskickat avtal till `expired`.

**Regel:** Skilj på att en länk tar slut och att motparten har bestämt sig. Bara det
andra är terminalt.

## FAILURE-0054 — maintenance-worker svarade 401 på varje körning — FIXED 2026-09-10

**Symptom:** `platform_worker_heartbeats` visade `maintenance-worker` med
`last_success_at = null` och `EDGE_WORKER_HTTP_401` på varje körning. Den hade
alltså **aldrig** lyckats i produktion.

**Rotorsak:** Funktionen var deployad med `verify_jwt=true` medan `invokeScheduledEdgeWorker`
bara skickar `x-cron-secret` (funktionen gör sin egen autentisering mot den hemligheten).
Övriga sju Edge Functions har `verify_jwt=false`, vilket `scripts/deploy-functions.mjs`
sätter med `--no-verify-jwt`. Avvikelsen uppstod sannolikt vid en deploy via ett verktyg
vars standardvärde är `true`.

**Konsekvens:** Retention/gallring, segmentuppdatering, dynamiska listor,
geografinormalisering, utgångna plattformsallokeringar och prunning av
`rate_limit_counters` har aldrig körts i produktion. `rate_limit_counters` växer obegränsat
utan prunningen.

**Åtgärd:** Omdeployad med `verify_jwt=false`.

**Regel:** `verify_jwt` är en del av funktionens kontrakt, inte en deploy-detalj. En funktion
som autentiserar med egen hemlighet måste deployas med `--no-verify-jwt`, och heartbeat med
`last_success_at = null` ska larma — den skiljer "har aldrig fungerat" från "fungerade nyss".

## FAILURE-0055 — produktionen körde en `_shared/rinkel.ts` från före 2026-09-07 — FIXED 2026-09-11

**Symptom:** Ingen. Det är hela poängen: repot, typkontrollen och hela SQL-sviten
var gröna, och `list_edge_functions` visade alla åtta funktionerna som `ACTIVE`.
Driften syntes först när den **körande** koden hämtades hem med
`get_edge_function` och jämfördes rad för rad mot repot.

**Rotorsak:** En Edge Function deployas som en ögonblicksbild av sina filer. En
ändring i en delad modul når därför inte driften förrän varje funktion som
importerar den deployas om. `_shared/rinkel.ts` ändrades 2026-09-07, men
`process-outbox` senast deployades 2026-08-08 och `rinkel-platform-worker`
2026-08-07. Inget i repot gör den skillnaden synlig, eftersom repot bara beskriver
vad som *borde* köra.

**Konsekvens:** Levererat arbete låg overksamt i produktion — device-inventeringen
(`getUser`, `listUsersWithDeviceDetails`, `staleRinkelDeviceIds`),
`testWebhook(event, url)`, tolkningen av Rinkels felkoder (`DIALING_SELF` →
begripligt svenskt fel i stället för rå engelsk JSON) och snake_case-normaliseringen
av Rinkels svar. `process-outbox` skrev dessutom fortfarande bevismanifest
`kundexa.evidence.v2` utan generationsbindning.

**Åtgärd:** Båda funktionerna omdeployade och verifierade byte för byte mot repot.
`rinkel-platform-worker` (version 3) och `process-outbox` (version 5, deployad
2026-09-11 08:14 UTC) hämtades hem med `get_edge_function` och jämfördes fil för
fil. `rinkel-platform-worker` är identisk. `process-outbox` är identisk i tre av
fyra filer; i `index.ts` skiljer sig fyra rader genom att radbrytningarna i en
enda mallsträng står som `\n` i stället för som faktiska radbrytningar. Det är en
artefakt av hur jag överförde filen, inte en kodskillnad: `\n` i en template
literal *är* en radbrytning, och att båda formerna ger samma sträng är verifierat
i körning. Ingen annan skillnad finns i någon fil.

Samtidigt svepte jag alla åtta Edge Functions, inte bara de två: `automation-runner`,
`compliance-worker`, `data-worker`, `ingestion-worker`, `maintenance-worker` och
`parsehub-worker` är byte-identiska med repot. Driften är därmed stängd i hela
ytan, inte bara där den först syntes. Att `automation-runner` är identisk bekräftar
också att min tidigare misstanke mot den — grundad på tidsstämplar — var fel.

`process-outbox` har kört två gånger efter omdeployen, båda HTTP 200, och kön
töms i skarp drift: `rinkel.retention`-jobben som köades 00:00 i dag var klara
00:01, med `attempts = 1` och utan fel.

**Regel:** Deploystatus är inte samma sak som repostatus, och en delad modul har
lika många deploys som den har importörer. Efter varje ändring i
`supabase/functions/_shared/` ska **alla** funktioner som importerar filen
deployas om, och en deploy verifieras genom att hämta hem den körande koden och
jämföra den mot repot — inte genom att anta att anropet lyckades.

## FAILURE-0056 — två pg_cron-jobb har misslyckats 65 954 gånger i rad utan en enda lyckad körning — FIXED 2026-09-10

**Symptom:** `postgres_logs` innehåller 1 464 `ERROR`-rader per dygn:
`null value in column "url" of relation "http_request_queue" violates not-null
constraint`. Ingenting i applikationen märkte något, eftersom ingenting berodde
på jobben.

**Rotorsak:** Två pg_cron-jobb — `kundexa-workers-every-minute` (varje minut) och
`kundexa-maintenance-hourly` (varje timme) — bygger sin URL från
`vault.decrypted_secrets` där `name = 'kundexa_project_url'`. Valvet är tomt, så
subselecten ger `null`, hela URL:en blir `null` och `net.http_post` faller på
`http_request_queue.url`s not-null-villkor. Samma sak gäller `x-cron-secret`, som
också blir `null`.

Jobben finns **inte i repot**. De skapades direkt i produktionen 2026-07-27 och
har aldrig fångats i en migration, vilket är varför varken typkontrollen, SQL-sviten
eller någon tidigare genomgång kunde se dem: de granskar repot, och repot visste
inte att de existerade.

**Konsekvens:** Ingen funktionell — den riktiga schemaläggaren är Vercel Cron
(`vercel.json`, åtta jobb, rutter under `src/app/api/cron/`), och den fungerar:
alla workers har livstecken varje minut. Skadan är operativ och två saker till:

1. 1 440 felrader per dygn dränker riktiga fel i `postgres_logs`. Det var precis
   den bruskällan som gjorde att jag hittade dem — inget annat stack ut.
2. Konstruktionen läcker hemligheten om den halvlagas. Felets `DETAIL` skriver ut
   hela raden som avvisades, inklusive `headers`. Just nu står det
   `"x-cron-secret": null`; i samma sekund som någon lägger in
   `kundexa_cron_secret` i valvet men URL:en fortfarande är fel hamnar
   cron-hemligheten i klartext i både `cron.job_run_details` och `postgres_logs`.
3. Jobbet var dessutom en ofullständig kopia: `rinkel-platform-worker` saknas i
   dess lista, så även fullt fungerande hade det inte schemalagt allt.

**Åtgärd:** Båda jobben satta till `active = false` med `cron.alter_job`.
Definitionen ligger kvar i `cron.job` och är avskriven i `current-state.md`, så
inget går förlorat. Jag valde avstängning framför `cron.unschedule` eftersom det
stoppar felen lika effektivt men lämnar artefakten synlig för dig att bestämma om.

**Regel:** Schemaläggning ska ha exakt en ägare, och den ägaren ska finnas i repot.
Ett jobb som skapas direkt i produktionen är osynligt för varje granskning som
utgår från koden. Och ett schemalagt jobb som aldrig har lyckats en enda gång ska
larma — `cron.job_run_details` med noll `succeeded` är samma sorts signal som en
heartbeat med `last_success_at = null` (FAILURE-0054).

## FAILURE-0057 — ett uteblivet besked signerade avtalet — FIXED 2026-09-11

**Symptom:** Inget rapporterat. Hittad vid genomgång av den publika signeringssidan.

**Rotorsak:** `respondPublicContract` läste beslutet som
`String(formData.get("decision") ?? "accept")`. Beslutet kommer från värdet på den
knapp kunden trycker på, så om det av någon anledning inte kom med — ett fält som
föll bort, ett inskickat formulär från annat håll — tolkades det som att kunden
**accepterade** ett juridiskt bindande avtal.

**Konsekvens:** En acceptans kunde registreras med bevis (namn, tid, IP,
dokumenthash) utan att kunden valt att acceptera.

**Åtgärd:** Beslutet har inget standardvärde längre. Parsningen ligger i
`src/lib/contracts/public-response.ts` så den går att testa, och testet kräver att
ett uteblivet, tomt eller okänt beslut avvisas i stället för att tolkas som
acceptans. Enter-i-formuläret fungerar fortfarande: webbläsaren skickar värdet
från förvald knapp.

**Regel:** Ett standardvärde är ett antagande. På en handling som binder någon
juridiskt får det inte finnas ett — uteblivet svar ska betyda "fråga igen", aldrig
"ja".

## FAILURE-0058 — databasens felmeddelanden nådde den publika signeringssidan — FIXED 2026-09-11

**Symptom:** Inget rapporterat. Samma genomgång.

**Rotorsak:** `redirect(...?error=${encodeURIComponent(error.message)})` skickade
Postgres egna undantagstext till en oautentiserad sida.

**Konsekvens:** Funktionsnamn, villkorsnamn och interna identifierare kunde visas
för vem som helst med länken, och texten var ändå inte något kunden kunde agera på.

**Åtgärd:** Kända tillstånd (fel kod, utgången länk, omskickat avtal, inaktiv
begäran) får en svensk mening kunden kan agera på. Allt annat loggas server-side
med `requestId` och besvaras generiskt.

**Regel:** En publik yta får aldrig återge databasens text. Översätt de tillstånd
användaren kan göra något åt, logga resten.

## Kontrollerat och avfärdat 2026-09-11

- **Intervallgrinden för bindnings-/uppsägningstid** finns i UI:t men inte i API:t.
  Inte en lucka: `create_contract_draft_api_v2` tar värdena från den aktiva
  prisversionen, och prisversionen valideras med samma gränser (240/120/365) där
  den skapas. UI-grinden är extra djupförsvar eftersom säljaren får skriva över.
- **SMS-signeringen** såg först ut att registrera `manual_review` som `declined`.
  Fel läsning: `if (decision === "manual_review") continue;` tre rader ovanför gör
  att den aldrig når ternären. Ett tvetydigt svar registreras som
  `manual_review_required`, och bara när det finns exakt en väntande begäran att
  knyta det till — att gissa vilket avtal ett tvetydigt svar gäller vore värre.

## FAILURE-0059 — "Skapa segment" visades för alla och misslyckades för nästan alla — FIXED 2026-09-11

**Symptom:** Inget rapporterat. Hittad vid en systematisk genomgång av alla 110
exporterade serveråtgärder: vilka saknar en behörighetsgrind?

**Rotorsak:** `createDirectorySegment` hade bara `getAppContext()` och gick sedan
rakt på `insert into segments`. Katalogsidan renderade knappen utan rollvillkor, så
den syntes för varje roll med `directory.read` — säljare, viewer, finance, quality.
`segments`-tabellens RLS-policy släpper bara igenom `is_tenant_admin`, alltså
owner och admin.

**Konsekvens:** Ingen säkerhetslucka — RLS höll. Men en knapp som alltid
misslyckades för de flesta roller, och förklaringen som visades var Postgres egen
text: *new row violates row-level security policy for table "segments"*. Samma sak
för Uppdatera/Skicka på befintliga segment, där RPC:n nekar alla utom
owner/admin/team_lead/backoffice.

**Åtgärd:** Rollmängderna är deklarerade en gång i `permissions.ts`
(`segmentCreateRoles`, `segmentManageRoles`) och används av både sidan och
åtgärderna, så de inte kan glida isär. Knappar visas bara för roller som kan
slutföra handlingen, och åtgärderna kontrollerar själva med ett svenskt
meddelande om någon postar formuläret direkt.

**Regel:** En knapp som databasen kommer att neka ska inte visas. Och när tre lager
— behörighetsmodell, RLS och RPC — säger olika saker om samma handling, är det
databasen som bestämmer; koden ska säga samma sak som den.

**Notering:** `team_lead` och `backoffice` har `segments.manage` och får uppdatera
och materialisera ett segment, men inte skapa ett. Den asymmetrin är RLS:ens, och
jag har låtit den stå — att ändra vem som får skriva i en tenant-tabell är ditt
beslut, inte ett buggfix. Ett runtime-test spikar nu den faktiska behörigheten så
konstanterna inte kan bli osanna i tysthet.

## FAILURE-0060 — säljarens organisationsnummer validerades inte och två ogiltiga ligger i produktion — FIXED 2026-09-11

**Symptom:** Inget i drift, för inget avtal har skickats ännu. Felet syns bara om
man läser `tenant_legal_entities` och kontrollerar värdena mot ett riktigt
organisationsnummer.

**Rotorsak:** `upsert_tenant_legal_entity` validerade telefonnumret mot E.164
men sparade organisationsnumret ordagrant. Kundernas organisationsnummer har
alltid gått genom `normalizeOrganizationNumber` (tio siffror, Luhn, kanonisk
form `NNNNNN-NNNN`) vid varje import — säljarens eget, det som faktiskt trycks
på dokumentet, var det enda identitetsnumret i systemet som ingenting kontrollerade.

**Konsekvens:** Produktionen innehåller `5594616-7149` (elva siffror) för
Gridex El AB och `559333333` (nio siffror) för Trustcall. Mallen använder
`{{seller.organization_number}}`, så båda hade skrivits ut som den avtalsslutande
partens organisationsnummer på ett juridiskt bindande dokument. Ett avtal med fel
organisationsnummer på avsändaren är en identifieringsbrist i själva handlingen.

**Åtgärd:** `202609110001_validate_seller_organization_number.sql` speglar
TypeScript-normaliseraren i SQL (`private.normalize_swedish_organization_number`
plus Luhn-kontrollen) och validerar i `upsert_tenant_legal_entity` när landet är
SE. Personnummer accepteras — en enskild firma tecknar avtal med ett sådant, och
att neka det hade låst ute ett verkligt svenskt företag från sina egna avtal.
Utländska bolag lämnas orörda, eftersom en gissning om deras nationella format
hade nekat ett legitimt företag.

**Medvetet ingen CHECK-constraint.** De två felaktiga raderna finns redan. En
constraint — även `NOT VALID` — hade fått varje senare UPDATE av just de raderna
att falla, inklusive `is_default=false`-svepet inuti samma funktion. Validering på
skrivvägen nekar nya felaktiga värden utan att göra de befintliga raderna
oskrivbara, vilket är precis det som gör att de går att rätta.

De två befintliga värdena är **inte** rättade av mig: rätt organisationsnummer är
en uppgift bara ägaren har, och att gissa hade varit värre än att lämna felet
synligt. Admin-vyn markerar dem nu som "Behöver rättas" med skälet utskrivet.

**Regel:** Ett identitetsnummer som hamnar på en juridiskt bindande handling ska
valideras med samma regel oavsett om det är kundens eller vårt eget.

## FAILURE-0061 — `contract_delivery_email` kunde stå på medan `outbound_email` var av — FIXED 2026-09-11

**Symptom:** Admin-vyn visade "Avtalsutskick via e-post: Tillåten för tenanten"
för Gridex. Ett avtalsutskick hade ändå fallit på `outbound_email_feature_disabled`.

**Rotorsak:** Utskicket kontrollerar två flaggor, inte en — kanalens egen grind
och den allmänna utgående grinden. Admin-vyn visade dem som oberoende reglage,
så en påslagen leveransflagga läste som "klart" när den inte hade någon effekt.

**Åtgärd:** Admin-vyn skriver nu ut beroendet på den flagga som är verkningslös.
Flaggan i produktion är **inte** ändrad av mig: att slå på `outbound_email` utan
en kopplad Resend-nyckel flyttar bara felet till leverantörssteget.

**Regel:** En grind som beror på en annan ska säga det där den visas, inte där
den kontrolleras.

## FAILURE-0062 — ett juridiskt avsändarbolag gick inte att rätta i gränssnittet — FIXED 2026-09-11

**Symptom:** Upptäcktes när jag skulle skriva instruktionen "spara om bolaget med
rätt organisationsnummer". Det gick inte att göra.

**Rotorsak:** `upsert_tenant_legal_entity` har alltid tagit emot ett `p_id` och
uppdaterar raden när det finns. Admin-vyn hade bara ett tomt formulär utan
`name="id"`, så `value(form,"id")` blev alltid tomt och `p_id` alltid null —
varje sparning blev en INSERT.

**Konsekvens:** Ett felaktigt bolag kunde inte rättas, bara dubbleras. Den som
försökte korrigera Gridex organisationsnummer hade fått två aktiva bolag med
samma namn och olika nummer, och avtalet hade pekat på vilket som helst av dem.
Det här gjorde FAILURE-0060 omöjlig att åtgärda för ägaren.

**Åtgärd:** Varje bolag har nu ett förifyllt redigeringsformulär med `id` som
dolt fält, öppet från början när raden har ett problem. Tilläggsformuläret ligger
kvar under egen rubrik.

**Regel:** En vy som visar ett fel måste också innehålla vägen att rätta det.
Att flagga något som "behöver rättas" utan att kunna rätta det är inte hjälp.
