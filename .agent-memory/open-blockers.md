# Open blockers

## P0 release gates

- Applicera alla 40 migrationer på separat Kundexa Supabase staging: `NOT RUN`.
- Generera och checka in `src/lib/supabase/database.types.ts` från staging: `NOT RUN`.
- Kör `npm run types:verify`, Edge/Deno, SQL-runtime, full test, build och komplett verify efter fungerande dependencyinstallation: `NOT RUN`.
- Verifiera tvåtenant-RLS/Storage med riktiga JWT-sessioner: `NOT RUN`.
- Verifiera central Rinkel API-nyckel, katalogsynk, device, nummer, dial och fem webhookevents: `BLOCKED EXTERNALLY`.
- Verifiera CDR-reparation, recording, transcript och Insights mot verklig plan: `BLOCKED EXTERNALLY`.
- Juridik/DPIA/retention, backup/restore, belastningstest och extern penetrationstest: `NOT RUN`.

## Miljö

- Sandboxen kör korrekt Node 22.16.0/npm 10.9.2 men kunde inte installera låsta dependencies: intern proxy gav 404 för `pdf-lib@1.17.1` och direkt registryförsök gav DNS `EAI_AGAIN`.
- Deno, PGlite/Postgres och Supabase CLI var därför inte körbara lokalt.
- Ingen `.git`-metadata finns i zip-arkivet.
