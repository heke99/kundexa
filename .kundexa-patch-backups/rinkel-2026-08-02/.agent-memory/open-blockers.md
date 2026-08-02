# Open blockers

## P0 launch gates

- `db push` av alla 38 migrationer till separat Supabase staging: `NOT RUN`.
- Supabase-typer genererade från den verkliga databasen: `NOT RUN`.
- Tvåtenant-RLS/Storage med riktiga JWT-sessioner och alla roller: `NOT RUN`.
- Central Rinkel API-nyckel, riktig katalogsynk, device, dial och alla fem webhookar: `BLOCKED EXTERNALLY`.
- Inspelning, transkript, Insights, webhookretry/inaktivering och reconciliation: `BLOCKED EXTERNALLY`.
- Juridik/DPIA/retention, backup/restore, lasttest och extern penetrationstest: `NOT RUN`.

## Miljö

- Slutverifieringen kördes i Node 24.14.0/npm 11.9.0. Projektets Node 22.x/npm 10.9.2 är `NOT RUN`.
- Ingen gitmetadata finns, så patchen kan inte bindas till branch/commit.

Detaljer: `docs/PRODUCTION_GATES.md` och `RINKEL_DELIVERY.md`.
