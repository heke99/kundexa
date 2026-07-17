# Verifieringsrapport – 2026-07-16

## Genomförda kontroller

- Ren `npm ci` från `package-lock.json`
- Next/React TypeScript: `tsc --noEmit`
- Samtliga Supabase Edge Functions: `deno check`
- Statiska arkitektur-, licens-, RLS- och säkerhetsinvarianter: `node scripts/verify.mjs`
- Exekvering av samtliga SQL-migrationer: `node scripts/verify-sql.mjs`
- Runtime-RPC-flöden för scheduler, raw-before-parse, resolver, licensprojektion, geografi, segment, import, NIX, DSAR och retention
- Next.js 16 produktionsbuild med Turbopack
- `npm audit`
- Secretsökning och kontroll av `SECURITY DEFINER`/`search_path`

## Resultat

- 23 migrationer exekverade i ordning utan SQL-fel i PostgreSQL-kompatibel PGlite
- 125 publika tabeller
- 186 publika funktioner
- 251 RLS-policyer
- Web TypeScript: godkänd
- Edge Functions/Deno: godkänd
- Produktionsbuild: godkänd
- Runtimeflöde: godkänt för ingestion, katalog, licensseparation, segment, säker import, NIX-kampanjresume, DSAR och retention
- `npm audit`: 0 kända sårbarheter i installerat dependencyträd

PGlite kan inte fullständigt efterlikna alla Supabase extensions och nätverksintegrationer. Slutlig `db push`, genererade typer och liveintegrationer ska därför verifieras i riktig Supabase staging före produktion.

## Externa avgränsningar

Följande kan inte verifieras från repositoryt ensamt: livecredentials, leverantörsavtal, faktiska provider-/callbackpayloads, NIX-källa, officiellt geografiregister, scannerendpoint, e-post-DNS, juridiskt godkännande, backup/restore, lasttest och externt penetrationstest.
