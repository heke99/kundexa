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
- `supabase/migrations` – 32 ordnade migrationer
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

## Hardening 2026-07-25

- Kolumnspecifik FK-nollning och relänkning bevarar tenant/lineage när listor delas eller återkallas.
- Tenantparametrerade katalogprojektioner är endast körbara av `service_role`.
- Segmentrefresh och kampanjmaterialisering har separata authenticated- och explicit tenantvaliderade servicevägar.
- Discovery använder det kanoniska API-scopet `directory:refresh`.
- SQL-verifieringen testar execute-rättigheter och negativa tvåtenantförsök.

## Verifieringsstatus i leveransmiljön

En komplett installation finns i leveransmiljön och `npm run verify` passerade 2026-07-25. PGlite körde samtliga 32 migrationer och rapporterade 145 publika tabeller, 246 publika funktioner och 273 RLS-policies samt de kanoniska runtimeflödena. TypeScript, Deno-kontroll, statiska invarianter, importtester och Next.js-produktionsbuild var gröna. Miljön använder Node 24; samma gate måste därför upprepas under projektets kanoniska Node 22.x/npm 10.9.2 före staging.

## Viktig avgränsning

Källkoden och databaskärnan är förberedda för staging. Liveavtal, credentials, officiella leverantörsformat, NIX-/geografidata, skarp malware-scanner, juridik, DR-övning, lasttest och penetrationstest är externa produktionsgrindar.
