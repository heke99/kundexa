# Synk och deployment

## Synka ändrings-ZIP till befintligt projekt

ZIP-filen har projektroten som arkivrot och ska extraheras till en temporär katalog innan `rsync`.

```bash
cd /Users/hekmath/Downloads
rm -rf kundexa-rinkel-production-hardening-changes
mkdir -p kundexa-rinkel-production-hardening-changes
unzip -o kundexa-rinkel-production-hardening-changes.zip -d kundexa-rinkel-production-hardening-changes

rsync -av --checksum --itemize-changes \
  /Users/hekmath/Downloads/kundexa-rinkel-production-hardening-changes/ \
  /Users/hekmath/Desktop/Projects/kundexa/
```

Ändringsarkivet innehåller inte `node_modules`, `.next`, `.git`, `.env*` eller hemligheter.

## Installera

```bash
cd /Users/hekmath/Desktop/Projects/kundexa
node --version   # Node 22+
npm ci
```

## Koppla Supabase och migrera staging

```bash
npm run supabase:login
npm run supabase:link -- --project-ref PROJECT_REF
npx supabase@2.109.1 migration list
npm run db:push
SUPABASE_PROJECT_REF=PROJECT_REF npm run types:generate
npm run types:verify
```

Genererade typer ska komma från den migrerade stagingdatabasen. Handredigera inte `src/lib/supabase/database.types.ts`.

## Sätt Edge Secrets

```bash
npx supabase@2.109.1 secrets set --project-ref PROJECT_REF \
  RINKEL_API_KEY='REDACTED' \
  RINKEL_API_BASE_URL='https://api.rinkel.com/v1' \
  RINKEL_WEBHOOK_PUBLIC_BASE_URL='https://STAGING_DOMAIN' \
  RINKEL_WEBHOOK_SECRET='REDACTED_HIGH_ENTROPY_SECRET' \
  RINKEL_WEBHOOK_ALLOWED_IPS='82.199.77.220,188.122.73.177' \
  RINKEL_REQUEST_TIMEOUT_MS='15000' \
  RINKEL_ENFORCE_WEBHOOK_IP_ALLOWLIST='true' \
  RINKEL_TRUST_X_REAL_IP='false' \
  RINKEL_RECONCILIATION_ENABLED='true' \
  CRON_SECRET='REDACTED'
```

Sätt motsvarande servervariabler i Vercel. Inga Rinkel-/service-role-hemligheter får vara `NEXT_PUBLIC_*`.

## Deploya Edge Functions

```bash
npm run functions:deploy -- --project-ref PROJECT_REF
```

Kontrollera särskilt att `rinkel-platform-worker`, `maintenance-worker` och `process-outbox` deployas.

## Scheduler

`vercel.json` kör `/api/cron/rinkel-platform-worker` varje minut. Vercel skickar `Authorization: Bearer $CRON_SECRET`; route-handlern anropar därefter Edge Function server-to-server med samma hemlighet.

Befintlig scheduler ska även fortsätta anropa:

```text
/functions/v1/process-outbox
/functions/v1/maintenance-worker
```

## Verifiera

```bash
npm run lint
npm run typecheck
npm run typecheck:edge
npm run test
npm run build
npm run verify

npx supabase@2.109.1 migration list
npx supabase@2.109.1 db lint --linked
```

Kör därefter det manuella liveprotokollet i `docs/RINKEL_STAGING_PROTOCOL.md`. Ett riktigt testsamtal får inte markeras verifierat förrän Rinkel-device, destination, webhookkedja och CDR faktiskt har observerats.

## Git och Vercel

```bash
git status --short
git add \
  docs \
  scripts \
  src \
  supabase \
  vercel.json
git commit -m "Harden central Rinkel dialer lifecycle"
git push origin HEAD

npx vercel@latest deploy --prebuilt   # endast om projektets vanliga CI-flöde använder prebuilt
# annars: push till den Vercel-kopplade branchen och låt Vercel bygga normalt
```
