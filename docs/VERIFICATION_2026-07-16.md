# Verifieringsrapport – 2026-07-16

## Genomförda kontroller

- Ren `npm ci` från `package-lock.json`
- Next/React TypeScript: `tsc --noEmit`
- Supabase Edge Functions: `deno check`
- Statiska arkitektur- och säkerhetsinvarianter: `node scripts/verify.mjs`
- Exekvering av samtliga SQL-migrationer: `node scripts/verify-sql.mjs`
- Next.js 16 produktionsbuild med Turbopack
- `npm audit`
- `git diff --check`
- Enkel secretsökning och kontroll av `SECURITY DEFINER`/`search_path`

## Resultat

- 18 migrationer exekverade utan SQL-fel i PostgreSQL-kompatibel PGlite-motor
- 108 publika tabeller
- 140 publika funktioner
- 220 RLS-policyer
- Web TypeScript: godkänd
- Edge Functions/Deno: godkänd
- Produktionsbuild: godkänd
- npm audit: 0 kända sårbarheter i installerat dependencyträd
- Diff whitespace: godkänd

PGlite-testet hoppar över själva `CREATE EXTENSION pgcrypto` eftersom PGlite saknar Supabases extension control-filer. Migrationernas övriga SQL körs. Slutlig `db push` ska fortfarande köras mot en riktig Supabase stagingmiljö före produktion.

## Avgränsningar

Följande kan inte verifieras från källkoden ensam: livecredentials, leverantörsavtal, faktiska callbackpayloads, NIX-/BankID-provider, e-postdomänens DNS, juridiskt godkännande, backup/restore, malware scanning, lasttest och externt penetrationstest.
