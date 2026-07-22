# Leveransmanifest

## Projekt

- Namn: Kundexa
- Typ: multi-tenant SaaS-webbapp och dialer
- Databas/backend: Supabase Cloud/PostgreSQL
- Dockerkrav: nej
- Nodekrav: `22.x`

## Verifieringskommandon

```bash
npm ci
npm run verify
npm audit
```

## Levererade huvudområden

- `src/app` – webbapp, adminflöden och versionerat REST-API
- `src/components` – UI, katalog, importer, API-nycklar och WebRTC-dialer
- `src/lib` – auth, permissions, importparsers, validering, crypto och domänlogik
- `supabase/migrations` – 30 ordnade migrationer
- `supabase/functions/process-outbox` – telefoni, SMS, e-post och dokument
- `supabase/functions/automation-runner` – automationer
- `supabase/functions/data-worker` – entitetsberikning
- `supabase/functions/ingestion-worker` – discovery, crawl och ingestion
- `supabase/functions/maintenance-worker` – segment, dynamiska ringlistor, retention, geografi och utgångna plattformsallokeringar
- `supabase/functions/compliance-worker` – NIX-kontroller och kampanjresume
- `scripts/verify-sql.mjs` – migrations- och runtime-RPC-verifiering
- `scripts/import-geography.mjs` – versionsstyrd import av geografiskt referensregister
- `scripts/generate-supabase-types.mjs` – atomisk typgenerering
- `/app/platform` – separat, revisionsloggad plattformsadministration
- `/app/platform/lists` – central listbank och tenantdistribution
- `/app/teams` och `/app/users` – auditerad team- och användaradministration
- `docs` – arkitektur, scope, installation, säkerhet, synk och produktionsgrindar

## Leverans 2026-07-22: plattformslistor och tenant/team-flöde

Den nya migrationen `202607220001_platform_list_distribution_and_team_admin.sql` bygger central listimport, tenantallokering, teamuppdelning, teamledaradministration, inbjudningsaktivering, säker tenantväxling, återkallning och automatisk utgång ovanpå Kundexas befintliga kund-, list- och dialermodell.

Detaljer och driftsättningskontroll finns i:

`docs/PLATFORM_LISTS_TENANTS_TEAMS_2026-07-22.md`

## Verifieringsstatus i leveransmiljön

Den statiska projektverifieringen kontrollerar samtliga 30 migrationer, 163 TypeScript/TSX-källfiler och den nya arkitekturen. Runtime-verifiering med PGlite, Deno-kontroll och full Next.js-build kräver en komplett `npm ci`-installation. Paket kunde inte hämtas i leveransmiljön eftersom npm-nätverk/cache saknades. Dessa kommandon ska köras lokalt eller i CI innan produktionsdriftsättning.

## Viktig avgränsning

Källkoden och databaskärnan är förberedda för staging. Liveavtal, credentials, officiella leverantörsformat, NIX-/geografidata, skarp malware-scanner, juridik, DR-övning, lasttest och penetrationstest är externa produktionsgrindar.
