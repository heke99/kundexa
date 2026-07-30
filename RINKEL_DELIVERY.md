# Kundexa + Rinkel — leverans 2026-07-30

## Resultat

Kundexa använder nu Rinkel som enda exekverbara voice-provider. Rinkel äger telefonin; Kundexas befintliga `calls`, kunder, listor, callbacks, aktiviteter, anteckningar, avtal och rapportering är fortsatt kanoniska. 46elks används endast för SMS.

Lokalt resultat: `npm run verify` passerar under Node 24.14.0/npm 11.9.0. SQL-gaten exekverar 37 migrationer och verifierar 157 publika tabeller, 270 publika funktioner och 292 RLS-policies.

Produktionsstatus: `NOT READY`. Se blockerare längst ned.

## Brister som stängdes

- Den gamla voicevägen skapade 46elks/WebRTC-jobb i stället för tenantens Rinkel-samtal.
- Webbläsaren registrerade en parallell SIP/WebRTC-session.
- Rinkel saknade tenantanslutning, krypterad credentialhantering, katalogsynk och säljar-/enhets-/nummermappning.
- `/dial` saknade atomisk lokal reservation, idempotens och lås för säljare/enhet.
- Webhookar, eventordning, inkommande samtal, oklara providerutfall och reconciliation saknade ett sammanhängande flöde.
- Inspelning, väntande transkript, Insights, privat lagring och retention saknade en komplett livscykel.
- Automatisk dialer stoppades inte databas-side när webhookhälsan var dålig.
- Providerartefakter hade initialt för bred tenantläsning; de följer nu roll-, team-, användar- och kanonisk samtalsåtkomst.
- Rå providerdata kunde följa generella tabellprivilegier; autentiserade klienter får nu endast säkra kolumner.

## Tillagda filer

- `RINKEL_DELIVERY.md`
- `docs/integrations/rinkel.md`
- `scripts/rinkel-unit-tests.mts`
- `src/app/(dashboard)/app/calls/[id]/page.tsx`
- `src/app/actions/rinkel.ts`
- `src/app/api/v1/calls/[id]/recording/route.ts`
- `src/app/api/v1/calls/[id]/transcription/retry/route.ts`
- `src/app/api/v1/integrations/rinkel/status/route.ts`
- `src/app/api/webhooks/rinkel/[connection]/[secret]/[event]/route.ts`
- `src/components/rinkel-dialer.tsx`
- `src/components/transcription-retry-button.tsx`
- `src/hooks/use-rinkel-dialer.ts`
- `src/lib/integrations/rinkel/client.ts`
- `src/lib/integrations/rinkel/errors.ts`
- `src/lib/integrations/rinkel/normalizers.ts`
- `src/lib/integrations/rinkel/schemas.ts`
- `src/lib/integrations/rinkel/types.ts`
- `src/lib/webhooks/rinkel.ts`
- `supabase/functions/_shared/rinkel.ts`
- `supabase/migrations/202607300001_rinkel_telephony_completion.sql`

## Ändrade filer

