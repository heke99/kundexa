# Synk och deployment

## Synka ändrings-ZIP till befintligt projekt

ZIP-filen har projektroten som arkivrot och ska extraheras till en temporär katalog innan `rsync`.

```bash
cd /Users/hekmath/Downloads
rm -rf kundexa-changes
mkdir -p kundexa-changes
unzip -o kundexa-changes.zip -d kundexa-changes

rsync -av --checksum --itemize-changes \
  /Users/hekmath/Downloads/kundexa-changes/ \
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
  SINCH_APPLICATION_KEY='REDACTED' \
  SINCH_APPLICATION_SECRET='REDACTED' \
  SMS_SERVICE_PLAN_ID='REDACTED' \
  SMS_API_TOKEN='REDACTED' \
  SMS_REGION='eu' \
  CRON_SECRET='REDACTED'
```

Sätt motsvarande servervariabler i Vercel. Inga leverantörs- eller service-role-hemligheter får vara `NEXT_PUBLIC_*`. Hela listan står i `docs/integrations/telefoni.md`.

## Deploya Edge Functions

```bash
npm run functions:deploy -- --project-ref PROJECT_REF
```

Kontrollera särskilt att `maintenance-worker` och `process-outbox` deployas. Den förra släpper hängande uppringningsförsök och tappade webbtelefonsessioner; den senare skickar varje avtal, SMS och påminnelse.

## Scheduler

`vercel.json` schemalägger varje Edge-worker via `/api/cron/edge-workers/<worker>`. Vercel skickar `Authorization: Bearer $CRON_SECRET`; route-handlern anropar därefter Edge Function server-to-server med samma hemlighet och skriver en heartbeat.

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

Kör därefter ett riktigt testsamtal. Det får inte markeras verifierat förrän webbtelefonen registrerat sig, destinationen faktiskt ringt, och leverantörens händelser observerats på `/api/webhooks/sinch`.

## Git och Vercel

```bash
git status --short
git add \
  docs \
  scripts \
  src \
  supabase \
  vercel.json
git commit -m "Beskriv ändringen"
git push origin HEAD

npx vercel@latest deploy --prebuilt   # endast om projektets vanliga CI-flöde använder prebuilt
# annars: push till den Vercel-kopplade branchen och låt Vercel bygga normalt
```
