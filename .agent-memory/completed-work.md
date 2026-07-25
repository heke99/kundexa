# Completed work

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
