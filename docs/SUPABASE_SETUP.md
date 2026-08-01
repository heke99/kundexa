# Supabase Cloud-installation

Docker krävs inte. Skapa ett Supabase Cloud-projekt och kör kommandona från projektroten.

## Miljövariabler för Next.js

```dotenv
NEXT_PUBLIC_APP_URL=https://app.dindomän.se
NEXT_PUBLIC_SUPABASE_URL=https://PROJECT_REF.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
KUNDEXA_ENCRYPTION_KEY=...
KUNDEXA_WEBHOOK_PEPPER=...
ENFORCE_46ELKS_IP_ALLOWLIST=false
CRON_SECRET=...
RESEND_API_KEY=
DEFAULT_EMAIL_FROM_NAME=Kundexa
DEFAULT_EMAIL_FROM_ADDRESS=no-reply@dindomän.se
IMPORT_SCANNER_URL=https://scanner.internal.example/scan
IMPORT_SCANNER_TOKEN=...
IMPORT_SCANNER_TIMEOUT_MS=20000
REQUIRE_IMPORT_MALWARE_SCAN=true
```

Service-role, scanner-token och krypteringsnycklar får endast finnas i servermiljö och Edge Function secrets.

## Databas

```bash
npm run supabase:login
npm run supabase:link -- --project-ref PROJECT_REF
npm run db:push
SUPABASE_PROJECT_REF=PROJECT_REF npm run types:generate
```

## Plattformsägare

Efter migrationerna skapas den första plattformsägaren genom betrodd SQL enligt `docs/PLATFORM_ADMINISTRATION.md`. Tenantrollen `owner` är inte samma sak som `platform_owner`.

## Auth

1. Sätt Site URL till Kundexa-domänen.
2. Lägg till lokal och produktionsdomän för `/auth/callback`.
3. Konfigurera SMTP för auth-mail.
4. Aktivera MFA-policy för adminroller före produktion.
5. Begränsa publik signup när tenants ska provisioneras kontrollerat.

## Storage

Migrationerna skapar privata buckets för avtalsdokument, inspelningar, importer och compliance-exporter. Paths är tenantbundna och åtkomst sker genom RLS eller tidsbegränsad signerad URL.

## Edge Functions

```bash
npm run functions:deploy -- --project-ref PROJECT_REF
```

Deployskriptet publicerar åtta funktioner:

```text
process-outbox
rinkel-platform-worker
automation-runner
data-worker
ingestion-worker
maintenance-worker
compliance-worker
parsehub-worker
```

Funktionerna deployas med `--no-verify-jwt` för scheduleranrop, men varje request kräver korrekt `x-cron-secret`.

## Scheduler

Anropa med `POST` och headern `x-cron-secret`:

```text
/functions/v1/process-outbox          varje minut
/functions/v1/rinkel-platform-worker varje minut
/functions/v1/automation-runner      varje minut
/functions/v1/data-worker            varje minut
/functions/v1/ingestion-worker       varje minut
/functions/v1/compliance-worker      varje minut
/functions/v1/parsehub-worker        varje minut
/functions/v1/maintenance-worker     varje timme
```

Frekvensen kan sänkas när volymen är låg, men övervaka köålder, retries och dead-letter-status.

## Providerkonfiguration

Datakällor konfigureras i adminvyn. Registrera endast domäner, paths, fält, ändamål, lagrings-/filter-/visningsrätt, cacheomfattning, retention och kvoter som omfattas av dokumenterat tillstånd. Credentials krypteras före lagring.

## NIX

Konfigurera vald NIX-provider i compliancevyn med publik HTTPS-endpoint, tillåtna domäner/paths, credentials, resultatmapping, TTL och retrygräns. Testa både spärrat, ej spärrat och providerfel i staging.

## Geografi

Importera ett versionsstyrt officiellt referensregister:

```bash
npm run geography:import -- ./geography.json "SCB" "2026-07"
```

Filen kan vara JSON eller NDJSON och bör innehålla stabil kod, områdestyp, namn, län/kommun/postuppgifter och koordinater.

## Malware-scanner

I produktion ska `REQUIRE_IMPORT_MALWARE_SCAN=true`. Scanner-endpointen ska returnera ett maskinläsbart rent/infekterat resultat. Importen får inte commitas om scanning saknas, misslyckas eller markerar filen som osäker.

## Telefoni och SMS

Rinkel är enda telefoniprovider. Sätt Kundexas enda centrala `RINKEL_API_KEY` som server-/Edge-secret, synkronisera det centrala användar- och nummerinventariet, allokera resurser till tenants, mappa varje säljare och registrera alla fem centrala webhookevent enligt `docs/integrations/rinkel.md`. Tenants får inte ange eller lagra egna Rinkel-credentials. 46elks används endast för SMS-callbackar; dess äldre voice-endpoints svarar permanent `410 Gone`.
