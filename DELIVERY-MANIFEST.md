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

- `src/app` – webbapp, adminflöden och versionerat REST-API
- `src/components` – UI, katalog, importer, API-nycklar och WebRTC-dialer
- `src/lib` – auth, permissions, importparsers, malware-scan-gate, katalog, validering, crypto och domänlogik
- `supabase/migrations` – 22 ordnade migrationer
- `supabase/functions/process-outbox` – telefoni/SMS/e-post/dokument
- `supabase/functions/automation-runner` – automationer
- `supabase/functions/data-worker` – entitetsberikning
- `supabase/functions/ingestion-worker` – discovery/crawl/ingestion
- `supabase/functions/maintenance-worker` – segment, retention och geografi
- `supabase/functions/compliance-worker` – NIX-kontroller och kampanjresume
- `scripts/verify-sql.mjs` – migrations- och runtime-RPC-verifiering
- `scripts/import-geography.mjs` – versionsstyrd import av geografiskt referensregister
- `docs` – arkitektur, scope, installation, säkerhet, synk och produktionsgrindar

## Verifierad databasinventering

PGlite-kontrollen exekverar 22 migrationer och inventerar 123 publika tabeller, 183 publika funktioner och 249 RLS-policyer. Slutlig stagingverifiering i riktig Supabase krävs ändå före produktion.

## Viktig avgränsning

Källkoden och den kanoniska databaskärnan är verifierade. Liveavtal, credentials, officiella leverantörsformat, NIX-/geografidata, skarp malware-scanner, juridik, DR-övning, lasttest och penetrationstest är externa produktionsgrindar.
