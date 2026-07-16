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
```

Service-role och krypteringsnyckel får endast finnas i servermiljö och Edge Function secrets.

## Databas

```bash
npx supabase@2.109.1 login
npx supabase@2.109.1 link --project-ref PROJECT_REF
npx supabase@2.109.1 db push
npx supabase@2.109.1 gen types typescript --linked > src/lib/supabase/database.types.ts
```

## Auth

1. Sätt Site URL till Kundexa-domänen.
2. Lägg till lokal och produktionsdomän för `/auth/callback`.
3. Konfigurera SMTP för auth-mail.
4. Aktivera MFA-policy för adminroller före produktion.
5. Begränsa publik signup när tenants ska provisioneras kontrollerat.

## Storage

Migrationerna skapar privata buckets för avtalsdokument, samtalsinspelningar och importer. Paths är tenantbundna och åtkomst sker genom RLS eller tidsbegränsad signerad URL.

## Edge Functions

```bash
npm run functions:deploy -- --project-ref PROJECT_REF
```

Funktionerna deployas med `--no-verify-jwt` eftersom scheduler anropar dem, men varje request kräver korrekt `x-cron-secret`.

## Providerkonfiguration

Datakällor konfigureras i adminvyn och sparas atomiskt via `configure_generic_json_provider`. Lägg bara till domäner, paths, fält, lagringsrätt, cacheomfattning och kvoter som omfattas av ett dokumenterat avtal. Providercredentials krypteras innan lagring.

## 46elks callbacks

Registrera callbacktoken per tenant/nummer och konfigurera 46elks mot de URL:er som visas i webbappen. Aktivera IP-allowlist först efter att aktuella nät har verifierats bakom rätt proxy.
