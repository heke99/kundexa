# Current state

Datum: 2026-07-30

## Kodstatus

- 37 migrationer.
- 157 publika tabeller, 270 publika funktioner och 292 RLS-policies i PGlite-verifieringen.
- Rinkel är enda exekverbara voice-provider; 46elks används endast för SMS.
- Utgående Rinkel-samtal reserveras atomiskt mot kanoniska `calls`, låser säljare/enhet, korreleras av webhookar och avslutas med transaktionellt efterarbete.
- Inspelning, transkript, Insights, retention, reconciliation, tenantmappning och capability-status är kopplade till samma kanoniska samtalsmodell.
- Rinkel-tabellernas RLS och kolumnprivilegier begränsar providerdata efter roll, team, användare och kanonisk samtalsåtkomst.
- Dialerns Rinkel-status läses tenantverifierat server-side; säljarens adminbegränsade integrations-RLS maskeras inte längre som en saknad anslutning.
- `npm run verify` passerar lokalt: Edge Function-kontroll, Rinkel-/kontrakt-/importtester, statiska invarianter, 37 exekverade migrationer, SQL-runtime, TypeScript och Next.js-produktionsbuild.

## Produktionsstatus

`NOT READY`. Ingen känd lokalt reproducerbar P0 återstår och hela lokala gaten är grön, men produktionsgodkännande saknas. Live Supabase, riktiga tenant-/JWT-/RLS-sessioner, Rinkel-samtal/webhookar, övriga providers, juridik, säkerhet, återställning och belastning är inte verifierade.

## Källstatus

Leveransen kom som zip utan `.git`; branch/commit/remote är `UNVERIFIED`.
