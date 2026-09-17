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
- [x] Webhookvärden kan inte glida isär från appvärden
      Evidens: `expectedWebhookUrl()` i `src/lib/env.ts` härleds ur `NEXT_PUBLIC_APP_URL`
      och ingenting annat, så de två kan inte längre sättas oberoende av varandra.
      Testat i `scripts/api-core-tests.ts` (arv, trailing slash, värdnamn, oanvändbar app-URL).
      Tidigare föll den tillbaka på literalen `"https://kundexa.se"`, vilket är hur
      produktion kunde servera länkar för `www` medan webhookarna pekade på apex.
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
- [ ] `NEXT_PUBLIC_APP_URL` och `APP_URL` är satta till
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

## 4. Telefoni (Sinch)

Central integration: serverns nycklar, företagets egna nummer, ingen
telefonicredential per tenant och ingenting att provisionera per säljare.
Uppsättningen i detalj står i `docs/integrations/telefoni.md`.

- [x] Webbläsaren är telefonen, servern kopplar aldrig själv
      Evidens: `reserve_outbound_call` reserverar och stannar; `scripts/verify.mjs`
      fäller en dialrutt som växer ett eget `fetch` eller anropar leverantörens klient.
- [x] Applikationshemligheten når aldrig webbläsaren
      Evidens: endast `serverEnv()`, ingen `NEXT_PUBLIC_`-variant. Klienten får en
      kortlivad JWT som servern signerat (`src/lib/telephony/sinch/registration-token.ts`).
- [x] Callbacken är signaturverifierad
      Evidens: `verifySinchCallback` i `src/lib/telephony/sinch/callback-signature.ts`,
      HMAC-SHA256 över de fem dokumenterade raderna, tidsgräns 300 sekunder,
      tidskonstant jämförelse. Prövat i `scripts/sinch-unit-tests.mts`, inklusive en
      förfalskad och en återuppspelad callback.
- [x] En händelse som inte kan prövas behandlas inte
      Evidens: 403 utan orsak när signaturen inte håller, 503 när nycklarna saknas så
      att leverantören gör om leveransen, 200 för händelser vi inte behandlar.
- [x] Ett samtal utan A-nummer startas aldrig
      Evidens: adaptern vägrar med `webphone_caller_id_missing`. Leverantören svarar
      annars med ett samtals-id för ett samtal som aldrig når mottagaren.
- [x] En säljare har en plats i taget, och platsen går alltid att få tillbaka
      Evidens: `dial_attempts_one_open_per_seller_uidx`, och fyra vägar ur den —
      säljaren avslutar, webbtelefonen rapporterar att benet dog, sessionen tappar
      registreringen, och `release_stale_dial_attempts` i maintenance-workern.
      Den sista rör aldrig ett uppkopplat samtal.
- [ ] Callback-adressen är registrerad i leverantörens kontrollpanel och matchar
      den värd appen faktiskt serveras på
      Adressen skrivs in för hand och går inte att läsa tillbaka. `GET /api/ready`
      rapporterar `checks.webhookUrl` — den adress den borde vara. Se *Externa åtgärder*.
- [ ] Ett riktigt samtal har ringts och dess händelser tagits emot
      Kedjan är verifierad i replay och i enhetstest, men inte live. Ett testsamtal
      räknas först när webbtelefonen registrerat sig, destinationen faktiskt ringt och
      händelserna observerats på `/api/webhooks/sinch`.
- [ ] Numren är köpta eller portade med svensk originering
      Ett svenskt nummer som origineras utomlands blockeras av operatörerna enligt
      PTS föreskrift. Det avgör både om samtalet kopplas och minutpriset.
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
      `test` = regressionstester, PGlite-runtime, telefoni-, kontrakts-, import- och
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

Redirecten är inte kosmetisk. Callback-adressen registreras för hand hos leverantören,
och en leverans som möter en 308 tappas av varje avsändare som inte följer redirect.
Då får samtalet aldrig sitt utfall.

### 2. Sätt bas-URL:erna till `https://kundexa.se`

- **Vad saknas:** `GET /api/ready` svarar `"appBaseUrl":"https://www.kundexa.se"`. Appen
  bygger alltså länkar för `www` medan produkten ska ligga på apex.
- **Varför kod inte löser det:** det är miljövariabler i Vercel och Supabase, inte i repot.
- **Åtgärd:** sätt `NEXT_PUBLIC_APP_URL` till `https://kundexa.se` i Vercel
  Production/Preview och `APP_URL` via `supabase secrets set`. Callback-adressen härleds
  numera ur app-URL:en och kan inte sättas oberoende, så det finns ingen andra variabel
  att hålla i synk.
- **Verifiering efteråt:** `curl -s https://kundexa.se/api/ready` ska visa
  `"appBaseUrl":"https://kundexa.se"` och `"appBaseUrlUsable":true`.

### 3. Registrera callback-adressen hos leverantören

- **Vad saknas:** adressen skrivs in för hand i leverantörens kontrollpanel och går inte
  att läsa tillbaka via deras API.
- **Varför kod inte löser det:** det finns ingen endpoint att registrera den med, så
  koden kan bara rapportera vilken adress den borde vara.
- **Åtgärd:** sätt callback-URL:en till värdet i `checks.webhookUrl` från
  `GET /api/ready`, alltså `https://kundexa.se/api/webhooks/sinch`.
- **Verifiering efteråt:** ett testsamtal ska ge rader i `provider_webhook_events` med
  `provider='sinch'`, och samtalets status ska röra sig utan att någon rör databasen.

### 4. Nummer med svensk originering

- **Vad saknas:** numren behöver köpas eller portas hos leverantören så att de origineras
  i Sverige.
- **Varför kod inte löser det:** det är ett avtals- och nummerärende hos leverantören.
- **Åtgärd:** köp eller porta numren. Detta avgör två saker: ett svenskt nummer som
  origineras utomlands blockeras av de svenska operatörerna enligt PTS föreskrift, och
  originerings­prefixet styr minutpriset.
- **Verifiering efteråt:** ett testsamtal till ett svenskt mobilnummer kopplas och visar
  rätt A-nummer hos mottagaren.

### 5. Live-verifiering av telefoni och Resend

- **Vad saknas:** ett riktigt samtal hela vägen, och ett skarpt Resend-utskick mot
  verifierad avsändardomän.
- **Varför kod inte löser det:** kräver leverantörskonto, ett säkert testnummer och en
  testmottagare. Utan ett uttryckligen anvisat testmål går det inte att köra utan att
  riskera samtal eller e-post till riktiga kunder.
- **Åtgärd:** ring från dialern till ett dedikerat testnummer, och skicka ett avtal till
  Resends testadresser.
- **Verifiering efteråt:** `provider_webhook_events` och `email_delivery_events` ska
  innehålla de förväntade eventen, och inga rader i `failed`.

## Produktionsdata vid granskningen

Produktionen är i praktiken förlansering, vilket gör förändringarna ovan lågrisk att rulla ut:
2 tenants, 4 medlemskap, 2 team, 1 kund, 0 samtal, 0 avtal, 0 e-postmeddelanden. Noll rader i
`outbox_jobs` med `failed`/`dead_letter`, noll `provider_webhook_events` med `failed`, och noll
profiler utan tenantmedlemskap.
