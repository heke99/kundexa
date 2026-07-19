# Kundexa

Kundexa är en responsiv, multi-tenant SaaS-webbplattform för CRM, prospektering, lokal företags- och personkatalog, datainsamling, telefoni, SMS, e-post, kampanjer, avtal, acceptbevis, automationer, compliance, rapportering och integrations-API.

Repositoryt innehåller en körbar webbapplikation för Supabase Cloud. Docker krävs inte för normal utveckling eller deployment.

## Teknisk grund

- Next.js 16, React 19 och TypeScript 5.9
- Supabase Auth, PostgreSQL, RLS, Storage och sex Edge Function-workers
- Central katalog med rådata, source facts, provenance, freshness, identitetsnycklar, konflikter, datakvalitet och materialiserade segment
- Tillståndsstyrd ingestion med paginering, kontrollpunkter, kvoter, retry/dead-letter och parserkarantän
- Discoveryadaptrar för JSON, NDJSON, CSV och uttryckligen tillåten HTML-regex; leverantörsspecifika kontrakt konfigureras separat
- Separat licensstyrning för lagring, lokal filtrering och visning
- Multi-formatimport för CSV, JSON, NDJSON, XML och grundläggande tabulär XLSX med malware-scan-gate
- NIX-adapterram, separat giltighet och automatisk återupptagning av kampanjposter efter godkänd kontroll
- Geografiskt referensregister, kommun/län-normalisering och radiesökning med PostGIS när tillgängligt samt Haversine-fallback
- 46elks-adapter för telefoni, SMS, callbacks och WebRTC/SIP-konfiguration
- Kanonisk prospekterings-/listmotor med säljtilldelning, automatisk sekventiell dialer, manuellt efterarbete, återkomstkö och samtalsbaserad order
- Resend-adapter för tenantbrandad e-post
- Transaktionell outbox, idempotens, atomisk usage-reservation, retry och dead letter
- Versionslåsta avtalsmallar, pris-/juridiksnapshots och manipulationsupptäckande acceptbevis
- DSAR-export/radering, legal hold och retentionworker
- OpenAPI 3.1 på `/api/openapi.json`

## Snabbstart

### Krav

- Node.js 22 eller senare
- npm 10 eller senare
- Ett Supabase Cloud-projekt

### Installera

```bash
npm ci
cp .env.example .env.local
```

Skapa hemligheter:

```bash
openssl rand -base64 48   # KUNDEXA_ENCRYPTION_KEY
openssl rand -hex 48      # KUNDEXA_WEBHOOK_PEPPER
openssl rand -hex 48      # CRON_SECRET
```

### Koppla och migrera Supabase

```bash
npm run supabase:login
npm run supabase:link -- --project-ref DIN_PROJECT_REF
npm run db:push
SUPABASE_PROJECT_REF=DIN_PROJECT_REF npm run types:generate
```

### Deploya workers

```bash
npm run functions:deploy -- --project-ref DIN_PROJECT_REF
```

Schemalägg betrodda anrop med `x-cron-secret` till:

```text
/functions/v1/process-outbox
/functions/v1/automation-runner
/functions/v1/data-worker
/functions/v1/ingestion-worker
/functions/v1/maintenance-worker
/functions/v1/compliance-worker
```

`process-outbox`, `automation-runner`, `data-worker`, `ingestion-worker` och `compliance-worker` kan köras varje minut. `maintenance-worker` kan köras med lägre frekvens, exempelvis varje timme, eftersom den materialiserar segment, synkroniserar dynamiska ringlistor, kör retention och normaliserar geografi.

### Importera geografiskt referensregister

Förbered en JSON- eller NDJSON-fil med officiella kommuner, län, postorter/postnummer och koordinater och kör:

```bash
npm run geography:import -- ./geography.json "SCB" "2026-07"
```

### Verifiera

```bash
npm run verify
npm audit
npm run dev
```

`npm run verify` kör Deno-kontroll av samtliga workers, statiska arkitekturtester, hela migrationskedjan med runtime-RPC-test, TypeScript och en deterministisk Next.js-produktionsbuild med Webpack. Utvecklingsservern kan fortsatt använda Turbopack.

## Implementerade huvudflöden

- Tenant, juridiska bolag, kontor, avdelningar, medlemskap, roller, team, feature-flaggor och RLS
- CRM-kunder, företag, prospekt, kundkort, aktiviteter, listor, kampanjer och pipeline
- Säker multi-formatimport som synkroniserar tenant-CRM och tenantisolerad katalog i samma genomförande
- Lokal katalogsökning med korrekta totalantal, freshnessfördelning, licensprojektion och avancerade filter
- Discovery från tom katalog, femdagarsschema, crawlplan, kontrollpunkt och rådata före parser
- Source facts, masterresolver, fälthistorik, källprioritet, konflikter, identitetsnycklar, dublettförslag och merge/undo
- Dynamiska segment, snapshots, materialisering och policykontrollerad överföring till kampanj eller ringlista
- Providerkonton, tillstånd, cacheomfattning, fältregler, kvoter, parserobservationer och karantän
- NIX-kö, provideradapterram, pre-contact-policy och kampanjresume
- Tilldelade teamlistor, atomiska prospektlås, manuell eller automatisk sekventiell WebRTC-dialer, obligatoriskt efterarbete och 46elks-callbacks
- Personliga/globala återkomster med claim, snooze, omfördelning, realtidsbadge och prioritet före kalla prospekt
- Kanoniska anteckningar med synlighet, fästning, revisionshistorik och arkivering samt order direkt från samtalet
- SMS/e-post med central spärrpolicy, idempotens, usage-reservation och tenantbranding
- Produkter, prisversioner, avtalsmallar, utskick, acceptmanifest, bevis-PDF och SHA-256
- Automationer med testläge, godkännande, loopskydd, retry och dead letter
- Retention, legal hold, DSAR-export och kontrollerad anonymisering med minimal spärrpost
- Hashade API-nycklar, scopes, rate limits, audit och signerade webhooks

## Produktionsgrindar

Koden är en verifierad produktgrund. Skarp drift kräver fortfarande externa avtal, credentials och miljöprov, bland annat livekonfiguration av dataleverantör, NIX-källa, officiellt geografiregister, malware-scanner, 46elks/Resend, juridisk granskning, backup/restore, lasttest och penetrationstest. Se [Produktionsgrindar](docs/PRODUCTION_GATES.md).

## Dokumentation

- [Fastställda krav](docs/PRODUCT_REQUIREMENTS.md)
- [Systemarkitektur](docs/ARCHITECTURE.md)
- [Prospektering, listor, dialer och återkomster](docs/PROSPECTING_LISTS_DIALER.md)
- [Implementerad omfattning](docs/IMPLEMENTED_SCOPE.md)
- [Supabase-installation](docs/SUPABASE_SETUP.md)
- [Plattformsadministration](docs/PLATFORM_ADMINISTRATION.md)
- [Synk och deployment](docs/SYNC_AND_DEPLOY.md)
- [Säkerhet](docs/SECURITY.md)
- [Produktionsgrindar](docs/PRODUCTION_GATES.md)
- [Verifieringsrapport](docs/VERIFICATION_2026-07-19.md)
- [Leveransmanifest](DELIVERY-MANIFEST.md)
