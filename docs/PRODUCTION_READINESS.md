# Kundexa production readiness

Arbetsdokument. En punkt markeras `[x]` endast när den har verifierats i denna eller en
tidigare redovisad körning, med evidens angiven. `NOT RUN` betyder att kontrollen inte har
körts. `BLOCKED EXTERNALLY` betyder att den kräver åtkomst som inte finns i arbetsmiljön.

Senast uppdaterad: 2026-08-13.

## 1. Databas: migrationer, schema och typer

- [x] Repots migrationer motsvarar migrationshistoriken i det länkade projektet.
  Evidens: `list_migrations` mot `lhvifuxcqghtbiulzkrf` = 67 versioner, `ls supabase/migrations`
  = 67 filer, identiska versionsnummer.

> **Operativ varning.** Under detta pass applicerades två migrationer direkt mot
> produktionsprojektet av en annan aktör, utan motsvarande filer i repot och utan att
> `statements` sparades i `supabase_migrations.schema_migrations`:
> `202608130001_function_execute_least_privilege` och `202608130002_rls_auth_uid_initplan`.
> Båda är återskapade i repot från observerat produktionstillstånd. Så länge fler än en aktör
> applicerar migrationer mot samma projekt kan repot när som helst hamna efter produktion igen,
> och versionsnummer kan kollidera. Den här sessionens egen migration fick versionen
> `20260813222943` av `apply_migration` och filnamnet följer den faktiskt applicerade versionen.
- [x] Schemadrift mellan migrationer och genererade typer är noll.
  Evidens: `node scripts/verify-sql.mjs` — "180 tables, zero column drift".
- [x] Samtliga migrationer replayas rent från tom databas.
  Evidens: `node scripts/verify-sql.mjs` kör 66 migrationer plus runtime-vägar utan fel.
- [x] Produktionsmigrationer som saknades i repot är återskapade och incheckade.
  Evidens: `202608130001_function_execute_least_privilege.sql` (62 funktioner, 144 satser) och
  `202608130002_rls_auth_uid_initplan.sql` (37 policies); båda genererade från live-tillstånd.
- [x] RLS-uttryck anropar `auth.uid()` som InitPlan, inte per rad.
  Evidens: live-query — 37 av 37 policies använder `(select auth.uid())`, noll bara `auth.uid()`;
  stående invariant i `scripts/verify-sql.mjs`.

## 2. Verifieringskedjan

- [x] `node scripts/verify-sql.mjs` PASS.
- [x] `npm run types:verify` PASS (del av `npm run verify`).
- [x] `npm run typecheck` PASS.
- [x] `npm run typecheck:edge` PASS.
- [x] `npm run test` PASS (remediation-regression, verify, rinkel, contracts, imports, api, sql).
- [x] `npm run openapi:verify` PASS.
- [x] `npm run build` PASS.

## 3. SECURITY DEFINER och EXECUTE-rättigheter

Bakgrund: PostgreSQL ger som standard `EXECUTE` till `PUBLIC` på varje ny funktion. Rutiner
som skapats utan explicit `REVOKE` blev därför anropbara av den oautentiserade `anon`-rollen
via PostgREST (`/rest/v1/rpc/<namn>`).

- [x] Inga `SECURITY DEFINER`-RPC:er är körbara av `anon` i produktion.
  Evidens: live-query mot `pg_proc`/`has_function_privilege` returnerar 0.
- [x] Service-only-rutiner (explicit tenant-/entitetsparameter) är inte åtkomliga för
  `authenticated`; endast `service_role`.
  Evidens: `undo_master_entity_merge`, `rebuild_master_entity`, `recalculate_data_quality`,
  `apply_geographic_derived_value`, `source_priority_for`, `customer_has_legal_retention`
  har `authenticated=false`, `service_role=true`.
- [x] `merge_master_entities` behåller `authenticated` eftersom den anropas med användarsession
  från `src/app/actions/directory.ts`.
- [x] Auktoriseringsbypassen i `merge_master_entities` och `undo_master_entity_merge` är borta.
  Tidigare villkor `if not is_tenant_admin(...) and auth.uid() is not null` hoppade över
  admin-kontrollen för varje sessionslös anropare. Ersatt med
  `auth.role() is distinct from 'service_role' and not is_tenant_admin(...)`.
  Evidens: live-probe — `authenticated` utan session ger `admin_required`; `anon` stoppas
  redan av grant-lagret med `permission denied for function merge_master_entities`.
