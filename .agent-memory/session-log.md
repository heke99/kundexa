# Session log

## 2026-07-30

- Genomförde en andra arkitektur-cutover från tenantägd till central Rinkel-plattform.
- Lade migration `202607300002_central_rinkel_platform.sql`, central katalog, allokeringar, grants, mapping v2, centrala webhookar och worker.
- Tog bort connectionbaserad webhookroute och alla exekverbara läsningar av tenantens Rinkel-credentials.
- Uppdaterade plattforms-/tenant-UI, status-API, dial, recording/transcription, OpenAPI, drift och dokumentation.
- Full `npm run verify`: PASS; SQL visar 38 migrationer, 170 tabeller, 277 funktioner och 297 policies.
- Live Supabase/Rinkel och Node 22 återstår som `NOT RUN`.

- Inventerade målkontraktet och befintliga telefoni-, outbox-, RLS-, krypterings- och dialerflöden.
- Implementerade Rinkel över den kanoniska samtalsmodellen utan parallellt CRM eller parallell samtalstabell.
- Lade tenantanslutning, katalogsynk, transaktionell användarmappning, click-to-call/power dialer, webhookingest, eventprocessning, Realtime, inspelning, transkript och Insights.
- Lade reconciliation för okända providerutfall och retention för privata Storage-objekt samt valbar providerradering.
- Stängde den gamla exekverbara 46elks/WebRTC-voicevägen och behöll 46elks enbart för SMS.
- Databasens runtimeprov hittade att `calls.callback_token_hash` krävdes; reservationen rättades med deterministisk hash.
- Säkerhetsgranskningen ersatte tenantbreda providerpolicies med roll-, team-, användar- och samtalsbaserad RLS samt säkra kolumnprivilegier.
- Senaste separata SQL-körning: PASS, 37 migrationer, 157 tabeller, 270 funktioner och 292 policies.
- Full `npm run verify`: PASS under Node 24.14.0/npm 11.9.0. Node 22 och live Supabase/Rinkel återstår.

## 2026-07-25

- Läste implementationens masterprompt och inventerade det levererade zip-arkivet.
- Installerade låsta paket med temporär npm-cache. Leveransmiljön kör Node 24, medan projektet kräver Node 22.
- Baseline typecheck/Edge check passerade. SQL-runtime hittade FAILURE-0001 i teamuppdelning.
- Lade migration `202607250001_platform_allocation_reference_hardening.sql` och regressionstest; SQL, test och build passerade.
- Säkerhetsgranskning hittade FAILURE-0002: tenantparametrerade katalog-/segment-RPC:er med för bred execute-rätt.
- Lade migration `202607250002_directory_tenant_boundary_hardening.sql`, guarded wrappers, explicita servicewrappers samt negativa tvåtenanttest.
- Rättade FAILURE-0003: discovery-route använder nu kanoniskt `directory:refresh`.
- Senaste separata SQL-körning: PASS, 32 migrationer, 145 tabeller, 246 funktioner, 273 policies och samtliga kanoniska runtimevägar.
- Etablerade beständigt projektminne och styrfiler.
- Full `npm run verify` passerade efter alla ändringar, inklusive Next.js-produktionsbuild.
- Paketerade en ren leverans utan dependencies, buildcache eller lokala hemligheter; zip-integritet verifierad.
- Den uppdaterade projektversionen ersatte den bifogade projektfilen med bibehållen filidentitet/versionhistorik.

### Rinkel-statusgranskning

- Reproducerade kodorsaken till att säljare alltid kunde se ”Rinkel är inte anslutet”: `tenant_integrations` har admin-only SELECT men statusrouten använde säljarens RLS-session.
- Ändrade statusrouten till autentiserad, explicit tenantfiltrerad service-role-läsning utan credentialexponering.
- Ändrade dialerhooken så att 500-/migrationsfel inte maskeras som en frånvarande integration.
- Paketinstallation/verifiering kunde inte köras i denna sandbox eftersom den interna npm-spegeln returnerade 404 för `pdf-lib@1.17.1`; detta är en verifieringsmiljöbegränsning, inte ett observerat projektfel.

### Rinkel lifecycle/CDR-härdning 2026-08-02

- Inspekterade masterprompt och hela zip-projektet; behöll den befintliga centrala Rinkel-modellen.
- Identifierade fyra konkreta driftluckor: okända cause-värden, inkommande kundmatchning, recordingprojektion och faktisk CDR-reparation.
- Lade framåtriktad migration, workerreparation, öppet defensivt schemasupport, provider outcome i API/UI, IP-env och regressionstester.
- `node scripts/verify.mjs`: PASS för 40 migrationer och statiska invarianter.
- Kontraktsenhetstest: PASS. Rinkel fallback-enhetstest via TypeScript-transpilering: PASS 8/8.
- `types:verify`: avsiktligt FAIL tills migrationen körts och typer genererats från staging.
- Full npm/Deno/SQL/build-gate blockerades lokalt av otillgängliga dependencies/Deno och avsaknad av länkad Kundexa staging; inga sådana steg rapporteras som godkända.

## 2026-08-07 — Genomgång av flöden, konsistens och byggkedja

Utgångsläge: `npm ci` var blockerad i tidigare miljöer, så `typecheck`, `test`, `build` och
SQL-runtime hade aldrig körts. Det visade sig vara orsaken till att flera verkliga defekter
låg kvar oupptäckta.

Gjort:

- Installerade dependencies och körde hela kedjan. Tre verkliga fel föll ut ur SQL-runtime.
- FAILURE-0012: `process_import_run` bröt mot sin egen hardening-trigger; ParseHubs
  automatiska commit var trasig i produktion. Ny migration `202608070001`.
- Två fixturfel: Rinkel-capabilities uppdaterades med `UPDATE` mot en rad som inte finns förrän
  connection-testet skapar den, och monotonicitetsfixturen hade absoluta datum som ruttnat till
  det förflutna och därför testade fel kodväg.
- FAILURE-0013 till FAILURE-0016: obegränsad tillväxt i `rate_limit_counters`, saknade
  `updated_at`-index, obegränsad klientpolling/refresh, och PostgREST-grammatik i söktermen.
- Ny driftkontroll av genererade typer, negativt testad med en canary-migration.
- Nytt testpaket `npm run test:api`.

Resultat: `npm run verify` PASS i sin helhet. Allt som kräver riktig Supabase-staging eller
riktig Rinkel-provider är fortfarande `NOT RUN` — se `open-blockers.md`.
