# Produktionsberedskap

Arbetsdokument. En punkt markeras `[x]` endast när det finns namngiven verifiering
(kommando, migration, testfil eller live-observation). `[ ]` betyder att den inte är
verifierad här, inte att den nödvändigtvis är trasig.

Uppdaterad: 2026-08-14.

Miljö som avses: Supabase-projektet `lhvifuxcqghtbiulzkrf` (Kundexa, eu-west-1) och
Vercel-projektet `kundexa` i teamet `div3rsa`.

## 1. Kanonisk domän

Produkten körs på **kundexa.se**. `app.kundexa.se` är utfasat och finns inte i DNS.

- [x] Ingen kodväg, env-mall eller aktuell driftdokumentation refererar `app.kundexa.se`
      Evidens: `grep -rn "app\.kundexa\.se" src supabase scripts docs .env.example` ger noll träffar.
- [x] `RINKEL_WEBHOOK_PUBLIC_BASE_URL` defaultar till `https://kundexa.se`
      Evidens: `src/lib/env.ts`.
- [x] `NEXT_PUBLIC_APP_URL` kan inte längre tyst falla tillbaka på `http://localhost:3000`
      i en deployad runtime
      Evidens: `canonicalAppBaseUrl()` i `src/lib/env.ts`, använd av samtliga fyra ställen
      som bygger en utgående adress: acceptanslänken i `src/app/actions/contracts.ts` och
      `src/lib/contracts/api-service.ts`, Resend-webhookadressen i `src/app/actions/admin.ts`
      och ParseHub-callbacken i `src/app/api/v1/integrations/parsehub/projects/route.ts`.
      Kontrollen sitter medvetet på länkbyggarna och inte i env-schemat: en felkonfiguration
      ska stoppa det utskick som annars hade fått en trasig länk, inte all requesthantering
      som inte har med länkar att göra.
- [x] Den faktiskt konfigurerade bas-URL:en är observerbar utifrån
      Evidens: `checks.appBaseUrl` och `checks.appBaseUrlUsable` i `GET /api/ready`.
- [ ] `kundexa.se` serveras direkt i stället för att 308-omdirigera till `www.kundexa.se`
      Kräver Vercel-dashboard, se *Externa åtgärder*.
- [ ] `NEXT_PUBLIC_APP_URL`, `APP_URL` och `RINKEL_WEBHOOK_PUBLIC_BASE_URL` är satta till
      `https://kundexa.se` i Vercel Production och Supabase Edge Secrets
      Kräver dashboard-access, se *Externa åtgärder*.

## 2. Databas: repo mot live

Repots migrationer och den körande produktionsdatabasen hade drift: tre migrationer var
applicerade i produktion men saknades i repot. De är nu backfillade med **samma
versionsnummer**, så `supabase db push` hoppar över dem i produktion och tillämpar dem i
nya miljöer.

- [x] Migrationshistoriken i repot täcker allt som är applicerat i produktion
      Evidens: `202608130001`, `202608130002`, `20260813222943` finns nu i `supabase/migrations/`.
- [x] RLS-policyernas definitioner i repot är identiska med produktionens
      Evidens: md5 över `(tablename, policyname, cmd, roles, qual, with_check)` för alla 301
      policyer i `public` = `8fdeefa4fbb7a95c3bc92d5fba82da69` i både PGlite-replay och live.
- [x] Genererade typer matchar det migrerade schemat
      Evidens: `npm run types:verify` — 180 tabeller, noll kolumndrift.
- [x] Inga kritiska säkerhetsfynd som ägs av Kundexa i Supabase advisors
      Evidens: kvarvarande `ERROR`/`WARN` gäller `spatial_ref_sys`, `st_estimatedextent`
      och `citext`/`pg_trgm`/`postgis` i `public` — samtliga PostGIS-ägda.
      De 15 `rls_enabled_no_policy` är service-role-tabeller där "RLS på, noll policyer"
      är den avsedda deny-all-hållningen.

## 3. Behörighetsgränser

Postgres ger EXECUTE till PUBLIC som default och `anon` ärver PUBLIC. En SECURITY
DEFINER-funktion som ingen migration uttryckligen återkallade var därmed anropbar
oautentiserat via `/rest/v1/rpc/<namn>` med definierarens rättigheter, förbi RLS.

- [x] Noll SECURITY DEFINER-funktioner i `public` är körbara av `anon`
      Evidens: `202608130001_function_execute_least_privilege.sql`; gate i
      `scripts/verify-sql.mjs` (`npm run test`). Före åtgärden: 62 funktioner i repots
      replay, bland andra `create_contract_draft_v2`, `complete_dialer_work`,
      `queue_email_message`, `queue_sms_message`, `add_customers_to_list`.
- [x] Avsiktliga service-role-nekanden är bevarade, inte breddade
      Evidens: `refresh_segment_materialization(uuid,uuid)` och
      `materialize_segment_to_campaign(uuid,uuid,uuid)` är fortsatt icke-körbara för
      `service_role`; gaten i `verify-sql.mjs` fångade ett tidigare försök att bredda dem.
