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
DEFAULT_EMAIL_FROM=no-reply@dindomän.se
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
npm run types:generate
```

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

Deployskriptet publicerar sex funktioner:

```text
process-outbox
automation-runner
data-worker
ingestion-worker
maintenance-worker
compliance-worker
```

Funktionerna deployas med `--no-verify-jwt` för scheduleranrop, men varje request kräver korrekt `x-cron-secret`.

## Scheduler

Anropa med `POST` och headern `x-cron-secret`:

```text
/functions/v1/process-outbox      varje minut
/functions/v1/automation-runner  varje minut
/functions/v1/data-worker        varje minut
/functions/v1/ingestion-worker   varje minut
/functions/v1/compliance-worker  varje minut
/functions/v1/maintenance-worker varje timme
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

## 46elks callbacks

Registrera callbacktoken per tenant/nummer och konfigurera 46elks mot URL:erna i webbappen. Aktivera IP-allowlist först efter att aktuella nät verifierats bakom rätt proxy.
