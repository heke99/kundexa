# Kundexa — Rinkel- och dialerhärdning

Datum: 2026-08-02

## Leveransstatus

Den befintliga centrala Rinkel-arkitekturen har konsoliderats och härdats. Ingen parallell voice-provider eller alternativ webhook-/worker-/samtalsmodell har skapats.

Lokalt källkodsmässigt implementerat:

- sanningsenliga och separat verifierade integrationskapabiliteter,
- exakt en kanonisk central Rinkel-integrationsrad,
- fler-enhetsmodell och explicit vald aktiv device,
- deterministisk caller-ID-resolver med provider-`numberId`,
- säkrare idempotens och timeout som osäkert providerutfall,
- webhooklivscykel med registrering, test pending, mottagning och workerverifiering,
- beständig worker med atomisk claim, lease recovery, retry och dead letter,
- CDR-pagination och rättvis avstämning av både äldre och nya ofullständiga samtal,
- separat transkribering och Insights,
- retention och legal-hold-skydd,
- plattformsadministration för drift, återköning och manuell korrelationsreparation,
- tenantfiltrerad device-/nummeradministration och readinessblockerare,
- Vercel Cron-route för worker varje minut,
- stagingprotokoll och synk-/deploydokumentation.

Inte verifierat i denna körmiljö:

- körning av migrationen mot Kundexa Supabase staging,
- generering av nya Supabase-typer,
- Deno-kontroll av Edge Functions,
- full Next.js typecheck/build,
- riktig Rinkel API-nyckel, devices, nummer, webhooktest, CDR eller testsamtal,
- RLS-tvåtenanttest mot verklig databas.

Den anslutna Supabase-kontolistan innehöll ingen projektpost med namnet Kundexa. Inga externa databaser ändrades.

## Kritiska korrigeringar

### Integrationsstatus

`GET /users` och `GET /numbers` verifierar API och kataloger men markeras inte längre som ett verkligt dialtest. Återaktivering sätter status till `testing`, rensar `disabled_at` och kräver ny anslutningskontroll innan `connected` kan visas.

Gamla operationsspecifika fel rensas endast när samma operation senare lyckas. Tekniska databas-, behörighets-, tenant-, mapping-, device-, nummer- och providerfel har separata säkra felkoder och correlation ID.

### Webhookar

Kärneventen `incomingCall`, `outgoingCall`, `callStart` och `callEnd` hanteras separat från valfria `callInsights`. Registrering och read-back är inte samma sak som verifierad leverans. Status blir `verified` först efter mottagning och lyckad workerbehandling av det testkorrelerade eventet.

Webhookendpointen validerar secret, nätverkspolicy, event, content type, body-storlek och payloadschema, sparar råevent före tung behandling och köar idempotent jobb. Tenant härleds aldrig direkt från payloaden.

### Worker och scheduler

`rinkel-platform-worker` claimar jobb genom en service-role-RPC med `FOR UPDATE SKIP LOCKED`. Fem minuter gamla processing-leases återställs. Retry, maxförsök, dead letter, manuellt återkö och heartbeat lagras i databasen.

Vercel Cron anropar `/api/cron/rinkel-platform-worker` varje minut. Route-handlern verifierar `Authorization: Bearer $CRON_SECRET` och anropar Edge Function server-to-server.

### Dial, idempotens och dubbelringning

`POST /dial` skickas exakt en gång per reserverat försök. POST retryas aldrig automatiskt. Timeout eller nätverksavbrott efter möjlig providersändning ger `provider_outcome_unknown`; samma användare/device blockeras tills webhook eller CDR har avstämt utfallet.

Idempotent replay returnerar verklig attempt-/providerstatus. Failed, ended eller completed presenteras inte som ett nytt pågående samtal. Ett definitivt misslyckat försök kan följas av ett nytt manuellt försök med ny idempotensnyckel.

### Devices och caller-ID

`platform_rinkel_devices` lagrar flera devices per central Rinkel-användare. Tenantmappingen pekar på en konkret aktiv device. Borttagna devices inaktiveras och blockerar dial tills tenantadmin väljer en ny.

Caller-ID väljs server-side i följande kedja:

