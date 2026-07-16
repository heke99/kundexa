# Synk och deployment

## Första synk mot Supabase Cloud

```bash
cd kundexa
npm ci
cp .env.example .env.local
npm run supabase:login
npm run supabase:link -- --project-ref PROJECT_REF
npm run db:push
npm run types:generate
npm run functions:deploy -- --project-ref PROJECT_REF
npm run verify
```

## Efter en ny SQL-migration

```bash
npm run db:push
npm run types:generate
npm run typecheck
npm test
npm run build
```

## Efter ändring i en Edge Function

```bash
npx supabase@2.109.1 functions deploy process-outbox --no-verify-jwt --project-ref PROJECT_REF
npx supabase@2.109.1 functions deploy automation-runner --no-verify-jwt --project-ref PROJECT_REF
```

## Deployment av webbappen

Kundexa kan köras på en vanlig Node-host eller Vercel. Lägg samtliga servervariabler i hostens krypterade environment settings och kör:

```bash
npm ci
npm run verify
npm run start
```

För en ny build:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run start
```

`next.config.ts` exkluderar Next.js-paketets egna filer från output file tracing för att undvika extremt lång tracing i begränsade byggmiljöer. Deploymentmiljön ska alltid köra `npm ci`, så runtime-paketen finns på plats.

## Ingen GitHub krävs

Projektet levereras utan `.git`. För lokal versionshantering kan du senare själv köra:

```bash
git init
git add .
git commit -m "Initial Kundexa platform"
```
