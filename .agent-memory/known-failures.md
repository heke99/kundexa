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
