# Production readiness — Kundexa

Arbetsdokument. En punkt får `[x]` endast när den har konkret evidens i kolumnen
under punkten. Allt annat står kvar som `[ ]` med orsak.

Senast uppdaterad: 2026-08-13
Verifieringsmiljö: repo `heke99/kundexa` @ branch `claude/kundexa-production-readiness-1x80og`,
Node 22.22.2, npm 10.9.7, Supabase-projekt `lhvifuxcqghtbiulzkrf` (Kundexa, eu-west-1),
produktionswebb `https://www.kundexa.se`.

## Byggkedja och CI

- [x] `npm ci` installerar hela beroendeträdet
  Evidens: exit 0 i denna miljö (tidigare sandboxar blockerades av intern npm-spegel).
- [x] `npm run verify` grön i sin helhet (`types:verify`, `typecheck:edge`, `test`,
      `openapi:verify`, `build`)
  Evidens: baslinjekörning exit 0 före ändringarna och full omkörning efter ändringarna.
- [x] Migrationsreplay mot riktig Postgres-motor (PGlite) inklusive runtimeflöden
  Evidens: `node scripts/verify-sql.mjs` — 66 migrationer, 180 tabeller, 0 kolumndrift.
- [x] Genererade Supabase-typer matchar migrerat schema
  Evidens: `npm run types:verify` samt drift-kontrollen i `verify-sql.mjs`.
- [x] CI kör samma grindar på PR mot `main`
  Evidens: `.github/workflows/verify.yml` (types, typecheck, edge, SQL, regression,
  contracts, Rinkel).

## Databas — migrationshistorik och schema

- [x] Repots migrationer och applicerad historik är identiska
  Evidens: `list_migrations` mot projektet ger exakt samma 66 versioner som
  `supabase/migrations/`, senast `202608130002`.
- [x] RLS är aktiverat på varje applikationsägd tabell i `public`
  Evidens: katalogfråga — endast `public.spatial_ref_sys` (PostGIS-ägd) saknar RLS.
- [x] Inga SECURITY DEFINER-rutiner är körbara av `anon`
  Evidens: efter `202608130001` returnerar advisorn 3 `anon_security_definer_function_executable`,
  samtliga PostGIS `st_estimatedextent`. Katalogfråga: 0 Kundexa-ägda.
- [x] Triggerrutiner har inga klientgrants
  Evidens: katalogfråga — 0 triggerrutiner med EXECUTE för `authenticated`.
- [x] Alla Kundexa-ägda funktioner har låst `search_path`
  Evidens: advisor `function_search_path_mutable` 8 → 0; katalogfråga 0 kvar.
- [x] RLS utvärderar `auth.uid()` en gång per statement
  Evidens: advisor `auth_rls_initplan` 37 → 0 efter `202608130002`.
- [x] Inga duplicerade index
  Evidens: advisor `duplicate_index` 5 → 0; de borttagna `_uidx`-kopiorna backade
  inget constraint (kontrollerat i `pg_constraint`).
- [x] Regressionsgrind mot återfall
  Evidens: `scripts/verify-sql.mjs` faller nu på över-grantade definers, mutabel
  `search_path` och per-rad `auth.uid()`. Negativt testat genom att tillfälligt ta bort
  `202608130001` — replayen failade som förväntat.
- [ ] Belastningstest och EXPLAIN-mätning mot produktionslik datavolym
  Orsak: produktionsdatabasen innehåller i praktiken ingen data ännu (2 tenants,
  3 profiler, 1 kund, 0 samtal, 0 avtal). Planmätning blir meningslös före verklig volym.

## Produktion — deployment

- [x] Produktionswebben svarar och når databasen
  Evidens: `GET https://www.kundexa.se/api/health` → `{"status":"ok"}`,
  `GET /api/ready` → `{"status":"ready","checks":{"database":true,"telephonyRuntimeConfigured":true}}`.
- [x] Rinkels servernyckel finns i webbruntime
  Evidens: `telephonyRuntimeConfigured: true` i `/api/ready`.
- [x] Webhookrutten är driftsatt och fail-closed
  Evidens: `POST https://www.kundexa.se/api/webhooks/rinkel/<ogiltig>/callStart` → 403.
- [ ] Rinkel-webhookarna pekar på en adress som svarar utan omdirigering
  Orsak: registrerade mål är `https://kundexa.se/...` och apexdomänen svarar 308 mot
  `https://www.kundexa.se/...`. Se blockerare B1.

## Rinkel

- [x] Central plattformsintegration med endast server-side nyckel
  Evidens: `RINKEL_API_KEY` läses bara i `serverEnv()`; ingen `NEXT_PUBLIC_*`-variant
  finns i källkoden.
