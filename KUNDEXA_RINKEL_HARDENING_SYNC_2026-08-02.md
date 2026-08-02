# Synka Kundexa-patchen

Zipfilen innehåller endast ändrade och tillagda filer med projektroten som arkivrot. Den skapar därför ingen extra `kundexa-main`-mapp.

```bash
set -euo pipefail

ZIP="/Users/hekmath/Downloads/kundexa-rinkel-hardening-changed-files-2026-08-02.zip"
TARGET="/Users/hekmath/Desktop/Projects/kundexa"
TMP_DIR="$(mktemp -d)"

unzip -q "$ZIP" -d "$TMP_DIR"
rsync -av "$TMP_DIR/" "$TARGET/"
rm -rf "$TMP_DIR"

cd "$TARGET"
node --version
npm --version
npm ci
npm run supabase:login
npm run supabase:link -- --project-ref <STAGING_PROJECT_REF>
npm run db:push
npm run types:generate
npm run types:verify
npm run lint
npm run typecheck:edge
npm run test
npm run build
npm run verify
npm run functions:deploy
```

Kör först mot separat staging. Lägg inte in verkliga hemligheter i terminalhistorik, repository eller `NEXT_PUBLIC_*`.
