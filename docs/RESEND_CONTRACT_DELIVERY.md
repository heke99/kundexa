# Avtalsutskick, Resend och påminnelser

## Arkitektur

Avtal använder den befintliga `contracts`-domänen. Ett utkast kan finnas utan samtal, men varje initialt utskick kräver ett avslutat och avtalsgrundande `source_call_id`. Regeln körs både i serverkod och i SQL genom `is_contract_call_eligible`, `assert_contract_sendable_v2` och `prepare_contract_delivery_v2`.

Utskicksflödet är:

1. Skapa utkast atomiskt med `create_contract_draft_v3`, inklusive mall, pris, juridiskt bolag, ansvarig, team, datum, kommersiella villkor och föreslagen svarstid.
2. Lås snapshot för aktiv avtalsversion.
3. Generera eller välj en kanonisk PDF i privata bucketen `contract-documents`.
4. Beräkna snapshot-hash och SHA-256 för exakta PDF-bytes.
5. Skapa mottagare och en aktiv acceptbegäran med tokenhash och krypterad token.
6. Skapa en separat `contract_deliveries`-rad per kanal.
7. Skapa `email_messages`/`sms_messages` och idempotenta `outbox_jobs` atomiskt.
8. Schemalägg automatiska påminnelser enligt tenantens policy.
9. Låt `process-outbox` hämta privat PDF, kontrollera tenant, storlek och hash samt skicka till leverantören.
10. Låt signerade Resend-webhooks uppdatera verklig leveransstatus.
11. Vid accept avbryts påminnelser och evidence/confirmation läggs i outbox.

## Anslut Resend

### 1. Resend Dashboard

1. Skapa eller välj ett Resend-konto.
2. Lägg till en dedikerad sändningsdomän, till exempel `utskick.foretag.se`.
3. Lägg in DNS-posterna som Resend visar och vänta tills domänen är verifierad.
4. Skapa en API-nyckel med rätt att skicka e-post.
5. Använd en avsändare på den verifierade domänen, exempelvis `avtal@utskick.foretag.se`.

### 2. Kundexa

1. Öppna `/app/integrations`.
2. Välj `Kundexas Resend-konto` eller `Tenantens eget Resend-konto`.
3. Ange avsändarnamn, verifierad från-adress, reply-to, sändningsdomän och testmottagare.
4. För tenantägt konto: ange API-nyckeln. Nyckeln krypteras och visas aldrig igen.
5. Ange Resends webhook signing secret när webhooken är skapad.
6. Spara. Integrationen får status `pending`, aldrig `active` enbart av att formuläret sparas.
7. Klicka `Testa anslutning`. Först ett lyckat provideranrop sätter status `active`.
8. Kontrollera att feature flags `outbound_email` och `contract_delivery_email` är aktiva.

### 3. Resend-webhook

Kundexa genererar en unik opaque URL:

```text
https://app.kundexa.se/api/webhooks/resend/<TENANTENS_OPAQUE_TOKEN>
```

Skapa webhooken i Resend och aktivera:

- `email.sent`
- `email.delivered`
- `email.opened`
- `email.clicked`
- `email.delivery_delayed`
- `email.bounced`
- `email.complained`
- `email.failed`
- `email.suppressed`

Kopiera signing secret till Kundexa och testa integrationen igen. Route-handlern läser rå body, verifierar `svix-id`, `svix-timestamp` och `svix-signature`, deduplicerar på Svix-ID och litar inte på tenant-ID i payloaden.

## Miljövariabler

### Next.js/Vercel

```env
NEXT_PUBLIC_APP_URL=https://app.kundexa.se
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
KUNDEXA_ENCRYPTION_KEY=
KUNDEXA_WEBHOOK_PEPPER=
CRON_SECRET=
RESEND_API_KEY=
DEFAULT_EMAIL_FROM="Kundexa <avtal@utskick.kundexa.se>"
RESEND_WEBHOOK_SECRET=
```

`RESEND_API_KEY` och `DEFAULT_EMAIL_FROM` behövs bara för plattformshanterad fallback. Tenantägda API-nycklar lagras krypterade i `tenant_integrations`.

### Supabase Edge Functions

```env
APP_URL=https://app.kundexa.se
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
KUNDEXA_ENCRYPTION_KEY=
CRON_SECRET=
RESEND_API_KEY=
DEFAULT_EMAIL_FROM="Kundexa <avtal@utskick.kundexa.se>"
```