- [x] Fem webhookar registrerade hos providern
  Evidens: `platform_rinkel_webhook_subscriptions` — `incomingCall`, `outgoingCall`,
  `callStart`, `callEnd`, `callInsights`, alla `registered`/`provider_active=true`.
- [x] Registrering vägrar en omdirigerande eller onåbar webhookadress
  Evidens: `probeWebhookDeliveryTarget` körs före registrering; enhetstest i
  `npm run test:api` täcker 200, 308 med absolut och relativ `Location`, 404 och DNS-fel.
- [ ] Webhookleverans verifierad end-to-end
  Orsak: `received_count = 0` för samtliga event och `last_error_code =
  RINKEL_INVALID_REQUEST` från providertestet. Kräver B1 och därefter en verklig leverans.
- [ ] Device-inventering synkad
  Orsak: `platform_rinkel_users = 1` men `platform_rinkel_devices = 0`. Dial kan inte bli
  redo förrän katalogsynken ger minst en aktiv device. Se blockerare B2.
- [ ] Utgående dial, CDR-reconciliation och recording verifierade live
  Orsak: beror på B1 och B2.

## Resend och avtal

- [x] Kanonisk e-postpipeline med delivery-events och webhookprojektion finns
  Evidens: `email_delivery_events`, `apply_resend_delivery_event` samt
  contract/reminder-projektionen i samma RPC-transaktion (migration `202608080001`).
- [x] Kontraktskedjan replayas i SQL-runtime
  Evidens: `verify-sql.mjs` kör signering, generationsbunden finalisering och idempotent
  aktivering.
- [ ] Live-utskick, bounce/complaint och signeringsflöde verifierade i produktion
  Orsak: 0 kontrakt finns i produktionsdatabasen; kräver ett dedikerat testtenant och en
  Resend-testmottagare för att inte träffa riktiga kunder.

## Blockerare (externa)

### B1 — Webhookadressen pekar på en omdirigerande apexdomän

- Saknas: `RINKEL_WEBHOOK_PUBLIC_BASE_URL` i Vercels produktionsmiljö pekar på
  `https://kundexa.se`, som svarar 308 mot `https://www.kundexa.se`.
- Varför kod inte löser det: värdet är en miljövariabel i Vercel-projektet, och den här
  sessionen har ingen Vercel-åtkomst. Koden vägrar nu registrera en sådan adress, men kan
  inte sätta rätt värde.
- Extern åtgärd: sätt `RINKEL_WEBHOOK_PUBLIC_BASE_URL=https://www.kundexa.se` (eller peka
  `app.kundexa.se` till deployen och använd den), deploya om, kör
  `Konfigurera webhookar` i `/app/platform/telephony`.
- Verifiering efteråt: `platform_rinkel_webhook_subscriptions.target_url_redacted` ska
  visa den direktsvarande värden, och `received_count`/`last_received_at` ska öka efter
  providerns testleverans.

### B2 — Ingen aktiv Rinkel-device i den centrala katalogen

- Saknas: `platform_rinkel_devices` är tom trots en synkad provideranvändare.
- Varför kod inte löser det: Kundexa hittar aldrig på ett device-id. Antingen saknar
  Rinkel-kontot en device, eller så exponerar inte kontots plan device-inventering.
- Extern åtgärd: kör katalogsynken mot det riktiga kontot och, om inventeringen fortfarande
  är tom, reda ut kontots device-kapabilitet med Rinkel.
- Verifiering efteråt: minst en aktiv rad i `platform_rinkel_devices` för den
  provideranvändare som ska allokeras, därefter seller-mappning och ett verkligt `/dial`.

### B3 — Läckta lösenord-skyddet är inte påslaget i Supabase Auth

- Saknas: `auth_leaked_password_protection` rapporteras av säkerhetsadvisorn.
- Varför kod inte löser det: det är en Auth-inställning i projektet, inte SQL eller
  applikationskod, och MCP-anslutningen exponerar inget verktyg för Auth-konfiguration.
- Extern åtgärd: slå på "Leaked password protection" i Supabase Auth-inställningarna.
- Verifiering efteråt: säkerhetsadvisorn ska inte längre rapportera varningen.

### B4 — PostGIS-ägda advisorfynd

- `public.spatial_ref_sys` utan RLS och `citext`/`pg_trgm`/`postgis` i `public` är
  extension-ägda. Kundexa patchar inte extensionobjekt för att tysta linten; de kvarstår
  medvetet och är dokumenterade här i stället.