- `.agent-memory/completed-work.md`
- `.agent-memory/current-state.md`
- `.agent-memory/database-and-migrations.md`
- `.agent-memory/decisions.md`
- `.agent-memory/integrations.md`
- `.agent-memory/known-failures.md`
- `.agent-memory/next-actions.md`
- `.agent-memory/open-blockers.md`
- `.agent-memory/project-identity.md`
- `.agent-memory/session-log.md`
- `.agent-memory/verification-matrix.md`
- `.env.example`
- `docs/ARCHITECTURE.md`
- `docs/IMPLEMENTED_SCOPE.md`
- `docs/PRODUCTION_GATES.md`
- `docs/PRODUCT_REQUIREMENTS.md`
- `docs/PROSPECTING_LISTS_DIALER.md`
- `docs/SUPABASE_SETUP.md`
- `package.json`
- `scripts/verify-sql.mjs`
- `scripts/verify.mjs`
- `src/app/(dashboard)/app/calls/page.tsx`
- `src/app/(dashboard)/app/dialer/page.tsx`
- `src/app/(dashboard)/app/integrations/page.tsx`
- `src/app/actions/admin.ts`
- `src/app/actions/communications.ts`
- `src/app/api/openapi.json/route.ts`
- `src/app/api/v1/calls/complete/route.ts`
- `src/app/api/v1/calls/route.ts`
- `src/app/api/v1/dialer/complete/route.ts`
- `src/app/api/v1/voice-client/route.ts`
- `src/app/api/webhooks/46elks/voice/hangup/route.ts`
- `src/app/api/webhooks/46elks/voice/recording/route.ts`
- `src/app/api/webhooks/46elks/voice/start/route.ts`
- `src/app/page.tsx`
- `src/components/list-dialer-workspace.tsx`
- `src/components/webrtc-dialer.tsx`
- `src/hooks/use-call-realtime.ts`
- `src/hooks/use-webrtc-voice.ts`
- `src/lib/env.ts`
- `src/lib/permissions.ts`
- `supabase/functions/maintenance-worker/index.ts`
- `supabase/functions/process-outbox/index.ts`

## Nya databasobjekt

Migration: `supabase/migrations/202607300001_rinkel_telephony_completion.sql`.

Nya tabeller:

- `rinkel_users`
- `rinkel_numbers`
- `rinkel_user_mappings`
- `telephony_policies`
- `rinkel_capabilities`
- `rinkel_webhook_subscriptions`
- `call_attempts`
- `call_transcripts`
- `call_insights`
- `call_correlation_conflicts`

Nya eller ersatta funktioner:

- `seed_telephony_policy`
- `rinkel_reserve_outbound_call`
- `rinkel_finalize_dial_request`
- `replace_rinkel_user_mapping`
- `complete_manual_call_work_v2`
- `complete_dialer_work_v2`

Migrationen utökar även `tenant_integrations`, `calls`, `provider_webhook_events` och `call_recordings`, lägger provider-/korrelationsindex, aktiva säljar-/enhetslås, RLS, säkra kolumnprivilegier, audit och Realtime-publicering.

## Nya miljövariabler

```dotenv
RINKEL_API_BASE_URL=https://api.rinkel.com/v1
RINKEL_WEBHOOK_PUBLIC_BASE_URL=https://app.kundexa.se
RINKEL_REQUEST_TIMEOUT_MS=15000
RINKEL_ENFORCE_WEBHOOK_IP_ALLOWLIST=true
RINKEL_RECONCILIATION_ENABLED=true
```

Tenantens Rinkel API-nyckel är inte en miljövariabel. Den tas emot server-side, krypteras med befintlig `KUNDEXA_ENCRYPTION_KEY` och sparas per tenant.

## Nya API-routes och ändrade workers

- `POST /api/v1/calls` — atomisk reservation och ett enda Rinkel `/dial`-anrop.
- `GET /api/v1/calls` — kanonisk samtalshistorik.
- `GET /api/v1/calls/:id/recording` — behörighetskontrollerad färsk stream-URL.
- `POST /api/v1/calls/:id/transcription/retry` — säkert nytt transkriptförsök.
- `GET /api/v1/integrations/rinkel/status` — integrations- och webhookhälsa.
- `POST /api/webhooks/rinkel/:connection/:secret/:event` — snabb, validerad och idempotent webhookingest.
- `process-outbox` — Rinkel-event, reconciliation, enrichment, inspelning, transkript, Insights och retention.
- `maintenance-worker` — schemalägger Rinkel reconciliation och retention.

Inga nya Edge Function-mappar behövdes; befintliga workers utökades och den gemensamma Edge-klienten lades i `_shared/rinkel.ts`.

## Installation och synk

Packa upp patchzippen i en temporär katalog och synkronisera den över projektet:

```bash
KUNDEXA_PATCH_DIR="$(mktemp -d)"
ditto -x -k "$HOME/Downloads/Kundexa-Rinkel-production-completion-2026-07-30.zip" "$KUNDEXA_PATCH_DIR"
rsync -avh --progress "$KUNDEXA_PATCH_DIR/" "/Users/hekmath/Desktop/Projects/kundexa/"
cd "/Users/hekmath/Desktop/Projects/kundexa"
npm ci
```