1. explicit tillåten nummerallokering för samtalet,
2. ringlistans standard,
3. kampanjens standard,
4. teamets standard,
5. tenantens standard,
6. plattformens reservstandard,
7. äldre säljarstandard endast som bakåtkompatibel sista reserv.

Resolvern returnerar provider-`numberId`, E.164, allokeringskälla och allokerings-ID. Ett explicit otillåtet nummer faller aldrig tyst tillbaka till ett annat nummer.

### Eventkorrelation och CDR

Lifecycle-event får ligga kvar som `pending_correlation` eller `conflict` i stället för att markeras processade utan samtalskoppling. Flera kandidater gissas aldrig. Plattformsadmin kan återbehandla öppna konflikter.

CDR-avstämningen hanterar cursor/sidor, begränsar batchar och prioriterar både äldsta och nyaste ofullständiga samtal för att undvika svält.

### Inspelning, transkribering och Insights

Frontend anropar inte Rinkel direkt för inspelning. Befintlig serverkontrollerad, kortlivad stream behålls. Den kosmetiska inställningen för privat Kundexa-kopia exponeras inte; policyn tvingas till `provider_only` tills provideroberoende download/hash/private Storage-kedja är liveverifierad.

Transkribering använder `rinkel.transcription.fetch`. HTTP 204 blir `pending_provider` med långt retryfönster och senare `not_available`, inte ett omedelbart permanent fel. Insights använder separat `rinkel.insights.process` och är inte beroende av transkribering.

Rinkel note-sync exponeras endast när kapabiliteten uttryckligen är verifierad. Kundexas CRM-anteckning är alltid primär.

### Retention

Tenantretention omfattar inspelning, transkript, Insights, råa webhookpayloads och jobbfel/payloads med legal-hold-skydd. Tenantlösa plattformsevent och plattformsjobb scrubbas separat av `rinkel.retention_platform` efter 30 dagar; öppna konflikter skyddas.

## Migration

### `supabase/migrations/202608020003_rinkel_production_completion.sql`

Migrationen är framåtriktad och:

- säkerställer/utser en central kanonisk Rinkel-rad,
- avaktiverar äldre konkurrerande rader med auditspår,
- lägger till separata kapabilitetsfält,
- skapar `platform_rinkel_devices`,
- backfillar valt device deterministiskt,
- skapar caller-ID-defaultfält och tenantbundna FK-regler,
- deduplicerar äldre team-/tenantstandarder före unika index,
- lägger till webhookstatus, räknare och atomiska receipt/process/failure-RPC:er,
- lägger till worker heartbeat, claim, finish, stale lease recovery och requeue,
- ersätter mapping/readiness/reservation med v3/v2-flöden,
- tar bort 24-timmars webhooktrafik som dialblockerare,
- canonicaliserar transkriberings- och Insights-jobb,
- aktiverar RLS och begränsar nya tabeller till service-role.

Ingen äldre migrationsfil har ändrats.

## Ändrade filer