`KUNDEXA_ENCRYPTION_KEY` måste vara identisk i webbappen och Edge Functions.

Sätt secrets:

```bash
npx supabase@2.109.1 secrets set \
  APP_URL="https://app.kundexa.se" \
  KUNDEXA_ENCRYPTION_KEY="<SAMMA_SOM_WEBBAPPEN>" \
  CRON_SECRET="<LÅNG_SLUMPMÄSSIG_HEMLIGHET>" \
  RESEND_API_KEY="<PLATTFORMSNYCKEL_OM_GLOBAL_FALLBACK_ANVÄNDS>" \
  DEFAULT_EMAIL_FROM="Kundexa <avtal@utskick.kundexa.se>" \
  --project-ref "<SUPABASE_PROJECT_REF>"
```

## Migrationer och typer

Lokalt, aldrig mot produktion med reset:

```bash
npm ci
npx supabase@2.109.1 db reset
npm run types:generate
npm run verify
```

Mot länkat staging-/produktionsprojekt efter backup och granskning:

```bash
npx supabase@2.109.1 link --project-ref "<SUPABASE_PROJECT_REF>"
npx supabase@2.109.1 db push
npm run types:generate
```

## Deploy av Edge Functions

```bash
npm run functions:deploy -- --project-ref "<SUPABASE_PROJECT_REF>"
```

Deployscriptet inkluderar `process-outbox`.

## Scheduler

`vercel.json` anropar `/api/cron/process-outbox` varje minut. Vercel skickar `Authorization: Bearer $CRON_SECRET`; Next-route:n kontrollerar hemligheten och anropar sedan Edge Function med `x-cron-secret`. Edge Function:

- enqueuar förfallna reminders,
- claimar jobb atomiskt,
- förhindrar dubbla samtidiga utskick,
- använder exponentiell backoff,
- dead-letter-markerar permanenta fel.

Verifiera efter deploy:

```bash
curl -i \
  -H "Authorization: Bearer $CRON_SECRET" \
  https://app.kundexa.se/api/cron/process-outbox
```

Ett alternativ är Supabase `pg_cron`/`pg_net`, men kör aldrig två schedulers samtidigt.

## API

Alla write-anrop kräver API-scope, aktiv medlemskap för API-nyckelns skapare, fortsatt rollbehörighet och `idempotency_key`. Alla avtals-API-svar innehåller `x-correlation-id`; ett giltigt inkommande `x-correlation-id` eller `x-request-id` återanvänds annars skapas ett nytt UUID.

```text
POST /api/v1/contracts
GET  /api/v1/contracts
GET  /api/v1/contracts/:id
POST /api/v1/contracts/:id/send
POST /api/v1/contracts/:id/reminders
POST /api/v1/contracts/:id/extend-expiry  (`contracts:manage_expiry`)
GET  /api/v1/contracts/:id/deliveries
GET  /api/v1/contracts/:id/events
POST /api/v1/integrations/resend/test
```

Exempel, skapa utkast:

```json
{
  "customer_id": "uuid",
  "source_call_id": "uuid",
  "template_version_id": "uuid",
  "legal_entity_id": "uuid",
  "product_id": "uuid-or-null",
  "title": "Avtalstitel",
  "idempotency_key": "crm-order-123-contract"
}
```

Exempel, skicka:

```json
{
  "channel": "email",
  "expires_at": "2026-08-05T16:00:00.000Z",
  "introduction": "Tack för ett bra samtal.",
  "idempotency_key": "crm-order-123-initial-email"
}
```

Ett påhittat, cross-tenant, fel kundbundet, obesvarat, oavslutat eller icke avtalsgrundande `source_call_id` stoppas i databasen.

## Driftkontroller

- Status `sent` betyder att Resend accepterat anropet; `delivered` kommer endast från webhook.
- Bounce, complaint och suppression stoppar framtida automatiska e-postpåminnelser.
- Bilagor i `email_messages` är dokumentreferenser, aldrig klientstyrd base64.
- Workern stoppar utskick om PDF-bytes, storlek eller SHA-256 inte matchar dokumentraden.
- Maximal PDF-storlek är 20 MB.
- Storage paths exponeras aldrig för kund eller vanlig API-klient.
