# Prestanda, systemsynkronisering och scraperplattform – teknisk rapport 2026-07-19

Denna rapport dokumenterar den fullständiga tekniska granskningen och de implementerade
rättningarna i migration `202607190002_performance_scrapers_and_run_controls.sql`,
`supabase/functions/_shared/providers.ts` samt tillhörande worker-, frontend- och testkod.

## 1. Systemkarta (sammanfattning)

Kundexa har en kanonisk datamodell där varje domän redan har en enda sanningskälla:

| Domän | Kanonisk tabell/RPC | Skriver | Läser |
|---|---|---|---|
| Tenants/roller | `tenants`, `tenant_memberships`, `membership_role` | onboarding-RPC, admin | RLS-hjälpare `current_tenant_id`/`is_tenant_admin`/`has_current_role` |
| CRM-kunder | `customers` (+ `tenant_entities` som brygga till katalogen) | server actions, importer, segmentmaterialisering | alla CRM-vyer, dialer, policytrigger |
| Global källdata | `master_entities`, `source_entities`, `source_facts`, `field_values`, `identity_keys`, `raw_payloads`, `entity_freshness`, `duplicate_candidates` | `complete_ingestion_record`, `complete_enrichment_job` | `directory_search_v2_for_tenant`, segment |
| Providers | `data_providers`, `provider_accounts`, `provider_permissions`, `provider_field_permissions`, `provider_rate_limits`, `provider_freshness_policies`, `provider_usage_counters` | `configure_generic_json_provider` + admin actions | båda workers |
| Insamlingsjobb | `ingestion_jobs`, `ingestion_runs`, `crawl_checkpoints`, `ingestion_errors` | scheduler/claim/complete/fail-RPC:er | ingestion-worker, admin-UI |
| Berikningsjobb | `enrichment_jobs`, `refresh_locks` | `queueEnrichmentForEntity`, `claim_enrichment_jobs` | data-worker |
| Listor/dialer | `customer_lists`, `customer_list_members` (PK `list_id,customer_id`), `dialer_sessions`, `activities(type='callback')` | list-RPC:er (`claim_next_list_member` m.fl.) | dialer-API, listvyer |
| Outbox/event | `outbox_jobs` (statuskonvention med `dead_letter`) | triggers + RPC:er | process-outbox |

Inga parallella tabeller eller dubbla flöden hittades som krävde borttagning; det som
saknades var konkreta provideradaptrar, kvot-/fördröjningsefterlevnad i ingestion-workern,
administrativa jobbkontroller och aggregerade läsvägar.

## 2. Identifierade och rättade prestandaproblem

| Problem | Rättning |
|---|---|
| Dashboard hämtade **alla** deal-rader (`select value,status` utan gräns) och gjorde sex separata anrop | `dashboard_overview()` (security invoker – RLS gäller) aggregerar allt i ett anrop; sidan gör nu två frågor |
| `companies/page.tsx` gjorde obegränsad `select('*')` | Kolumnspecifik query med `range()`-paginering, sökning och totalantal |
| `customers/page.tsx` hade hård 100-gräns utan pagineringskontroller | `range()`-paginering med totalantal och sidnavigering |
| `lists/page.tsx` hämtade **hela** `customer_list_members` för att räkna i Node | `customer_list_overview()` aggregerar total/öppna/säljare per lista i databasen |
| `lists/[id]/page.tsx` hämtade alla kandidatrader för statusräkning | `customer_list_candidate_counts()` returnerar räknare som jsonb |
| Dialerns dagskapacitetskontroll saknade index | `calls_list_capacity_idx (tenant_id,list_id,user_id,created_at)` |
| Återkomstclaimen sorterar på `coalesce(snoozed_until,due_at)` men indexet täckte bara `due_at` | Uttrycksindex `activities_callback_pick_idx` |
| Worker-köernas claim skannade utan partiella index | `ingestion_runs_claimable_idx`, `enrichment_jobs_claimable_idx` |
| Ingestion-workern återupptog på **samma** sida som senast slutfördes (dubbelarbete) | Resume beräknar nu `current_page + 1` när `next_page` saknas |
| `minimum_delay_ms` lagrades men tillämpades aldrig mellan requests | Workern läser `provider_rate_limits` och sover `minimum_delay_ms` + slumpad jitter mellan sidor |