- [x] Inga RLS-policyer anropar `auth.uid()` per rad
      Evidens: `202608130002_rls_auth_uid_initplan.sql`; gate i `scripts/verify-sql.mjs`.
- [ ] Tvåtenant-negativtest med riktiga JWT-sessioner mot live
      Kör i PGlite-replayen (`npm run test`), men inte mot hostad instans med riktiga sessioner.

## 4. Rinkel

Central plattformsintegration: exakt en server-side API-nyckel, centralt ägda resurser,
ingen Rinkel-credential per tenant.

- [x] Autentisering använder `x-rinkel-api-key`
      Evidens: `supabase/functions/_shared/rinkel.ts`; matchar developers.rinkel.com.
- [x] Webhookeventen matchar leverantörens aktuella dokumentation
      Evidens: `incomingCall`, `outgoingCall`, `callStart`, `callEnd`, `callInsights` med
      dokumenterade fält (`RINKEL_WEBHOOK_EVENTS`, `parseRinkelWebhookPayload`).
- [x] Ingen påhittad webhooksignatur
      Evidens: Rinkel dokumenterar ingen signering. Autenticitet vilar i stället på
      ogissningsbar hemlighet i URL:en, IP-allowlist, schemavalidering och dedup.
- [x] Nyckeln når aldrig webbläsaren
      Evidens: endast `serverEnv()`; ingen `NEXT_PUBLIC_`-variant; redaktion av
      `x-rinkel-api-key` i felutskrifter.
- [x] Alla fem webhookar är registrerade hos Rinkel mot rätt domän
      Evidens: `platform_rinkel_webhook_subscriptions` — fem rader, `status='registered'`,
      `provider_active=true`, mot `https://kundexa.se/api/webhooks/rinkel/.../<event>`.
      Detta bekräftar samtidigt att `RINKEL_WEBHOOK_PUBLIC_BASE_URL` i produktion redan är
      `https://kundexa.se`.
- [ ] **Rinkel-kontot har ingen device — dial är blockerat.**
      Evidens: `platform_rinkel_devices` har noll rader, och leverantörens egen payload för
      användaren (`hekmat.h@gridex.se`, `6a6b1c70faafaa92a04a7d6b`) har `"deviceId": null` och
      `"deskPhoneAccount": null`. `platform_rinkel_capabilities` visar `api_access=true`,
      `users_catalog=true`, `numbers_catalog=true`, `webhooks_registration=true` men
      `dial=false`, `dial_configured=false`, `dial_endpoint_reachable=false`, `webhooks=false`,
      `recordings=false`, `transcription=false`.
      `POST /dial` kräver `deviceId`. Koden failar korrekt stängt i stället för att hitta på ett
      device-id, så detta är en kontokapabilitet, inte en kodbugg. Se *Externa åtgärder*.
- [ ] Webhooktestet mot leverantören har aldrig gått igenom
      Evidens: samtliga fem prenumerationer har `last_error_code='RINKEL_INVALID_REQUEST'`,
      `test_received_at=null`, `last_verified_at=null`, `received_count=0`. Noll webhookevent har
      någonsin tagits emot (`platform_rinkel_webhook_events` är tom), vilket är väntat eftersom
      noll samtal ringts, men det betyder också att kedjan aldrig är liveverifierad.
- [ ] Live dial, CDR-reparation och recording mot riktigt Rinkel-konto
      Se *Externa åtgärder*.

## 5. Resend

- [x] Webhooks verifieras med Resends officiella mekanism (Svix HMAC)
      Evidens: `verifySvix` i `src/app/api/webhooks/resend/[token]/route.ts`, per tenant-hemlighet.
- [x] Webhooks är idempotenta och replay-säkra
      Evidens: `provider_webhook_events` med unikt `(provider, provider_event_id)`,
      återupptagning av icke-terminal leverans, `apply_resend_delivery_event` som en transaktion.
- [x] Leveranslivscykeln bygger på webhookevent, inte på att API:t svarade 200
      Evidens: `resendStatusMap` täcker `sent`, `delivered`, `opened`, `clicked`,
      `delivery_delayed`, `bounced`, `complained`, `failed`, `suppressed`.
- [x] Okända eventtyper förlorar inte data
      Evidens: rå payload persisteras före tolkning; omappade event markeras `ignored`,
      okorrelerade markeras `unmatched`.
- [ ] `email.scheduled` och `email.received` är inte mappade
      Medvetet: Kundexa schemalägger inte utskick och tar inte emot inkommande e-post.
- [ ] SPF/DKIM/DMARC verifierade för `utskick.kundexa.se`
      Se *Externa åtgärder*.

## 6. Byggrindar

- [x] `npm run verify` grön i sin helhet
      Kedja: `types:verify` → `typecheck:edge` → `test` → `openapi:verify` → `build`.
      `test` = regressionstester, PGlite-runtime, Rinkel-, kontrakts-, import- och
      API-sviter samt SQL-replay av samtliga migrationer.

## Externa åtgärder

