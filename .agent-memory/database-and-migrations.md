# Database and migrations

Snapshot 2026-07-30:

- 38 ordnade SQL-migrationer.
- PGlite: 170 publika tabeller, 277 publika funktioner och 297 RLS-policies.
- `202607300001_rinkel_telephony_completion.sql` är distribueringshistorik och får inte ändras.
- `202607300002_central_rinkel_platform.sql` gör central cutover, backfill, konfliktmarkering och avveckling av tenant-Rinkel-vägen.

Regler:

- En aktiv `platform_integrations`-rad för Rinkel, utan credentials eller `tenant_id`.
- Centrala providerposter är service-role-skyddade; tenants använder historiserade allokeringar, grants och serverfiltrerade RPC:er.
- Historiska samtal sparar snapshots och får inte ändra tenant vid framtida resursflytt.
- `SECURITY DEFINER` ska ha låst `search_path` och explicita execute-grants.
- Ändra aldrig en levererad migration; lägg en ny framåtriktad migration.
- Kör `node scripts/verify-sql.mjs` efter migrationsändringar.

Live `db push` och typgenerering är `NOT RUN`.
