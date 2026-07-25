# Database and migrations

Snapshot 2026-07-25:

- 32 ordnade SQL-migrationer i `supabase/migrations`.
- PGlite-verifiering: 145 publika tabeller, 246 publika funktioner och 273 RLS-policies.
- Senaste migrationer:
  - `202607250001_platform_allocation_reference_hardening.sql`
  - `202607250002_directory_tenant_boundary_hardening.sql`

Regler:

- Ändra aldrig en redan levererad migration; lägg till en ny framåtriktad migration.
- Tenantägda tabeller ska ha `tenant_id`, RLS och testad policy.
- `SECURITY DEFINER` ska ha explicit `search_path` och minsta möjliga `EXECUTE`.
- Tenantparametrar i service-RPC:er måste valideras mot resursernas tenant.
- En sammansatt FK får inte använda generell `ON DELETE SET NULL` om den skulle nolla en obligatorisk `tenant_id`; använd kolumnspecifik SET NULL eller relänkning.
- Kör `node scripts/verify-sql.mjs` efter varje migrationsändring.

Live `db push` och typgenerering mot ett länkat Supabase-projekt är `NOT RUN`.
