# Database and migrations

Snapshot 2026-07-30:

- 37 ordnade SQL-migrationer i `supabase/migrations`.
- PGlite-verifiering: 157 publika tabeller, 270 publika funktioner och 292 RLS-policies.
- Senaste migrationer:
  - `202607300001_rinkel_telephony_completion.sql`

Regler:

- Ändra aldrig en redan levererad migration; lägg till en ny framåtriktad migration.
- Tenantägda tabeller ska ha `tenant_id`, RLS och testad policy.
- `SECURITY DEFINER` ska ha explicit `search_path` och minsta möjliga `EXECUTE`.
- Tenantparametrar i service-RPC:er måste valideras mot resursernas tenant.
- Providerartefakter ska ärva åtkomst från kanonisk domänresurs; rå providerdata får inte följa generella klientprivilegier.
- En sammansatt FK får inte använda generell `ON DELETE SET NULL` om den skulle nolla en obligatorisk `tenant_id`; använd kolumnspecifik SET NULL eller relänkning.
- Kör `node scripts/verify-sql.mjs` efter varje migrationsändring.

Live `db push` och typgenerering mot ett länkat Supabase-projekt är `NOT RUN`.
