# Kundexa

Kundexa är en responsiv, multi-tenant SaaS-webbplattform för CRM, prospektering, databerikning, telefoni, SMS, e-post, kampanjer, avtal, acceptbevis, automationer, rapportering och integrations-API.

Detta repository innehåller en **webbapp**, inte en native mobilapp. Normal utveckling och produktion använder **Supabase Cloud**; Docker krävs inte.

## Teknisk grund

- Next.js 16, React 19 och TypeScript 5.9
- Supabase Auth, PostgreSQL, Row Level Security, Storage och Edge Functions
- Central katalog med source facts, provenance, freshness, segment och berikningskö
- Generisk JSON-provideradapter med tillstånd, kvoter, domän-/pathkontroll och krypterade credentials
- 46elks-adapter för telefoni, SMS, inkommande callbacks och WebRTC/SIP-konfiguration
- Resend-adapter för tenantbrandad e-post
- Transaktionell outbox, idempotens, atomisk usage-reservation, återförsök och dead-letter-status
- Versionslåsta avtalsmallar, pris-/juridiksnapshots och manipulationsupptäckande acceptbevis
- OpenAPI 3.1 på `/api/openapi.json`

## Snabbstart med Supabase Cloud

### 1. Krav

- Node.js 22 eller senare
- npm 10 eller senare
- Ett Supabase Cloud-projekt
- Supabase CLI via `npx`; ingen global installation krävs

### 2. Installera

```bash
unzip kundexa-main-updated.zip
cd kundexa-main
npm ci
cp .env.example .env.local
```

Skapa hemligheter:

```bash
openssl rand -base64 48   # KUNDEXA_ENCRYPTION_KEY
openssl rand -hex 48      # KUNDEXA_WEBHOOK_PEPPER
openssl rand -hex 48      # CRON_SECRET
```

Fyll i `.env.local` med projektets URL, anon key och service-role key från Supabase.

### 3. Koppla och migrera databasen

```bash
npm run supabase:login
npm run supabase:link -- --project-ref DIN_PROJECT_REF
npm run db:push
npm run types:generate
```

Migrationerna skapar databasmodellen, RLS, privata Storage-buckets, atomiska PostgreSQL-funktioner, audit, outbox, automationer, katalog/berikning, NIX-/spärrmodell och webhookrouting.

### 4. Lägg Edge Function-hemligheter i Supabase

```bash
npx supabase@2.109.1 secrets set \
  KUNDEXA_ENCRYPTION_KEY="DIN_KRYPTERINGSNYCKEL" \
  APP_URL="https://din-kundexa-domän.se" \
  CRON_SECRET="DIN_CRON_SECRET" \
  RESEND_API_KEY="VALFRI_GLOBAL_RESEND_KEY" \
  DEFAULT_EMAIL_FROM="no-reply@din-domän.se" \
  --project-ref DIN_PROJECT_REF
```

Deploya samtliga workers:

```bash
npm run functions:deploy -- --project-ref DIN_PROJECT_REF
```

Anropa funktionerna minst en gång per minut från Supabase Cron eller annan betrodd scheduler:

```text
POST https://DIN_PROJECT_REF.supabase.co/functions/v1/process-outbox
POST https://DIN_PROJECT_REF.supabase.co/functions/v1/automation-runner
POST https://DIN_PROJECT_REF.supabase.co/functions/v1/data-worker
Header: x-cron-secret: DIN_CRON_SECRET
```

### 5. Verifiera och starta webbappen

```bash
npm run verify
npm run dev
```

Öppna `http://localhost:3000/register`, skapa första användaren och följ onboarding.

## Byggverifiering

`npm run build` kör först `tsc --noEmit`. Endast Next 16:s duplicerade interna typkontroll är avstängd eftersom dess worker kan låsa sig i begränsade Linux-byggmiljöer. Typfel stoppar fortfarande alltid builden.

```bash
npm run typecheck
npm run typecheck:edge
npm test
npm run build
```

SQL-testet exekverar samtliga ordnade migrationer i en PostgreSQL-kompatibel PGlite-motor och kontrollerar tabeller, funktioner och RLS-policyer.

## Huvudflöden som ingår

- Tenant, medlemskap, roller, team, juridiska bolag, feature-flaggor och databasbaserad RLS
- Kundregister, företag, prospekt, kundkort, anteckningar, aktiviteter och historik
- CSV-import med preview, normalisering, deduplicering, spärrkontroll, commit och mjuk rollback
- Lokal katalogsökning, source facts, mastervärden, fältprovenance, freshness och segment
- Providerkonton, tillstånd, fältregler, kvoter, parserövervakning och berikningsjobb
- Produkter, versionshanterade priser, kampanjer, pipeline och rapporter
- WebRTC-dialer, samtalskö, samtalsresultat, 46elks-callbacks och inspelningshämtning
- SMS- och e-postköer med central kontaktpolicy, usage-reservation och tenantbranding
- Avtalsutkast från godkänd mallversion, låsta snapshots, PDF-lagring och kanalutskick
- Acceptmanifest, evidence-PDF, SHA-256, bekräftelse och signerad kopia
- Automationer med testläge, godkännande, fördröjning, idempotens, loopskydd och dead letter
- Hashade API-nycklar, scopes, rate limits, audit och signerade webhooks

## Viktigt före produktion

Koden är en verifierad produktgrund, men externa och juridiska produktionsgrindar måste fortfarande slutföras. Det gäller bland annat faktiska 46elks-/dataleverantörsavtal och credentials, NIX-källa, verifierade e-postdomäner, juridisk granskning, BankID/e-signleverantör där stark identitet krävs, malware scanning, backup/restore-övning, lasttest och penetrationstest. Se [Produktionsgrindar](docs/PRODUCTION_GATES.md).

## Dokumentation

- [Fastställda krav](docs/PRODUCT_REQUIREMENTS.md)
- [Systemarkitektur](docs/ARCHITECTURE.md)
- [Implementerad omfattning](docs/IMPLEMENTED_SCOPE.md)
- [Supabase-installation](docs/SUPABASE_SETUP.md)
- [Synk och deployment](docs/SYNC_AND_DEPLOY.md)
- [Säkerhet](docs/SECURITY.md)
- [Produktionsgrindar](docs/PRODUCTION_GATES.md)
- [Verifieringsrapport](docs/VERIFICATION_2026-07-16.md)
- [Leveransmanifest](DELIVERY-MANIFEST.md)
