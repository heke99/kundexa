# Leveransmanifest

## Projekt

- Namn: Kundexa
- Typ: multi-tenant SaaS-webbapp
- Repository: inget Git/GitHub-repository ingår
- Databas/backend: Supabase Cloud
- Dockerkrav: nej

## Verifieringskommandon

```bash
npm ci
npm run typecheck
npm test
npm run build
```

## Levererade huvudmappar

- `src/app` – webbapp, server actions och API-rutter
- `src/components` – UI, dialer och app shell
- `src/lib` – auth, RLS-kontext, permissions, crypto och domänlogik
- `supabase/migrations` – komplett ordnad databasdefinition
- `supabase/functions/process-outbox` – provider- och dokumentworker
- `supabase/functions/automation-runner` – automationsworker
- `public/vendor` – lokal JsSIP-browserbundle
- `docs` – krav, arkitektur, installation, säkerhet och produktionsgrindar

## Kontrollsummering

SHA-256 för leveransarkivet publiceras bredvid zip-filen vid paketering.
