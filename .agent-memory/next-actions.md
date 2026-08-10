# Next actions

Uppdaterad 2026-08-07. De lokala stegen 1–5 i förra listan är klara; det som återstår kräver riktig
infrastruktur.

1. Länka en separat Kundexa Supabase staging och kör `npm run db:push` för de tre nya
   migrationerna (`202608070001`–`202608070003`).
2. Kör `npm run types:generate` mot staging och checka in resultatet. Driftkontrollen i
   `verify-sql.mjs` säger exakt vilka namn som skiljer sig om något ändrats.
3. Verifiera FAILURE-0012 mot staging: kör en ParseHub-import med `automatic_commit` och
   bekräfta att den committar i stället för att avbryta på `execution_idempotency_key_required`.
4. Bekräfta att maintenance-workern anropar `prune_rate_limit_counters` i den deployade
   miljön och att `rate_limit_counters` slutar växa.
5. Mät planerna för de nya `updated_at`-indexen mot produktionslik datavolym (`EXPLAIN ANALYZE`
   på kundlistan och avtalstavlan) och bekräfta att sorteringen använder index.
6. Sätt centrala Rinkel-secrets i Vercel och Supabase Edge Secrets; deploya samtliga Edge
   Functions.
7. Synka/allokera Rinkel user/device/number och registrera de fem webhookarna.
8. Kör stagingprotokollet för dial, inkommande, webhookordning/dublett, CDR, recording,
   transcript och Insights.
9. Kör tvåtenant-RLS/recording access med riktiga JWT-sessioner.
10. Godkänn juridik, retention, backup/restore, last och extern säkerhet före produktion.

## 2026-08-08 — deployordning för remediation

1. Applicera forward-only migration `202608080001_cross_surface_consistency_remediation.sql` på staging.
2. Kör `npm ci`, `npm run types:verify` och därefter hela `npm run verify` på Node 22 med Deno installerat.
3. Kör tvåtenant JWT/RLS-proven särskilt för `/app/platform` och `/app/platform/lists` med
   owner/admin/support/auditor.
4. Sätt/verifiera `RINKEL_API_KEY` i webbruntime och worker-runtime, synka katalogen och kontrollera
   `GET /api/v1/telephony/status` tills `runtimeConfigured=true` och inga blockers återstår.
5. Genomför ett verkligt utgående Rinkel-samtal och verifiera call attempt -> webhook -> CDR -> recording.
6. Genomför Resend bounce/complaint replay och 46elks SMS delivery/reconciliation på staging.
7. Välj och implementera konkret BankID/e-sign-provider om högre assurance än simple acceptance krävs.

## 2026-08-08 — immediate database follow-up

1. Sync `202608080002_database_lint_runtime_hardening.sql` into the repo and dry-run `db push`.
2. Confirm dry-run lists only `202608080002`, then push it.
3. Run `npm run types:generate && npm run verify`.
4. Run hosted DB lint again and confirm no Kundexa-owned function errors remain.
5. Treat PostGIS extension-owned diagnostics separately from the application lint gate.

## 2026-08-08 — platform auth deployment

1. Overlay the platform-auth patch on the current repo and run `npm ci && npm run verify` in the normal Node 22/Deno environment.
2. No database migration is required for this patch; existing platform RLS/RPC contracts are reused.
3. Deploy the web app, sign out/in as `platform_owner`, and test `/app/platform` plus `/app/platform/telephony` with no active tenant requirement.
4. Test switching from the platform shell into an existing active tenant and back to the platform control-plane.
5. Run owner/admin/auditor/support negative authorization checks before live Rinkel provider testing.

## 2026-08-10 — Rinkel device mapping rollout

1. Dry-run the linked Supabase push and confirm only the new forward-only device hardening migration is pending.
2. Apply the migration, run `npm run types:generate`, then run the complete `npm run verify` in the normal project environment.
3. Deploy the web code, open `/app/platform/telephony`, and run `Synkronisera katalog`.
4. Confirm the intended Rinkel user shows one or more active devices before allocating that user to a tenant.
5. Open the tenant `/app/integrations`; map Kundexa seller -> allocated Rinkel user -> active device -> allocated number.
6. Make one real manual `/dial` call. If provider responds `Device or number not found`, inspect the synchronized provider ids rather than changing ids manually.
