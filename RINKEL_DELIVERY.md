# Kundexa central Rinkel-plattform — leverans 2026-07-30

## Resultat

Kundexa använder nu exakt en central, server-side Rinkel-integration. `RINKEL_API_KEY` finns endast i driftmiljön och sparas aldrig per tenant. Kundexa synkroniserar det centrala användar- och nummerinventariet, medan historiserade allokeringar, nummergrants och säljar­mappningar avgör vad varje tenant får se och använda.

Rinkel är enda exekverbara voice-provider. 46elks används fortsatt endast för SMS. Webbläsaren startar ingen SIP- eller WebRTC-session och får aldrig providercredentials eller provider-ID:n som betrodda auktorisationsvärden.

Lokalt resultat: hela `npm run verify` passerar under den tillgängliga Node 24.14.0/npm 11.9.0-miljön. Projektets kanoniska Node 22.x/npm 10.9.2 måste fortfarande köras i staging/CI.

Produktionsstatus: `NOT READY` tills livepunkterna i slutet av dokumentet är verifierade.

## Vad som korrigerades

- Den gamla Rinkel-modellen läste och dekrypterade `tenant_integrations.credentials_ciphertext` per tenant.
- Användare, nummer, capabilities och webhookar var knutna till tenantanslutningar.
- Tenantadmin kunde mata in en egen Rinkel API-nyckel.
- Status, dial, webhookar och workers använde connection-ID och tenantcredentials.
- Samma centrala resurs kunde förekomma hos flera tenants utan en explicit historiserad allokering.

Den nya migrationen gör en hård cutover utan permanent fallback: gamla Rinkel-credentials nollställs, gamla tenantanslutningar inaktiveras, execute-/tabellrättigheter för den gamla modellen återkallas och alla exekverbara flöden använder den centrala plattformsvägen.

## Databas

Ny framåtriktad migration:

```text
supabase/migrations/202607300002_central_rinkel_platform.sql
```

Den tidigare distribuerbara migrationen `202607300001_rinkel_telephony_completion.sql` lämnas oförändrad som historik.

Nya centrala objekt:

- `platform_integrations`
- `platform_rinkel_users`
- `platform_rinkel_numbers`
- `rinkel_user_allocations`
- `rinkel_number_allocations`
- `rinkel_number_grants`
- `rinkel_user_mappings_v2`
- `platform_rinkel_capabilities`
- `platform_rinkel_webhook_subscriptions`
- `platform_rinkel_conflicts`
- `platform_rinkel_events`
- `platform_rinkel_jobs`
- `rinkel_call_attempts_v2`

Viktiga RPC:er:

- `get_platform_rinkel_overview`
- `allocate_platform_rinkel_resource`
- `revoke_platform_rinkel_resource`
- `get_tenant_rinkel_resources`
- `replace_rinkel_user_mapping_v2`
- `get_rinkel_telephony_status`
- `rinkel_reserve_platform_outbound_call`
- `rinkel_finalize_platform_dial_request`
- `ingest_platform_rinkel_event`

Partiella unika index förhindrar mer än en aktiv central integration, dubbel aktiv tenantallokering, dubbel säljar­mappning och parallella samtal per säljare eller provider-enhet. Samtal och försök sparar resurs-, mapping- och allokeringssnapshots så att en framtida nummerflytt inte ändrar historik.

Backfill deduplicerar legacy-användare och nummer via provider-ID/E.164. Entydiga resurser och giltiga mappningar migreras. Konkurrerande tenantanspråk blir öppna `platform_rinkel_conflicts` och allokeras inte automatiskt.

## Routes, actions och workers

- `GET /api/v1/telephony/status` — säker status för aktuell tenant/användare.
- `GET /api/v1/integrations/rinkel/status` — kompatibilitetsalias till telefoni­status utan credentials.
- `POST /api/v1/calls` — serverhärledd central mapping, device, nummerallokering och grant; exakt ett `POST /dial`.
- `GET /api/v1/calls` — kanonisk tenantisolerad historik.
- `GET /api/v1/calls/:id/recording` — åtkomstkontrollerad temporär stream eller privat kopia.
- `POST /api/v1/calls/:id/transcription/retry` — capability- och policykontrollerat återförsök.
- `POST /api/webhooks/rinkel/:secret/:event` — central, snabb och idempotent ingest.
- `rinkel-platform-worker` — central eventbearbetning, katalog/reconciliation, inspelning, transkript och Insights.
- `maintenance-worker` — köar central reconciliation och retention.
- `process-outbox` — legacy Rinkel-jobb dead-letteras permanent utan provideranrop.

Den gamla routen `/api/webhooks/rinkel/:connection/:secret/:event` ska tas bort enligt leveransens deletion manifest.

## Administration

`/app/platform/telephony` kräver plattformssuperadmin och visar endast om servernyckeln finns, aldrig värdet. Där kan plattformen testa anslutningen, synka katalogen, konfigurera de fem webhookarna, allokera/flytta/återkalla användare och nummer, se historik och konflikter samt pausa central telefoni.

