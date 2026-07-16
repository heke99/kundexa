# Synk och deployment

## Synka patchen till projektet

Kör exakt:

```bash
cd ~/Downloads

rm -rf kundexa-canonical-finalization-2026-07-16-patch

unzip -o kundexa-canonical-finalization-2026-07-16-patch.zip

mkdir -p /Users/hekmath/Desktop/Projects/kundexa

rsync -av --checksum --itemize-changes \
  kundexa-canonical-finalization-2026-07-16-patch/payload/ \
  /Users/hekmath/Desktop/Projects/kundexa/
```

Patchen innehåller inte `node_modules`, `.next`, `.git`, `.env.local` eller hemligheter.

Alternativt:

```bash
cd ~/Downloads/kundexa-canonical-finalization-2026-07-16-patch
./sync-to-project.sh /Users/hekmath/Desktop/Projects/kundexa
```

## Installera och verifiera

```bash
cd /Users/hekmath/Desktop/Projects/kundexa
node --version   # ska vara 22+
npm ci
npm run verify
npm audit
```

## Koppla och migrera Supabase

```bash
npm run supabase:login
npm run supabase:link -- --project-ref PROJECT_REF
npm run db:push
npm run types:generate
```

Ändra aldrig en migration som redan körts i produktion. Skapa alltid en ny tidsstämplad migration.

## Deploya Edge Functions

```bash
npm run functions:deploy -- --project-ref PROJECT_REF
```

Kommandot deployar alla sex workers.

## Scheduler

Skicka `POST` med `x-cron-secret` till:

```text
/functions/v1/process-outbox
/functions/v1/automation-runner
/functions/v1/data-worker
/functions/v1/ingestion-worker
/functions/v1/maintenance-worker
/functions/v1/compliance-worker
```

Lägg aldrig cron-hemligheten i klientkod.

## Webbdeployment

```bash
npm ci
npm run verify
npm run start
```

`npm run build` kör först kanonisk TypeScript-kontroll och därefter Next/Turbopack-build med en kontrollerad worker.
