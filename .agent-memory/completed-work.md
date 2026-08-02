# Completed work

## 2026-07-30 central Rinkel-cutover

- Ersatte tenantägda Rinkel-credentials med en central plattformsintegration och en server-side miljönyckel.
- Lade centralt användar-/nummerinventarium, historiserade tenantallokeringar, nummergrants, säljar­mappningar, capabilities, webhookstatus, konfliktkö, event och jobb.
- Backfillar entydig legacydata, flaggar multi-tenantanspråk och nollställer/inaktiverar gamla Rinkel-credentials utan permanent fallback.
- Lade plattformsvy för test, synk, webhookar, allokering/flytt/återkallning, konflikter och nödstopp.
- Bytte dial, status, webhook, recording, transcription och workers till central väg och lade `rinkel-platform-worker`.
- Verifierade 38 migrationer samt realistisk tvåtenantisolering, atomisk reservation, idempotens och oföränderlig historik.

## 2026-07-30 Rinkel-telefoni

- Implementerade tenantägd Rinkel-anslutning, krypterad API-nyckel, katalogsynk och atomisk säljar-/enhets-/nummermappning.
- Ersatte den exekverbara 46elks/WebRTC-voicevägen med server-side Rinkel `/dial`; 46elks kvarstår endast för SMS.
- Återanvände kanoniska `calls`, listclaims, callbacks och efterarbete; lade till providerförsök, webhookhändelser, inspelningar, transkript, Insights och konfliktspår.
- Gjorde automatisk dialer beroende av friska webhookar både i UI och databas, med en aktiv säljare/enhet åt gången.
- Implementerade idempotenta webhookar, eventordning, okända `/dial`-utfall, reconciliation och faktisk retention av privata/providerägda ljudobjekt.
- Skärpte RLS och kolumnprivilegier för providerdata samt dead-letterade gamla voice-jobb utan provideranrop.
- Lade Rinkel-enhetstest, statiska regressioner och exekverade SQL-runtimeflöden.

## Verifierat 2026-07-30

- `npm run verify`: PASS under Node 24.14.0/npm 11.9.0.
- SQL-resultat: 37 migrationer, 157 publika tabeller, 270 publika funktioner och 292 RLS-policies.
- Rinkel-runtime: mappning, webhookhälsogrind, atomisk reservation, idempotent replay, providerfinalisering, samtidighetslås och upplåsning.

## 2026-07-25 hardening

- Reproducerade och rättade FK-felet vid teamuppdelning av plattformsallokerade listmedlemmar.
- Bevarade allokeringspostens `tenant_id` och lineage vid återkallning.
- Relänkade allokeringspost till faktiskt skapad teamlistmedlem före borttagning av källmedlem.
- Låste tenantparametrerade `SECURITY DEFINER`-katalogfunktioner till `service_role`.
- Skapade guarded authenticated wrappers och explicit tenantvaliderade servicewrappers för segmentrefresh och kampanjmaterialisering.
- Lade negativa tvåtenant- och privilege-regressionstest i SQL-verifieringen.
- Rättade discovery-API från ogiltigt `enrichment:write` till `directory:refresh`.
- Lade statisk regressionkontroll för scope-kontraktet.
- Etablerade `.agent-memory`, `AGENTS.md` och Cursor-regler.

## Verifierat

- `npm run verify`: PASS 2026-07-25.
- Inkluderar Edge/Deno check, statiska invarianter, importparserstest, 32 migrationer och runtime-RPC-flöden, TypeScript samt Next.js 16.2.10 produktionsbuild.
- SQL-resultat: 145 publika tabeller, 246 publika funktioner och 273 RLS-policies.
- Ren zip-leverans skapad och integritetstestad utan `node_modules`, `.next` eller `.env.local`.

## 2026-07-30 Rinkel-statuskorrigering

- Rättade dialerns statusendpoint så att säljare kan läsa säker, tenantbegränsad integrationsstatus utan att få credentials eller bred tabellåtkomst.
- Lade explicit felhantering för databas-/migrationsfel i stället för att visa dem som ”Rinkel är inte anslutet”.
- Rättade klientstatusen så att endast `configured === false` visas som en verkligt saknad Rinkel-anslutning.

## 2026-08-02 Rinkel lifecycle/CDR-härdning

- Separat kanonisk `provider_status`, `provider_outcome` och CRM-disposition.
- Okända välformaterade Rinkel-cause-värden bevaras rått och mappas defensivt till `unknown`.
- Inkommande kund-/kontaktmatchning sker enbart inom tenant som äger mottagande nummer och endast vid entydig träff.
- `callEnd` skapar idempotent inspelningsreferens och köar CDR/enrichment.
- `rinkel-platform-worker` hämtar och applicerar CDR; flera kandidater blir konflikt, aldrig gissning.
- Framåtriktad migration: `202608020001_rinkel_lifecycle_reconciliation_hardening.sql`.
- Statisk verifiering och kontraktsenhetstest: PASS. Rinkel fallback-enhetstest: PASS 8/8.
