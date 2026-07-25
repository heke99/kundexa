# Open blockers

## P0 launch gates

- `db push` till ren Supabase staging och tom produktionsmiljö: `NOT RUN`.
- Supabase-typer genererade från den verkliga databasen: `NOT RUN`.
- RLS-/Storage-integrationstest med minst två tenants och alla roller: `NOT RUN`.
- Livecredentials, kontrakt och verifierade callbacks för telefoni, e-post, data och NIX: `BLOCKED EXTERNALLY`.
- Juridiskt godkända avtal, DPIA, retention, inspelning och DSAR: `BLOCKED EXTERNALLY`.
- Extern malware-scanner i enforced mode: `BLOCKED EXTERNALLY`.
- Backup/restore, RTO/RPO, lasttest och extern penetrationstest: `NOT RUN`.

## Miljö

- Slutverifiering i detta arkiv körs i Node 24 trots att Node 22 är avsedd runtime.
- Ingen gitmetadata finns, så patchen kan inte bindas till branch/commit.

Detaljer: `docs/PRODUCTION_GATES.md`.