Patchen innehåller endast tillagda och ändrade filer. Kommandot raderar inte andra lokala filer.

## Migration, typer, secrets och deployment

Kör först mot ett separat Supabase stagingprojekt:

```bash
cd "/Users/hekmath/Desktop/Projects/kundexa"
npm run supabase:login
npm run supabase:link -- --project-ref <SUPABASE_PROJECT_REF>
npm run db:push
SUPABASE_PROJECT_REF=<SUPABASE_PROJECT_REF> npm run types:generate
```

Sätt Edge-secrets. `KUNDEXA_ENCRYPTION_KEY` måste vara exakt samma hemlighet som webbappen använder:

```bash
npx supabase@2.109.1 secrets set \
  APP_URL=https://staging.kundexa.se \
  KUNDEXA_ENCRYPTION_KEY='<SAME_BASE64_KEY_AS_WEB_APP>' \
  RINKEL_API_BASE_URL=https://api.rinkel.com/v1 \
  RINKEL_REQUEST_TIMEOUT_MS=15000 \
  RINKEL_RECONCILIATION_ENABLED=true \
  --project-ref <SUPABASE_PROJECT_REF>
```

Deploya workers och verifiera:

```bash
npm run functions:deploy -- --project-ref <SUPABASE_PROJECT_REF>
npm run verify
```

## Manuella steg i Rinkel och Kundexa

1. Säkerställ Rinkel-plan med API- och webhookstöd.
2. Öppna **Inställningar → Integrationer → Rinkel** som tenantägare/admin.
3. Spara och testa tenantens API-nyckel.
4. Synkronisera Rinkel-användare och nummer.
5. Mappa varje säljare till rätt Rinkel-användare, `deviceId` och standardnummer.
6. Sätt publik HTTPS-webhookbas och konfigurera alla event: `incomingCall`, `outgoingCall`, `callStart`, `callEnd`, `callInsights`.
7. Verifiera med kontrollerade inkommande, besvarade, obesvarade och timeoutliknande testsamtal.
8. Verifiera recording/transcription/Insights enligt den aktuella Rinkel-planen.
9. Kontrollera privat `call-recordings`-bucket, retention, juridisk information och audit.

## Produktionsblockerare

Status: `NOT READY`.

- Fil/funktion: `supabase/migrations/202607300001_rinkel_telephony_completion.sql` och `rinkel_reserve_outbound_call`. Blockerare: migrationen och tenant-/RLS-gränserna är inte körda med riktiga Supabase JWT-sessioner i ett länkat tvåtenant-stagingprojekt.
- Fil/funktion: `src/app/api/v1/calls/route.ts` (`POST`) och `src/lib/integrations/rinkel/client.ts` (`dial`). Blockerare: ett verkligt Rinkel-konto, en verklig enhet och riktiga utgående samtal har inte kunnat verifieras i leveransmiljön.
- Fil/funktion: `src/app/api/webhooks/rinkel/[connection]/[secret]/[event]/route.ts`. Blockerare: publik HTTPS, proxy-IP-kedja och alla fem riktiga Rinkel-event är inte liveverifierade.
- Fil/funktion: `src/app/api/v1/calls/[id]/recording/route.ts` och `supabase/functions/process-outbox/index.ts`. Blockerare: verklig inspelning, 204→pending-transkript, Insights, privat Storage och providerretention är inte verifierade mot tenantens aktuella Rinkel-plan.
- Fil/funktion: hela `npm run verify`. Blockerare: slutgaten är körd under Node 24.14.0/npm 11.9.0 och måste upprepas under projektets kanoniska Node 22.x/npm 10.9.2.
- Externa gates: juridiskt godkännande för inspelning/retention, backup/restore, belastningstest och extern penetrationstest återstår enligt `docs/PRODUCTION_GATES.md`.
