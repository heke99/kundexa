# Leveransmanifest

## Projekt

- Namn: Kundexa
- Typ: multi-tenant SaaS-webbapp
- Databas/backend: Supabase Cloud/PostgreSQL
- Dockerkrav: nej
- Nodekrav: 22+

## Verifieringskommandon

```bash
npm ci
npm run verify
npm audit
```

## Levererade huvudområden

- `src/app` – webbapp, server actions och API-rutter
- `src/components` – UI, API-nycklar och WebRTC-dialer
- `src/lib` – auth, permissions, katalog, validering, crypto och domänlogik
- `supabase/migrations` – 18 ordnade migrationer
- `supabase/functions/process-outbox` – telefoni/SMS/e-post/dokumentworker
- `supabase/functions/automation-runner` – automationsworker
- `supabase/functions/data-worker` – provider-/berikningsworker
- `scripts/verify-sql.mjs` – exekvering av hela migrationskedjan
- `docs` – arkitektur, scope, installation, säkerhet och produktionsgrindar

## Viktig avgränsning

Källkoden och den kanoniska databaskärnan är verifierade. Externa provideravtal, livecredentials, juridik, BankID/NIX-provider, malware scanning, DR-övning, lasttest och penetrationstest är produktionsgrindar och kan inte bekräftas enbart från repositoryt.