## 3. Identifierade och rättade konsistens-/mismatchproblem

| Problem | Rättning |
|---|---|
| `schedule_due_ingestion_jobs` kunde skapa en ny körning medan en retry-bar misslyckad körning väntade → dubbelarbete mot källan | Schemaläggaren exkluderar nu jobb med öppen (`scheduled/running/paused`) eller retry-bar misslyckad körning; partiellt unikt index `ingestion_runs_one_open_per_job_idx` garanterar invarianten |
| `claim_ingestion_runs` kunde återclaima **terminalt** misslyckade körningar (`completed_at` kontrollerades aldrig) → icke-retrybara fel kördes om tills `max_attempts` | Claim kräver nu `completed_at is null` |
| `queueEnrichmentForEntity` hade en kapplöpning mellan idempotenskontroll och insert (unik nyckel gav fel i stället för deduplicering) | 23505-konflikter returnerar nu det befintliga jobbet (stampede-skydd) |
| Ingestion saknade synlig dead-letter-semantik | Terminalt misslyckad körning (=`failed` + `completed_at`) visas som `dead_letter` i admin och kan köras om med bevarad checkpoint |
| `data_providers.integration_type`/`adapter_key` kunde inte sättas för skrapkällor via UI | `configureScraperProvider` sätter `adapter_key`, `integration_type='scrape_html'`, `source_class='permitted_scrape'` |

## 4. Scraperarkitektur (Allabolag + Merinfo)

Gemensam plattform med separata adaptrar, byggd ovanpå den befintliga
`ingestion_jobs`/`ingestion_runs`/`enrichment_jobs`-arkitekturen – inga parallella flöden.

- **`supabase/functions/_shared/providers.ts`** – ren, körbar i både Deno och Node:
  - `SCRAPER_ADAPTERS.allabolag` och `SCRAPER_ADAPTERS.merinfo` med URL-mallar,
    sidparametrar, standardgränser och fältnycklar.
  - Kontraktsbaserad parsning (`record_regex` + per-fält-regex) där varje fält
    extraheras separat: osäkra fält utelämnas i stället för att gissas, och
    strukturförändringar upptäcks nedströms via `parser_versions`/`parser_observations`
    (match rate + sidfingeravtryck → karantän).
  - Normalisering: organisationsnummer (10 siffror + Luhn, `16`-prefix strippas),
    telefon till E.164, svenska belopp (`tkr`/`mkr`, parentesnegativ), heltal med
    tusentalsavgränsare, postnummer, webbadresser, HTML-entiteter.
  - `validateScraperFilter` – central filtermodell som återanvänds av admin-UI,
    jobbkö och worker.
  - `isPathAllowedByRobots` – robots-tolkning; disallow avbryter körningen terminalt.
    Systemet försöker aldrig kringgå CAPTCHA, blockeringar eller inloggade ytor.
- **Ingestion-worker** (discovery/listinsamling): adapterrouting via `adapter_key`,
  kvotreservation `reserve_provider_ingestion_usage` (en enhet per externt anrop,
  atomiskt fönster i `provider_usage_counters`), konfigurerbar fördröjning med jitter,
  robots-kontroll för `permitted_scrape`, identifierande User-Agent, checkpoint per
  sida och korrekt resume.
- **Data-worker** (detaljinsamling/uppdatering): `executeScraperDetail` hämtar och
  parsar en enskild källsida och fullföljer via samma `complete_enrichment_job` som
  API-providers – med samma dedup (`organization_number`-matchning i
  `complete_ingestion_record`/`complete_enrichment_job`), provenance, snapshots och
  freshness (20-dagars-TTL).