- `docs/SYNC_AND_DEPLOY.md` — nytt ändrings-ZIP-, Supabase-, Edge-, scheduler-, verifierings- och deployflöde.
- `docs/integrations/rinkel.md` — kanonisk arkitektur, capabilities, webhook, worker, CDR, retention och drift.
- `src/app/(dashboard)/app/dialer/page.tsx` — skickar tillåtna caller-ID-allokeringar till dialern.
- `src/app/(dashboard)/app/integrations/page.tsx` — deviceval, caller-ID-defaults och kapabilitetsstyrda policyfält.
- `src/app/(dashboard)/app/platform/telephony/page.tsx` — sanningsenlig driftstatus, devices, webhookräknare, workerstatus, jobb och konfliktreparation.
- `src/app/actions/rinkel.ts` — connection test, katalog/device-sync, webhook read-back/test, pause/resume, mapping, caller-ID, worker, requeue och audit.
- `src/app/api/openapi.json/route.ts` — caller-allokering och readinesskontrakt.
- `src/app/api/v1/calls/[id]/transcription/retry/route.ts` — kanonisk transkriberingsjobbtyp.
- `src/app/api/v1/calls/route.ts` — explicit caller-ID, säker reservation, sann replay och osäkert timeoututfall.
- `src/app/api/webhooks/rinkel/[secret]/[event]/route.ts` — idempotent lagring, kö, receipt/testkorrelation och audit.
- `src/components/rinkel-dialer.tsx` — caller-ID-val och korrekt osäkerhetsstatus.
- `src/hooks/use-rinkel-dialer.ts` — bevarad idempotenskontext vid nätverksosäkerhet.
- `src/lib/env.ts` — publik HTTPS-/hostname-/IP-/secretvalidering.
- `src/lib/integrations/rinkel/schemas.ts` — core/optional/toleranta providerexports.
- `src/lib/integrations/rinkel/types.ts` — uppdaterade device-/outcome-typer.
- `src/lib/supabase/runtime-database.types.ts` — tillfällig runtimekompatibilitet för framåtmigration; genererad fil är fortsatt releasekälla.
- `supabase/functions/_shared/rinkel.ts` — defensiv klient, devicekatalog, no-retry POST, pagination, tolerant cause och 204-transkript.
- `supabase/functions/maintenance-worker/index.ts` — schemalägger plattformsretention.
- `supabase/functions/process-outbox/index.ts` — retention/legal hold för Rinkeldata.
- `supabase/functions/rinkel-platform-worker/index.ts` — korrelation, CDR, transkript, Insights, retention, claim/finish och heartbeat.
- `vercel.json` — workercron varje minut.

## Nya filer

- `docs/RINKEL_STAGING_PROTOCOL.md` — manuellt evidensbaserat liveprotokoll.
- `src/app/api/cron/rinkel-platform-worker/route.ts` — autentiserad Vercel Cron-brygga.
- `supabase/migrations/202608020003_rinkel_production_completion.sql` — framåtriktad produktionskomplettering.
- `KUNDEXA_RINKEL_PRODUCTION_COMPLETION_DELIVERY_2026-08-02.md` — denna leveransrapport.
- `KUNDEXA_RINKEL_PRODUCTION_COMPLETION_VERIFY_LOG_2026-08-02.txt` — faktisk verifieringslogg.

## Raderade filer

Inga filer raderades.

## Miljövariabler

Server/Vercel och relevanta Supabase Edge Secrets:

```env
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
KUNDEXA_ENCRYPTION_KEY=
KUNDEXA_WEBHOOK_PEPPER=

RINKEL_API_KEY=
RINKEL_API_BASE_URL=https://api.rinkel.com/v1
RINKEL_WEBHOOK_PUBLIC_BASE_URL=https://STAGING_OR_PRODUCTION_DOMAIN
RINKEL_WEBHOOK_SECRET=MINST_40_TECKEN
RINKEL_WEBHOOK_ALLOWED_IPS=82.199.77.220,188.122.73.177
RINKEL_REQUEST_TIMEOUT_MS=15000
RINKEL_ENFORCE_WEBHOOK_IP_ALLOWLIST=true
RINKEL_TRUST_X_REAL_IP=false
RINKEL_RECONCILIATION_ENABLED=true
CRON_SECRET=MINST_20_TECKEN
```

Inga hemligheter ska ha prefixet `NEXT_PUBLIC_`.

## Extern Rinkel-konfiguration

Kräver riktig Rinkel-miljö:

- central API-nyckel,
- centrala Rinkel-användare och deras devices,
- centrala utgående nummer,
- kärnwebhookar för fyra event,
- eventuellt `callInsights` om planen stöder det,
- inspelnings-/transkript-/Insightsstöd enligt konto/plan.

Rinkels publicerade telefonvalideringssida beskriver endpointen men inte ett komplett stabilt requestkontrakt i det material som kunde läsas här, och 409 beskrivs som att numret redan finns. Den har därför inte gissats in som en hård dialspärr. Kundexa använder lokal E.164-/policyvalidering; endpointen ska endast aktiveras som kompletterande kontroll efter verklig kontraktsverifiering i staging.

## Exakta kommandon

### Synka ZIP

