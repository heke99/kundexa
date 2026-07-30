# Next actions

Gör i denna ordning:

1. Kör hela `npm run verify` under Node 22.x/npm 10.9.2.
2. Länka en tom Supabase stagingmiljö och kör alla 37 migrationer.
3. Generera `src/types/database.types.ts` från staging och kör verifieringen igen.
4. Kör tvåtenant-/rolltester med riktiga JWT-sessioner samt privata Storage-buckets.
5. Deploya Edge Functions och verifiera scheduler, retry, dead-letter, idempotens, reconciliation och retention.
6. Konfigurera testcredentials och verifiera Rinkel dial/webhook/inspelning/transkript/Insights, 46elks SMS, Resend, ParseHub, NIX och malware-scanner end-to-end.
7. Genomför backup/restore, load, browser/a11y, SAST/DAST och extern pentest.
8. Stäng juridik-/dataskyddsgrindar innan kundtrafik.

Kommandon:

```bash
npm ci
npm run verify
npm run supabase:login
npm run supabase:link -- --project-ref <SUPABASE_PROJECT_REF>
npm run db:push
SUPABASE_PROJECT_REF=<SUPABASE_PROJECT_REF> npm run types:generate
npm run functions:deploy -- --project-ref <SUPABASE_PROJECT_REF>
npm run verify
```