- **Konfiguration, inte hårdkodning**: max poster/körning (default 5000),
  femdagarsschema (`schedule_interval_seconds`), kvot + kvotfönster, min fördröjning,
  timeout, retries och TTL lagras i `ingestion_jobs`, `provider_rate_limits` och
  `provider_freshness_policies` och kan ändras i admin-UI:t utan deploy.
  Regexkontrakten kan bytas via `adapter_configuration` när källans liveformat
  fastställs eller ändras (produktionsgrind, se `docs/PRODUCTION_GATES.md`).
- **Persondata (Merinfo)**: person-entiteter kräver uttryckligt godkännande i
  formuläret (`person_data_approved`) plus dokumenterad tillstånds-/avtalsreferens;
  fältlicenser styr per fält via `provider_field_permissions`; personer dedupliceras
  endast på källans stabila identifierare – poster utan sådan hoppas över.

## 5. Administrativa jobbkontroller

`control_ingestion_run(p_run_id, p_action)` med `pause`/`resume`/`cancel`:

- Kräver tenantadmin (verifieras i databasen, inte bara frontend) och auditloggas.
- `resume` återställer försöksbudgeten och behåller checkpointen (`current_page`),
  vilket gör att en stoppad körning fortsätter från senaste sidan i stället för att
  börja om – även för dead-letter-körningar.
- Admin-UI:t visar progress, försök, checkpoint, nästa retry, öppna körningar,
  retry-väntande och dead letters, med pausa/återuppta/avbryt-knappar per körning.

## 6. Tenantisolering och deduplicering

- Alla nya läs-RPC:er (`dashboard_overview`, `customer_list_overview`,
  `customer_list_candidate_counts`) är `security invoker`: RLS förblir enda
  behörighetskällan.
- `reserve_provider_ingestion_usage` och `control_ingestion_run` är service-/adminytor
  med explicita behörighetskontroller; säljare blockeras (verifierat i runtime-test).
- Företag dedupliceras på normaliserat organisationsnummer i den befintliga
  `complete_ingestion_record`-resolvern; listmedlemskap har PK `(list_id,customer_id)`;
  berikningsjobb dedupliceras på `(tenant_id,idempotency_key)` inklusive vid samtidiga
  anrop; identiska ingestionjobb kan inte få två öppna körningar.

## 7. Verifieringsresultat (faktiskt körda)

| Kontroll | Kommando | Resultat |
|---|---|---|
| Deno-typecheck av samtliga workers + providers-modul | `npm run typecheck:edge` | Grön |
| Statiska invarianter + parserfixturer (Allabolag/Merinfo, robots, normalisering, filter) | `node scripts/verify.mjs` | Grön |
| 25 migrationer + runtime-RPC-flöden i PGlite (aggregat, kvot, jobbkontroller, dead-letter-resume, dubblettskydd, behörighet) | `node scripts/verify-sql.mjs` | Grön |
| TypeScript för webbappen | `npm run typecheck` | Grön |
| Produktionsbuild (Webpack) | `npm run build` | Grön |
| Allt ovan i följd | `npm run verify` | Grön |

## 8. Kvarvarande risker

- Regexkontrakten för Allabolag/Merinfo är verifierade mot fixturer, inte mot
  källornas liveformat; liveformat, avtal och robots-läge måste fastställas i
  staging innan skarpa körningar (samma produktionsgrind som övriga providers).
- `EXPLAIN ANALYZE` mot riktig Supabase/PostgreSQL med produktionsvolymer återstår;
  PGlite verifierar korrekthet och indexdefinitioner men inte planval under last.
- Databastyperna är manuellt synkroniserade för de nya RPC:erna; kör
  `SUPABASE_PROJECT_REF=<ref> npm run types:generate` efter `npm run db:push`
  mot ett riktigt projekt.
