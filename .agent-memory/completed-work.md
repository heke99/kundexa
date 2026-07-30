# Completed work

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