- [x] Ingen funktion i `public` har mutabel `search_path`.
  Evidens: live-query `proconfig is null` returnerar 0.
- [x] Regressionsskydd finns som stående invariant, inte som namnlista.
  Evidens: `scripts/verify-sql.mjs` failar om någon ny `SECURITY DEFINER`-funktion blir
  anon-körbar, om service-only-gränsen bryts, om `search_path` saknas eller om
  `auth.uid()`-bypassen återinförs.

Medvetet undantagna:

- RLS-predikathjälpare (`can_*`, `is_*`, `has_*`, `current_*`) behåller `authenticated`
  eftersom de utvärderas inuti policies som gäller `PUBLIC`; att ta bort `EXECUTE` skulle
  förvandla radfiltrering till hårt behörighetsfel.
- Triggerfunktioner revokeras men kräver ingen `EXECUTE` för att triggern ska köra, och
  PostgreSQL vägrar direktanrop.

## 4. Hemligheter

- [x] Inga provider-hemligheter når klientbundeln.
  Evidens: ingen `NEXT_PUBLIC_*` utöver app-URL/Supabase-URL/anon-nyckel; ingen klientkomponent
  refererar `RINKEL_API_KEY`, `RESEND_API_KEY`, service-role eller webhook-secrets; ingen
  klientkomponent importerar `@/lib/supabase/admin`.

## 5. Webhookar

- [x] Rinkel-webhooken autentiseras med konstant-tidsjämförelse av en hemlighet på 40–128
  tecken, IP-allowlist, storleksgräns 256 KiB, strikt content-type och schemavalidering.
  Evidens: `src/lib/webhooks/rinkel.ts`.
- [x] Resend-webhooken verifieras med Svix (Resends officiella mekanism), 300 sekunders
  replay-fönster, konstant-tidsjämförelse och per-tenant signeringshemlighet ur krypterade
  credentials; dedupliceras på `(provider, provider_event_id)` och persisteras före
  bearbetning.
  Evidens: `src/app/api/webhooks/resend/[token]/route.ts`.

## 6. Öppna punkter — databaslint

Följande advisor-fynd är medvetet inte åtgärdade i detta pass:

- `unindexed_foreign_keys` (384, INFO): att indexera samtliga skulle strida mot projektets
  regel att indexera utifrån faktiskt query-mönster och skulle straffa skrivvägarna.
  Riktade index finns redan i `202608070003` och `202608100010`.
- `unused_index` (70, INFO): "oanvänd" är väntat i en nyligen driftsatt databas; borttagning
  kräver mätning över tid.
- `multiple_permissive_policies` (101, WARN): konsolidering är en större omskrivning av
  policymodellen med reell regressionsrisk för tenantisolering.
- `rls_disabled_in_public` på `spatial_ref_sys` samt lint i `st_*`, `populate_geometry_columns`,
  `postgis_full_version`, `lockrow`, `addauth`: PostGIS-ägda objekt, patchas inte av Kundexa.
- `auth_leaked_password_protection` (WARN): Supabase Auth-inställning, ändras i projektets
  Auth-konfiguration, inte i migration.

## 7. Kvarstående externa gates

Dessa kräver åtkomst eller beslut som inte finns i arbetsmiljön:

- Verkligt Rinkel-konto: katalogsynk, device-/nummerallokering, utgående dial, de fem
  webhookeventen, CDR-reparation, recording och transcript. `BLOCKED EXTERNALLY`.
- Resend: verkligt utskick, bounce/complaint-replay mot verifierad domän. `BLOCKED EXTERNALLY`.
- Tvåtenant-RLS och Storage-åtkomst med riktiga JWT-sessioner. `NOT RUN`.
- Vercel: produktionsdeployment, runtime-loggar, webhook-endpoints efter deploy. `NOT RUN`.
- Webbläsarbaserad E2E mot deployad miljö. `NOT RUN`.
- Konkret BankID/e-signeringsleverantör (leverantör, credentials, callbackkontrakt,
  juridisk assurance-nivå). `BLOCKED EXTERNALLY`.
- Juridik/DPIA/retention, backup/restore, belastningstest, extern pentest. `NOT RUN`.
