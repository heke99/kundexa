# Next actions

1. Kör `npm ci && npm run verify` under Node 22.x/npm 10.9.2.
2. Länka separat Supabase staging och kör alla 38 migrationer.
3. Generera `src/types/database.types.ts` från staging och kör verifieringen igen.
4. Sätt samma logiska `RINKEL_API_KEY` i Vercel och Supabase Edge Secrets, plus separat webhooksecret.
5. Deploya alla Edge Functions inklusive `rinkel-platform-worker`.
6. Som plattformssuperadmin: testa central anslutning, synka katalog, konfigurera webhookar och allokera resurser.
7. Som tenantadmin: mappa allokerad användare/nummer och aktivera telefoni­policy.
8. Kör riktig dial och alla fem webhookevents samt inspelning, transkript, Insights och reconciliation.
9. Kör tvåtenant-/roll-/Storage-test med riktiga JWT-sessioner.
10. Stäng juridik-, backup/restore-, last- och säkerhetsgates före produktion.
