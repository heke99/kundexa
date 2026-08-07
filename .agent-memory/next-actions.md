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