Tenantens integrationsvy har inget Rinkel-nyckelfält. Den visar endast allokerade resurser, säkra readiness-statusar, säljar­mappning, standardnummer och tenantens telefoni-, inspelnings- och retentionpolicy.

## Miljövariabler

Samma logiska `RINKEL_API_KEY` sätts i Vercel och i Supabase Edge Secrets när båda runtime-miljöerna gör Rinkel-anrop:

```dotenv
RINKEL_API_KEY=
RINKEL_API_BASE_URL=https://api.rinkel.com/v1
RINKEL_WEBHOOK_PUBLIC_BASE_URL=https://kundexa.se
RINKEL_WEBHOOK_SECRET=
RINKEL_REQUEST_TIMEOUT_MS=15000
RINKEL_ENFORCE_WEBHOOK_IP_ALLOWLIST=true
RINKEL_RECONCILIATION_ENABLED=true
CRON_SECRET=
```

`RINKEL_WEBHOOK_SECRET` ska vara en separat slumpmässig hemlighet på minst 40 tecken. API-nyckeln får aldrig återanvändas som webhooksecret.

## Migrations- och deployordning

1. Packa upp och rsynca patchen utan extra projektmapp.
2. Ta bort filerna i `KUNDEXA_CENTRAL_RINKEL_DELETED_FILES.txt`.
3. Kör Node 22.x och npm 10.9.2 samt `npm ci`.
4. Länka först ett separat Supabase stagingprojekt.
5. Kör `npm run db:push`; den nya migrationen appliceras efter `202607300001`.
6. Generera Supabase-typer.
7. Sätt samma centrala Rinkel-nyckel och övriga secrets i berörda runtimes.
8. Deploya Edge Functions, inklusive nya `rinkel-platform-worker`.
9. Kör `npm run verify`.
10. Deploya webbappen till staging och därefter produktion efter godkända livegates.

## Lokal verifiering

- `npm ci`: PASS med isolerad npm-cache.
- `npm run typecheck`: PASS.
- `npm run typecheck:edge`: PASS.
- `npm run test:rinkel`: PASS, 8/8.
- `npm run test`: PASS.
- SQL: PASS, 38 migrationer, 170 tabeller, 277 funktioner och 297 RLS-policies.
- Tvåtenant-Rinkel-runtime: PASS för exklusiva allokeringar, tenantfiltrerad läsning, atomisk reservation, idempotent replay, providerfinalisering och oföränderlig samtalshistorik.
- `npm run build`: PASS, inklusive de nya telefoni- och webhookroutterna.
- `npm run verify`: PASS.

## Externa produktionssteg — NOT RUN

- Verklig central Rinkel API-nyckel och plan-/capabilitytest.
- Synk av riktiga användare, `deviceId` och nummer.
- Riktigt utgående samtal samt `incomingCall`, `outgoingCall`, `callStart`, `callEnd` och `callInsights`.
- Webhookretry, leverantörsinaktiverad webhook och reconciliation efter saknat event.
- Inspelning, temporär stream, privat Storage-kopia, transkript och Insights mot aktuell plan.
- Tvåtenanttest med riktiga Supabase JWT-sessioner i länkat stagingprojekt.
- Node 22.x/npm 10.9.2-verifiering.
- Juridiskt beslut om inspelning/retention, backup/restore, belastningstest och extern penetrationstest.

Livegates ska rapporteras som `NOT RUN` tills de faktiskt har körts; lokal kodverifiering ersätter dem inte.

## Tilläggsleverans 2026-08-02 — livscykel, inkommande matchning och CDR-reparation

Den framåtriktade migrationen `202608020001_rinkel_lifecycle_reconciliation_hardening.sql` kompletterar den centrala modellen utan att skapa en parallell telefoniväg. Den inför `calls.provider_outcome`, kanoniska providerstatusar, kompatibel hantering av nya Rinkel-cause-värden, tenantlokal och entydig inkommande kundmatchning, en aktiv inspelningsreferens per samtal/provider samt atomisk CDR-reparation via `reconcile_rinkel_call_from_cdr`.

`rinkel-platform-worker` utför nu verklig CDR-avstämning. Känd provideridentitet hämtas direkt; saknad identitet får endast korreleras vid en entydig kandidat inom ett begränsat tidsfönster. Konflikter registreras i stället för att gissas. `callEnd` köar avstämning och enrichment idempotent.

Ny servervariabel:

```dotenv
RINKEL_WEBHOOK_ALLOWED_IPS=82.199.77.220,188.122.73.177
```

Verifieringsstatus för just denna tilläggsleverans finns i `KUNDEXA_RINKEL_HARDENING_VERIFY_LOG_2026-08-02.txt`. Tidigare verifieringsresultat ovan är historiska och ska inte tolkas som att den nya migrationen redan har applicerats på staging.

