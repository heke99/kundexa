# Kundexa central Rinkel — patchleverans

Denna patch ersätter den exekverbara tenantägda Rinkel-modellen med en enda central plattformsintegration. Komplett arkitektur-, databas-, säkerhets- och verifieringsrapport finns i `RINKEL_DELIVERY.md`.

## Synkronisera patchen

```bash
export KUNDEXA_PROJECT="/Users/hekmath/Desktop/Projects/kundexa"
export KUNDEXA_ZIP="/Users/hekmath/Downloads/kundexa-central-rinkel-platform-completion-2026-07-30.zip"
export KUNDEXA_PATCH_DIR="$(mktemp -d)"

unzip -q "$KUNDEXA_ZIP" -d "$KUNDEXA_PATCH_DIR"
rsync -avh --progress "$KUNDEXA_PATCH_DIR/" "$KUNDEXA_PROJECT/"
rm -f "$KUNDEXA_PROJECT/src/app/api/webhooks/rinkel/[connection]/[secret]/[event]/route.ts"
cd "$KUNDEXA_PROJECT"
```

Rsync-kommandot kopierar innehållet direkt till projektroten och skapar ingen extra projektmapp.

## Installera och verifiera

```bash
cd "/Users/hekmath/Desktop/Projects/kundexa"
nvm install 22
nvm use 22
npm install -g npm@10.9.2
npm ci
npm run verify
```

## Supabase staging

```bash
cd "/Users/hekmath/Desktop/Projects/kundexa"
export SUPABASE_PROJECT_REF="<STAGING_PROJECT_REF>"

npm run supabase:login
npm run supabase:link -- --project-ref "$SUPABASE_PROJECT_REF"
npm run db:push
SUPABASE_PROJECT_REF="$SUPABASE_PROJECT_REF" npm run types:generate
```

Sätt secrets med verkliga värden. `RINKEL_API_KEY` är Kundexas enda centrala nyckel:

```bash
npx supabase@2.109.1 secrets set \
  APP_URL="https://staging.kundexa.se" \
  CRON_SECRET="<LONG_RANDOM_SECRET>" \
  RINKEL_API_KEY="<CENTRAL_RINKEL_API_KEY>" \
  RINKEL_API_BASE_URL="https://api.rinkel.com/v1" \
  RINKEL_WEBHOOK_PUBLIC_BASE_URL="https://staging.kundexa.se" \
  RINKEL_WEBHOOK_SECRET="<AT_LEAST_40_RANDOM_CHARACTERS>" \
  RINKEL_REQUEST_TIMEOUT_MS="15000" \
  RINKEL_ENFORCE_WEBHOOK_IP_ALLOWLIST="true" \
  RINKEL_RECONCILIATION_ENABLED="true" \
  --project-ref "$SUPABASE_PROJECT_REF"

npm run functions:deploy -- --project-ref "$SUPABASE_PROJECT_REF"
npm run verify
```

`functions:deploy` inkluderar den nya `rinkel-platform-worker`.

## Vercel

Sätt samma logiska centrala nyckel och separata webhooksecret via Vercels interaktiva, säkra prompt:

```bash
cd "/Users/hekmath/Desktop/Projects/kundexa"

npx vercel env add RINKEL_API_KEY production
npx vercel env add RINKEL_API_BASE_URL production
npx vercel env add RINKEL_WEBHOOK_PUBLIC_BASE_URL production
npx vercel env add RINKEL_WEBHOOK_SECRET production
npx vercel env add RINKEL_REQUEST_TIMEOUT_MS production
npx vercel env add RINKEL_ENFORCE_WEBHOOK_IP_ALLOWLIST production
npx vercel env add RINKEL_RECONCILIATION_ENABLED production
npx vercel --prod
```

## Efter deploy

1. Öppna `/app/platform/telephony` som plattformssuperadmin.
2. Testa den centrala anslutningen och synkronisera katalogen.
3. Konfigurera de fem centrala webhookarna.
4. Allokera användare och nummer till testtenants.
5. Mappa tenantens säljare och aktivera telefoni­policy.
6. Kör liveacceptansfallen i `RINKEL_DELIVERY.md`.

Produktionsstatus förblir `NOT READY` tills alla externa livegates är godkända.
