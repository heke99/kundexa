# Verification matrix

| Område | Kontroll | Senaste status |
|---|---|---|
| Web TypeScript | `npm run typecheck` | PASS 2026-07-25 |
| Edge Functions | `npm run typecheck:edge` | PASS 2026-07-25 |
| Statiska invarianter | `node scripts/verify.mjs` | PASS 2026-07-25 |
| Importparsers | `npm run test:imports` | PASS 2026-07-25 |
| Migrationer/RPC | `node scripts/verify-sql.mjs` | PASS 2026-07-25 |
| Produktionsbuild | `npm run build` | PASS 2026-07-25 |
| Komplett lokal gate | `npm run verify` | PASS 2026-07-25 |
| Node 22-runtime | samma gate i Node 22.x | NOT RUN i leveransmiljön |
| Live Supabase migrations | `npm run db:push` | NOT RUN |
| Genererade live DB-typer | `npm run types:generate` | NOT RUN |
| RLS/Storage två tenants | riktig Supabase/JWT | NOT RUN |
| 46elks/Resend/ParseHub/NIX | staging E2E | NOT RUN |
| Malware-scanner | ren + infekterad testfil | NOT RUN |
| Backup/restore | dokumenterad RTO/RPO | NOT RUN |
| Last/SAST/DAST/pentest | externa gates | NOT RUN |

Uppdatera matrisen med exakt kommando, datum och resultat; ersätt aldrig `NOT RUN` med antagande.
