# Synk och deployment

## Synka patchen till befintligt projekt

```bash
cd ~/Downloads
unzip kundexa-canonical-platform-2026-07-16-patch.zip
rsync -av --checksum \
  kundexa-canonical-platform-2026-07-16-patch/payload/ \
  /DIN/BEFINTLIGA/PATH/kundexa-main/
```

Radera inte egna `.env.local`-filer. Patchen innehåller inte `node_modules`, `.next`, `.git` eller hemligheter.

## Installera och verifiera

```bash
cd /DIN/BEFINTLIGA/PATH/kundexa-main
node --version   # ska vara 22+
npm ci
npm run verify
```

## Koppla och migrera Supabase

```bash
npm run supabase:login
npm run supabase:link -- --project-ref PROJECT_REF
npm run db:push
npm run types:generate
```

Ändra aldrig en migration som redan har körts i produktion. Skapa en ny tidsstämplad migration för framtida ändringar.

## Deploya Edge Functions

```bash
npm run functions:deploy -- --project-ref PROJECT_REF
```

Kommandot deployar `process-outbox`, `automation-runner` och `data-worker` och vidarebefordrar projektflaggan till samtliga tre funktioner.

## Scheduler

Kör följande endpoints minst varje minut med `x-cron-secret`:

```text
POST /functions/v1/process-outbox
POST /functions/v1/automation-runner
POST /functions/v1/data-worker
```

Lägg inte cron-hemligheten i klientkod.

## Webbdeployment

```bash
npm ci
npm run verify
npm run start
```

`npm run build` kör först den kanoniska TypeScript-kontrollen och därefter Next/Turbopack-build med en worker. Det undviker en Next 16-worker-deadlock utan att tillåta typfel.
