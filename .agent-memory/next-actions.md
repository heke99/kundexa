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

## Efter Rinkel-statuspatch

1. Synka patchfilerna och kör `npm ci && npm run verify` lokalt under Node 22/npm 10.9.2.
2. Kör migration `202607300001_rinkel_telephony_completion.sql` via `npm run db:push` om den inte redan finns i staging/produktion.
3. Sätt webb- och Edge-secrets, spara tenantens API-nyckel i **Integrationer → Rinkel**, testa, synka katalogen och mappa säljaren.
4. Logga in som den mappade säljaren och verifiera att statusen blir `Rinkel redo`.