Detta kan inte lösas med kod- eller databasaccess härifrån.

### 1. Gör `kundexa.se` till primär domän i Vercel

- **Vad saknas:** `kundexa.se` svarar `308 → https://www.kundexa.se/`. Appen serveras alltså
  på `www`, inte på den domän produkten ska ligga på.
- **Varför kod inte löser det:** omdirigeringen sker i Vercels domänlager före appen. En
  `next.config`-redirect från `www` till apex skulle kollidera med den och loopa.
  MCP-integrationen exponerar inga domän- eller env-verktyg.
- **Åtgärd:** i Vercel → projekt `kundexa` → Settings → Domains: sätt `kundexa.se` som
  primär och ändra `www.kundexa.se` till *Redirect to kundexa.se*.
- **Verifiering efteråt:** `curl -sI https://kundexa.se/api/health` ska ge `200`, och
  `curl -sI https://www.kundexa.se/` ska ge `308` mot `https://kundexa.se/`.

Redirecten är inte kosmetisk. De fem Rinkel-webhookarna är registrerade mot
`https://kundexa.se/...`, så varje inkommande webhookleverans möter i dag en 308. En
webhookavsändare som inte följer redirect tappar eventet.

### 2. Sätt bas-URL:erna till `https://kundexa.se`

- **Vad saknas:** `RINKEL_WEBHOOK_PUBLIC_BASE_URL` är bekräftat korrekt — de registrerade
  webhookadresserna i `platform_rinkel_webhook_subscriptions` pekar på `https://kundexa.se`.
  `NEXT_PUBLIC_APP_URL` (Vercel) och `APP_URL` (Supabase Edge Secrets) styr
  acceptans-/signeringslänkarna som skickas till kunder, och deras faktiska värden går inte
  att läsa härifrån. Om något av dem fortfarande är `https://app.kundexa.se` pekar varje
  utskickad signeringslänk på en domän som inte finns i DNS.
- **Varför kod inte löser det:** det är miljövariabler i Vercel och Supabase, inte i repot.
- **Åtgärd:** sätt båda till `https://kundexa.se` i Vercel Production/Preview och via
  `supabase secrets set` för Edge Functions, och deploya om.
- **Verifiering efteråt:** `curl -s https://kundexa.se/api/ready` ska visa
  `"appBaseUrl":"https://kundexa.se"` och `"appBaseUrlUsable":true`.

### 3. Provisionera en Rinkel-device för säljaranvändaren

- **Vad saknas:** `POST /dial` kräver `deviceId`, och Rinkels egen payload för användaren
  `hekmat.h@gridex.se` innehåller `"deviceId": null` och `"deskPhoneAccount": null`. Kontot har
  alltså ingen device. `platform_rinkel_capabilities` bekräftar `dial=false`,
  `dial_endpoint_reachable=false` och `webhooks=false` trots `api_access=true`.
- **Varför kod inte löser det:** Kundexa kan inte skapa en device åt Rinkel, och att hitta på ett
  device-id skulle bara flytta felet till ett provider-400. Koden failar medvetet stängt med en
  device-inventeringsdiagnostik i stället.
- **Åtgärd:** aktivera en device för användaren i My Rinkel (webphone, desk phone eller mobil-app)
  och bekräfta med Rinkel att abonnemanget täcker `/dial` och webhookfunktionen — deras publika
  villkor anger webhooks endast för Expert-abonnemanget, vilket är förenligt med att
  webhooktestet svarar `RINKEL_INVALID_REQUEST`.
- **Verifiering efteråt:** kör den centrala katalogsynken; `platform_rinkel_devices` ska få minst
  en aktiv rad och `platform_rinkel_capabilities.dial` ska bli `true`. Därefter går
  `docs/RINKEL_STAGING_PROTOCOL.md` att köra.

### 4. Live-verifiering av Rinkel och Resend

- **Vad saknas:** riktigt dial, CDR-reparation, recording-access och ett skarpt Resend-utskick
  mot verifierad avsändardomän.
- **Varför kod inte löser det:** kräver leverantörskonto, ett säkert testnummer och en
  testmottagare. Utan ett uttryckligen anvisat testmål går det inte att köra utan att
  riskera samtal eller e-post till riktiga kunder.
- **Åtgärd:** följ `docs/RINKEL_STAGING_PROTOCOL.md` med ett dedikerat testnummer och
  Resends testadresser.
- **Verifiering efteråt:** `platform_rinkel_webhook_events` och `email_delivery_events` ska
  innehålla de förväntade eventen, och `provider_webhook_events` ska inte ha rader i
  `failed`.

## Produktionsdata vid granskningen

Produktionen är i praktiken förlansering, vilket gör förändringarna ovan lågrisk att rulla ut:
2 tenants, 4 medlemskap, 2 team, 1 kund, 0 samtal, 0 avtal, 0 e-postmeddelanden. Noll rader i
`outbox_jobs` med `failed`/`dead_letter`, noll `provider_webhook_events` med `failed`, och noll
profiler utan tenantmedlemskap.
