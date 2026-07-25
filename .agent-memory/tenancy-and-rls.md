# Tenancy and RLS

Tenantisolering försvaras i flera lager:

1. Servern härleder aktiv tenant från session eller API-nyckel.
2. Route/action verifierar permission eller scope.
3. Tenantägda tabeller använder RLS.
4. Atomiska RPC:er kontrollerar aktör, roll och resursägarskap.
5. Service-only RPC:er tar explicit tenant och verifierar att alla resurser tillhör den.

Hårda regler:

- Acceptera inte godtyckligt `tenant_id` från webbläsare för `SECURITY DEFINER`.
- Tenantparametrerade katalogprojektioner är endast körbara av `service_role`.
- Autentiserade segment-/kampanjwrappers härleder tenant från aktivt medlemskap.
- Direkt servicekörning använder suffixed `*_for_tenant` och verifierar segment/kampanj/lista.
- Återkallning av plattformslistor får koppla loss list-/kundreferenser men aldrig tappa allokeringspostens `tenant_id`.

Negativa tvåtenanttester finns i `scripts/verify-sql.mjs`. Test mot verklig Supabase/RLS-session är fortfarande `NOT RUN`.
