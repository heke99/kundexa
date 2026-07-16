# Kundexa

Kundexa är en multi-tenant webbplattform för CRM, prospektering, telefoni, SMS, e-post, kampanjer, avtal, acceptbevis, automationer, rapportering och integrations-API.

Detta repository innehåller en **webbapp**, inte en mobilapp. Normal utveckling och produktion använder **Supabase Cloud**; Docker krävs inte.

## Teknisk grund

- Next.js 16 + React 19 + TypeScript
- Supabase Auth, PostgreSQL, Row Level Security, Storage och Edge Functions
- 46elks-adapter för telefoni, SMS, inkommande callbacks och WebRTC/SIP-konfiguration
- Resend-adapter för tenantbrandad e-post
- Transaktionell outbox, idempotens, återförsök och dead-letter-status
- Atomiska avtals-, accept-, import- och automationsflöden i PostgreSQL
- OpenAPI 3.1 på `/api/openapi.json`

## Snabbstart med Supabase Cloud

### 1. Krav

- Node.js 20.9 eller senare
- npm 10 eller senare
- Ett tomt Supabase Cloud-projekt
- Supabase CLI via `npx` – ingen global installation krävs

### 2. Installera

```bash
unzip kundexa-full.zip
cd kundexa
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

Migrationerna skapar hela databasen, RLS, Storage-buckets, atomiska PostgreSQL-funktioner, audit, outbox, automationer och webhookrouting.

### 4. Lägg Edge Function-hemligheter i Supabase

```bash
npx supabase@2.109.1 secrets set \
  KUNDEXA_ENCRYPTION_KEY="DIN_KRYTERINGSNYCKEL" \
  APP_URL="https://din-kundexa-domän.se" \
  CRON_SECRET="DIN_CRON_SECRET" \
  RESEND_API_KEY="VALFRI_GLOBAL_RESEND_KEY" \
  DEFAULT_EMAIL_FROM="no-reply@din-domän.se" \
  --project-ref DIN_PROJECT_REF
```

Deploya workers:

```bash
npm run functions:deploy -- --project-ref DIN_PROJECT_REF
```

Anropa båda funktionerna minst en gång per minut från Supabase Cron eller en annan betrodd scheduler:

```text
POST https://DIN_PROJECT_REF.supabase.co/functions/v1/process-outbox
POST https://DIN_PROJECT_REF.supabase.co/functions/v1/automation-runner
Header: x-cron-secret: DIN_CRON_SECRET
```

### 5. Verifiera och starta webbappen

```bash
npm run typecheck
npm test
npm run build
npm run dev
```

Öppna `http://localhost:3000/register`, skapa första användaren och följ onboarding för att skapa den första tenanten.

## Synk efter nya filer eller migrationer

```bash
cd kundexa
npm ci
npm run supabase:link -- --project-ref DIN_PROJECT_REF
npm run db:push
npm run types:generate
npm run functions:deploy -- --project-ref DIN_PROJECT_REF
npm run verify
```

## Huvudflöden som ingår

- Tenant, medlemskap, roller, team och databasbaserad RLS
- Kundregister, företag, prospekt, aktiviteter, anteckningar och kundhistorik
- CSV-simulering, normalisering, deduplicering, spärrkontroll, genomförande och mjuk återställning
- Produkter, versionshanterade priser, kampanjer, pipeline och rapporter
- WebRTC-dialer, samtalskö, samtalsresultat, inkommande/utgående 46elks-callbacks och inspelningshämtning
- SMS- och e-postköer med provider-ID, leveransstatus, kostnad och tenantbranding
- Avtalsutkast, låsta versioner, PDF-lagring, SMS/e-postutskick och exakta acceptfraser
- B2C-kontroll att telefonförsäljningssamtalet avslutats före skriftlig accept
- Accepterad avtalskopia, JSON-manifest, evidence-PDF, SHA-256 och bekräftelseutskick
- Adminstyrda automationer med testläge, godkännande, fördröjning, idempotens, loopskydd och dead letter
- Hashade API-nycklar, scopes, rate limits, audit och signerade utgående webhooks

## Viktigt före produktion

Koden är en körbar och byggverifierad produktgrund. Externa och juridiska produktionsgrindar måste fortfarande slutföras, bland annat avtal med 46elks och dataleverantörer, verifierade e-postdomäner, juridisk granskning av B2C-mallar, BankID/e-signleverantör där det krävs, antivirus för uppladdningar, backup/DR-test och penetrationstest. Se [Produktionsgrindar](docs/PRODUCTION_GATES.md).

## Dokumentation

- [Fastställda krav](docs/PRODUCT_REQUIREMENTS.md)
- [Systemarkitektur](docs/ARCHITECTURE.md)
- [Supabase-installation](docs/SUPABASE_SETUP.md)
- [Synk och deployment](docs/SYNC_AND_DEPLOY.md)
- [Säkerhet](docs/SECURITY.md)
- [Implementerad omfattning](docs/IMPLEMENTED_SCOPE.md)
- [Produktionsgrindar](docs/PRODUCTION_GATES.md)
- [Leveransmanifest](DELIVERY-MANIFEST.md)
