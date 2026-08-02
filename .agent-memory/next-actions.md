# Next actions

1. Rsynca patchen till Kundexa-projektroten och kontrollera diffen.
2. Kör Node 22.x/npm 10.9.2 och `npm ci` i en miljö med fungerande npm-åtkomst.
3. Länka en separat Kundexa Supabase staging och kör `npm run db:push`.
4. Kör `npm run types:generate` och checka in den verkligt genererade typen; kör `npm run types:verify`.
5. Kör `npm run lint`, `npm run typecheck:edge`, `npm run test`, `npm run build` och `npm run verify`.
6. Sätt centrala Rinkel-secrets i Vercel och Supabase Edge Secrets; deploya samtliga Edge Functions.
7. Synka/allokera Rinkel user/device/number och registrera de fem webhookarna.
8. Kör stagingprotokollet för dial, inkommande, webhookordning/dublett, CDR, recording, transcript och Insights.
9. Kör tvåtenant-RLS/recording access med riktiga JWT-sessioner.
10. Godkänn juridik, retention, backup/restore, last och extern säkerhet före produktion.