```bash
cd /Users/hekmath/Downloads
rm -rf kundexa-rinkel-production-hardening-changes
mkdir -p kundexa-rinkel-production-hardening-changes
unzip -o kundexa-rinkel-production-hardening-changes.zip \
  -d kundexa-rinkel-production-hardening-changes

rsync -av --checksum --itemize-changes \
  /Users/hekmath/Downloads/kundexa-rinkel-production-hardening-changes/ \
  /Users/hekmath/Desktop/Projects/kundexa/
```

### Installera, länka, migrera och generera typer

```bash
cd /Users/hekmath/Desktop/Projects/kundexa
node --version
npm ci
npm run supabase:login
npm run supabase:link -- --project-ref PROJECT_REF
npx supabase@2.109.1 migration list
npm run db:push
SUPABASE_PROJECT_REF=PROJECT_REF npm run types:generate
npm run types:verify
```

### Edge Secrets och functions

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

npm run functions:deploy -- --project-ref PROJECT_REF
```

### Verifiera

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

### Git och Vercel

```bash
git status --short
git add docs src supabase vercel.json \
  KUNDEXA_RINKEL_PRODUCTION_COMPLETION_DELIVERY_2026-08-02.md \
  KUNDEXA_RINKEL_PRODUCTION_COMPLETION_VERIFY_LOG_2026-08-02.txt
git commit -m "Harden central Rinkel dialer lifecycle"
git push origin HEAD
```

Låt därefter den Vercel-kopplade branchen bygga normalt. Sätt samma serverhemligheter i Vercel före aktivering av cron.

## Faktiska verifieringsresultat i denna miljö

| Kontroll | Resultat | Klassificering |
|---|---|---|
| Node 22.16.0 | PASS | lokal runtime |
| npm 10.9.2 | PASS | lokal runtime |
| 8 isolerade Rinkel-enhetstester | PASS | transpilerad lokal modul |
| JSON package/vercel | PASS | statisk lokal kontroll |
| Äldre migrationer oförändrade | PASS | statisk lokal kontroll |
| TS/TSX parserdiagnostik i ändrade appfiler | PASS, 0 TS1xxx | full semantik ej möjlig utan dependencies |
| TS parserdiagnostik i ändrade Edge-filer | PASS, 0 TS1xxx | full Deno-check ej möjlig |
| `npm ci` | FAIL | paketproxyn saknar `pdf-lib@1.17.1` |
| `npm run lint` | BLOCKED | `next` saknas eftersom install misslyckades |
| `npm run typecheck` | BLOCKED | `next` saknas |
| `npm run typecheck:edge` | BLOCKED | `deno` saknas |
| `npm run test` | BLOCKED | lokalt `typescript`-paket saknas |
| `npm run build` | BLOCKED | `next` saknas |
| `npm run verify` | FAIL/BLOCKED | genererade Supabase-typer är stale |
| `npm run db:push` | BLOCKED | intern registry saknar Supabase CLI |
| `npm run types:generate` | BLOCKED | Kundexa project ref/link saknas |
| `npm run types:verify` | FAIL | saknar redan väntade `reconcile_rinkel_call_from_cdr` och `provider_outcome` i generated types |
| SQL/PGlite verifiering | BLOCKED | `@electric-sql/pglite` kunde inte installeras |
| riktig Supabase staging | NOT_RUN | inget anslutet Kundexa-projekt hittades |
| riktig Rinkel | NOT_RUN | API-nyckel/user/device/nummer saknas i miljön |

Detaljer finns i verifieringsloggen.

## Releaseblockerare före produktion

1. Kör `npm ci` från en normal npmregistry/miljö där lockfilens paket finns.
2. Länka rätt Kundexa Supabase stagingprojekt.
3. Kör migrationen och generera om `database.types.ts`.
4. Kör hela verify-matrisen tills allt är grönt.
5. Deploya tre berörda Edge Functions.
6. Sätt Vercel/Edge Secrets.
7. Kör `docs/RINKEL_STAGING_PROTOCOL.md` med ett riktigt samtal.
8. Kontrollera tvåtenant-RLS, webhooktest, worker heartbeat, CDR och inspelningsåtkomst innan produktion.
