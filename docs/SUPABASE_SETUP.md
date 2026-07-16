# Supabase Cloud-installation

Docker krävs inte. Skapa ett nytt Supabase Cloud-projekt och använd CLI-kommandona från projektroten.

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

Service-role-nyckeln får endast finnas i servermiljö och Supabase Edge Function secrets. Den får aldrig exponeras som `NEXT_PUBLIC_*`.

## Databas

```bash
npx supabase@2.109.1 login
npx supabase@2.109.1 link --project-ref PROJECT_REF
npx supabase@2.109.1 db push
npx supabase@2.109.1 gen types typescript --linked > src/lib/supabase/database.types.ts
```

Databasversionen består av ordnade migrationer i `supabase/migrations`. Ändra inte redan körda migrationer i en produktionsmiljö; skapa en ny tidsstämplad migration.

## Auth

I Supabase Dashboard:

1. Sätt Site URL till den riktiga Kundexa-domänen.
2. Lägg till `/auth/callback` som redirect URL för lokal och produktionsdomän.
3. Konfigurera SMTP för inbjudningar och auth-mail.
4. Slå på MFA-policy när pilotflödet är verifierat.
5. Begränsa eller stäng publik signup när organisationerna ska provisioneras kontrollerat.

## Storage

Migrationerna skapar privata buckets:

- `contract-documents`
- `call-recordings`
- `imports`

Alla paths börjar med tenant-ID. Åtkomst sker genom RLS eller tidsbegränsad signerad URL.

## Edge Functions

```bash
npx supabase@2.109.1 functions deploy process-outbox --no-verify-jwt --project-ref PROJECT_REF
npx supabase@2.109.1 functions deploy automation-runner --no-verify-jwt --project-ref PROJECT_REF
```

Funktionerna saknar JWT-verifiering eftersom de anropas av scheduler, men varje anrop måste ha korrekt `x-cron-secret`. Använd en lång slumpad secret och rotera den vid misstanke om läckage.

## 46elks callbacks

När ett nummer registreras i webbappen visas en callback-token en gång. Konfigurera numret mot:

```text
SMS inbound:  https://APP_URL/api/webhooks/46elks/sms/inbound?token=TOKEN
Voice start:  https://APP_URL/api/webhooks/46elks/voice/start?token=TOKEN
```

Leverans-, hangup- och inspelningscallbacks skapas av systemet per meddelande/samtal.

IP-allowlist är avstängd under initial installation. Före produktion ska aktuella 46elks-nät läggas i `provider_network_allowlists`, applikationen köras bakom en betrodd proxy som sätter klient-IP korrekt och `ENFORCE_46ELKS_IP_ALLOWLIST=true` aktiveras.
