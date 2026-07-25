# Integrations

| Integration | Användning | Status |
|---|---|---|
| Supabase | Auth, PostgreSQL, RLS, Storage, Realtime, Edge Functions | Lokal struktur verifierad; liveprojekt `NOT RUN` |
| 46elks | Telefoni, SMS, WebRTC/callbacks | Adapter finns; livecredentials/callbacks `NOT RUN` |
| Resend | E-post via outbox | Adapter finns; domän/SPF/DKIM/DMARC `NOT RUN` |
| ParseHub | Primär discovery/importväg | Worker/profiler finns; liveprojekt/webhook `NOT RUN` |
| NIX-provider | Compliance före kontakt | Adapter/queue finns; live mapping/TTL `NOT RUN` |
| Extern malware-scanner | Importskanning | Konfigurationsyta finns; skarp scanner `NOT RUN` |
| Geografikälla | Kommun/län/post/geokodning | Importverktyg finns; officiell aktuell dataset `NOT RUN` |
| E-sign/BankID | Avtal/signering när stark identitet krävs | Leverantörsval `BLOCKED` |

Hemligheter ska endast ligga i server-/Edge Function-miljö. Direkt legacy-scraping är avstängt om inte en godkänd fallback uttryckligen aktiveras.
