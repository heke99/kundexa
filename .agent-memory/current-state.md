# Current state

Datum: 2026-07-30

## Kodstatus

- 38 ordnade migrationer; den senaste är `202607300002_central_rinkel_platform.sql`.
- 170 publika tabeller, 277 publika funktioner och 297 RLS-policies i PGlite-verifieringen.
- Rinkel är en central plattformsintegration med exakt en logisk server-side `RINKEL_API_KEY`; inga tenantcredentials eller connectionbaserade webhookar är exekverbara.
- Centrala användare och nummer allokeras historiserat till tenants. Grants och `rinkel_user_mappings_v2` begränsar team/säljare och standardnummer.
- Utgående samtal reserveras atomiskt med serverhärledda providerresurser. `POST /dial` körs högst en gång och okänt utfall går till reconciliation.
- Centrala webhookar routar inkommande samtal via nummerallokeringens giltighetstid och placerar tvetydigheter i konfliktkö.
- Rinkel är enda voice-provider; 46elks används endast för SMS och SIP/WebRTC-flöden saknar exekveringsväg.
- `npm run verify` passerar lokalt med Edge-kontroll, tester, 38 migrationer, SQL-runtime, tvåtenant-Rinkeltest, TypeScript och Next.js-build.

## Produktionsstatus

`NOT READY`. Lokal kodgate är grön men riktig central Rinkel-nyckel, live-Supabase/JWT/RLS, alla fem webhookar, riktiga samtal, inspelning/transkript/Insights, Node 22, juridik, backup/restore, belastning och extern säkerhetsgranskning är `NOT RUN`.

## Källstatus

Leveransen kom som zip utan `.git`; branch/commit/remote är `UNVERIFIED`.
