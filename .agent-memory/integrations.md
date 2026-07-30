# Integrations

| Integration | Användning | Status |
|---|---|---|
| Supabase | Auth, PostgreSQL, RLS, Storage, Realtime, Edge Functions | Lokal struktur verifierad; liveprojekt `NOT RUN` |
| Rinkel | En central plattformsintegration för voice, webhookar, recording, transcript och Insights | Kod/SQL PASS; livekonto/samtal `NOT RUN` |
| 46elks | SMS-callbackar | Voice permanent avstängd; SMS live `NOT RUN` |
| Resend | E-post via outbox | Adapter finns; domän/live `NOT RUN` |
| ParseHub | Discovery/import | Worker finns; live `NOT RUN` |
| NIX-provider | Compliance före kontakt | Adapter/queue finns; live `NOT RUN` |

Rinkel använder exakt en logisk `RINKEL_API_KEY` i server-/Edge-miljön. Tenants lagrar inga Rinkel-credentials och får endast centralt allokerade resurser.
