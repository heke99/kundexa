# Integrations

| Integration | Användning | Status |
|---|---|---|
| Supabase | Auth, PostgreSQL, RLS, Storage, Realtime, Edge Functions | Lokal struktur verifierad; liveprojekt `NOT RUN` |
| Sinch | Telefoni (In-App Calling som webbtelefon) och SMS | Kod/SQL PASS; livesamtal och SMS `NOT RUN` |
| Resend | E-post via outbox | Adapter finns; domän/live `NOT RUN` |
| ParseHub | Discovery/import | Worker finns; live `NOT RUN` |
| NIX-provider | Compliance före kontakt | Adapter/queue finns; live `NOT RUN` |

Rinkel och 46elks är borta: ur källkoden, ur schemat och ur driftdokumentationen.
`scripts/verify.mjs` fäller bygget om något av namnen dyker upp igen, och kontrollerar
dessutom att de genererade typerna — som läses ur det levande projektet — är fria från dem.

Leverantörens namn får stå på exakt fem ställen, alla uppräknade i
`docs/integrations/telefoni.md`. Allt annat talar om "en telefonitjänst" och "ett SMS".
Ett byte är därför en ny adapter plus en rad i ett register; databasen rörs inte.

Tenants lagrar inga telefonicredentials. Ett företag som har eget SMS-avtal kan lägga in
sina nycklar under Integrationer; de krypteras innan de lämnar servern.
