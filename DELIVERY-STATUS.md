# Leveransstatus

Detta är ett körbart Kundexa-projekt med Next.js, Supabase, 32 ordnade migrationer, sju Edge Function-workers, versionerat API, tester och produktionsbuild. Prospektering, listtilldelning, sekventiell dialer, manuellt efterarbete, återkomster, kanoniska anteckningar och samtalsbaserad order ingår i samma datamodell.

Kodnivån är verifierad genom:

- TypeScript för webbappen
- Deno typecheck för samtliga workers
- full migrationskedja och runtime-RPC-flöden i PostgreSQL-kompatibel PGlite
- statiska tenant-, RLS-, licens- och säkerhetsinvarianter
- Next.js produktionsbuild med Webpack

Projektet ska inte beskrivas som skarpt produktionsgodkänt förrän externa integrationer, avtal och staging-/produktionsgrindar i `docs/PRODUCTION_GATES.md` är genomförda.

Senaste hardening 2026-07-25 rättar allokeringsreferenser vid teamuppdelning/återkallning, begränsar tenantparametrerade katalog-RPC:er till serverrollen, inför tenantvaliderade segment-/kampanjwrappers och synkroniserar discovery-API:t med scopet `directory:refresh`. Regressionstester omfattar även negativa tvåtenantfall.
