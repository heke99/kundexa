# Session log

## 2026-07-30

- Genomförde en andra arkitektur-cutover från tenantägd till central Rinkel-plattform.
- Lade migration `202607300002_central_rinkel_platform.sql`, central katalog, allokeringar, grants, mapping v2, centrala webhookar och worker.
- Tog bort connectionbaserad webhookroute och alla exekverbara läsningar av tenantens Rinkel-credentials.
- Uppdaterade plattforms-/tenant-UI, status-API, dial, recording/transcription, OpenAPI, drift och dokumentation.
- Full `npm run verify`: PASS; SQL visar 38 migrationer, 170 tabeller, 277 funktioner och 297 policies.
- Live Supabase/Rinkel och Node 22 återstår som `NOT RUN`.

- Inventerade målkontraktet och befintliga telefoni-, outbox-, RLS-, krypterings- och dialerflöden.
- Implementerade Rinkel över den kanoniska samtalsmodellen utan parallellt CRM eller parallell samtalstabell.
- Lade tenantanslutning, katalogsynk, transaktionell användarmappning, click-to-call/power dialer, webhookingest, eventprocessning, Realtime, inspelning, transkript och Insights.
- Lade reconciliation för okända providerutfall och retention för privata Storage-objekt samt valbar providerradering.
- Stängde den gamla exekverbara 46elks/WebRTC-voicevägen och behöll 46elks enbart för SMS.
- Databasens runtimeprov hittade att `calls.callback_token_hash` krävdes; reservationen rättades med deterministisk hash.
- Säkerhetsgranskningen ersatte tenantbreda providerpolicies med roll-, team-, användar- och samtalsbaserad RLS samt säkra kolumnprivilegier.
- Senaste separata SQL-körning: PASS, 37 migrationer, 157 tabeller, 270 funktioner och 292 policies.
- Full `npm run verify`: PASS under Node 24.14.0/npm 11.9.0. Node 22 och live Supabase/Rinkel återstår.

## 2026-07-25

- Läste implementationens masterprompt och inventerade det levererade zip-arkivet.
- Installerade låsta paket med temporär npm-cache. Leveransmiljön kör Node 24, medan projektet kräver Node 22.
- Baseline typecheck/Edge check passerade. SQL-runtime hittade FAILURE-0001 i teamuppdelning.
- Lade migration `202607250001_platform_allocation_reference_hardening.sql` och regressionstest; SQL, test och build passerade.
- Säkerhetsgranskning hittade FAILURE-0002: tenantparametrerade katalog-/segment-RPC:er med för bred execute-rätt.
- Lade migration `202607250002_directory_tenant_boundary_hardening.sql`, guarded wrappers, explicita servicewrappers samt negativa tvåtenanttest.
- Rättade FAILURE-0003: discovery-route använder nu kanoniskt `directory:refresh`.
- Senaste separata SQL-körning: PASS, 32 migrationer, 145 tabeller, 246 funktioner, 273 policies och samtliga kanoniska runtimevägar.
- Etablerade beständigt projektminne och styrfiler.
- Full `npm run verify` passerade efter alla ändringar, inklusive Next.js-produktionsbuild.
- Paketerade en ren leverans utan dependencies, buildcache eller lokala hemligheter; zip-integritet verifierad.
- Den uppdaterade projektversionen ersatte den bifogade projektfilen med bibehållen filidentitet/versionhistorik.

### Rinkel-statusgranskning

- Reproducerade kodorsaken till att säljare alltid kunde se ”Rinkel är inte anslutet”: `tenant_integrations` har admin-only SELECT men statusrouten använde säljarens RLS-session.
- Ändrade statusrouten till autentiserad, explicit tenantfiltrerad service-role-läsning utan credentialexponering.
- Ändrade dialerhooken så att 500-/migrationsfel inte maskeras som en frånvarande integration.
- Paketinstallation/verifiering kunde inte köras i denna sandbox eftersom den interna npm-spegeln returnerade 404 för `pdf-lib@1.17.1`; detta är en verifieringsmiljöbegränsning, inte ett observerat projektfel.

### Rinkel lifecycle/CDR-härdning 2026-08-02

- Inspekterade masterprompt och hela zip-projektet; behöll den befintliga centrala Rinkel-modellen.
- Identifierade fyra konkreta driftluckor: okända cause-värden, inkommande kundmatchning, recordingprojektion och faktisk CDR-reparation.
- Lade framåtriktad migration, workerreparation, öppet defensivt schemasupport, provider outcome i API/UI, IP-env och regressionstester.
- `node scripts/verify.mjs`: PASS för 40 migrationer och statiska invarianter.
- Kontraktsenhetstest: PASS. Rinkel fallback-enhetstest via TypeScript-transpilering: PASS 8/8.
- `types:verify`: avsiktligt FAIL tills migrationen körts och typer genererats från staging.
- Full npm/Deno/SQL/build-gate blockerades lokalt av otillgängliga dependencies/Deno och avsaknad av länkad Kundexa staging; inga sådana steg rapporteras som godkända.

## 2026-08-07 — Genomgång av flöden, konsistens och byggkedja

Utgångsläge: `npm ci` var blockerad i tidigare miljöer, så `typecheck`, `test`, `build` och
SQL-runtime hade aldrig körts. Det visade sig vara orsaken till att flera verkliga defekter
låg kvar oupptäckta.

Gjort:

- Installerade dependencies och körde hela kedjan. Tre verkliga fel föll ut ur SQL-runtime.
- FAILURE-0012: `process_import_run` bröt mot sin egen hardening-trigger; ParseHubs
  automatiska commit var trasig i produktion. Ny migration `202608070001`.
- Två fixturfel: Rinkel-capabilities uppdaterades med `UPDATE` mot en rad som inte finns förrän
  connection-testet skapar den, och monotonicitetsfixturen hade absoluta datum som ruttnat till
  det förflutna och därför testade fel kodväg.
- FAILURE-0013 till FAILURE-0016: obegränsad tillväxt i `rate_limit_counters`, saknade
  `updated_at`-index, obegränsad klientpolling/refresh, och PostgREST-grammatik i söktermen.
- Ny driftkontroll av genererade typer, negativt testad med en canary-migration.
- Nytt testpaket `npm run test:api`.

Resultat: `npm run verify` PASS i sin helhet. Allt som kräver riktig Supabase-staging eller
riktig Rinkel-provider är fortfarande `NOT RUN` — se `open-blockers.md`.

## 2026-08-08 — cross-surface consistency remediation

- Utgick från uppladdad Kundexa-zip och bevarade 2026-08-07 hardening i stället för att duplicera den.
- Verifierade aktiva brister i platform RBAC, runtime telephony readiness, API-idempotency, product/pricing,
  compliance, Resend replay/projection, contract timezone/seller identity, SMS reconciliation och readiness.
- Lade endast en forward-only migration; inga levererade migrationer redigerades.
- Lade regressionstest till standardtestkedjan och körde det PASS efter två review-pass.
- `verify-generated-schema`: PASS. Contract delivery unit tests: PASS. Ändrad TS/TSX syntax: PASS (22 filer).
- `npm run verify` startades: `types:verify` PASS, därefter BLOCKED ENVIRONMENT på `deno: not found`.
  `npm ci` är också BLOCKED ENVIRONMENT eftersom sandboxens npm-mirror returnerar 404 för `pdf-lib@1.17.1`.
  Staging/live-provider gates är fortsatt explicit `NOT RUN`.

## 2026-08-08 — hosted DB lint follow-up

- User supplied successful hosted verify/build output and synchronized migration history through `202608080001`.
- Reviewed hosted `plpgsql_check` output and separated PostGIS extension diagnostics from Kundexa-owned defects.
- Added forward-only migration `202608080002_database_lint_runtime_hardening.sql` for pgcrypto search path,
  freshness enum typing and import-row bigint IDs.
- Static remediation regression test PASS; verify script PASS for 50 migrations.
- Full SQL replay unavailable in this sandbox because the PGlite dependency is missing; hosted push remains the decisive verification gate.

## 2026-08-08 — platform superadmin access remediation

- Reproduced source-level root cause from uploaded repo: `getPlatformContext -> getAppContext`, shared `/app` layout tenant gate, direct tenant context in Rinkel platform page/actions, and tenant-gated `switchTenant`.
- Implemented tenant-independent `getPlatformContext`, route-aware platform shell, platform-safe navigation/topbar, tenant fallback routing and support restricted landing.
- Scanned all platform pages/actions/API routes after the patch; the only remaining `getAppContext()` in `actions/rinkel.ts` belongs to the tenant-admin helper and is intentionally tenant-scoped.
- `remediation-regression-tests.mjs`: PASS. `verify.mjs`: PASS for 50 migrations/invariants. Changed TS/TSX syntax: PASS.
- `npm ci`: blocked by sandbox npm mirror 404 for `pdf-lib@1.17.1`; full `npm run verify` not claimed.
- Supabase MCP read-only aggregate check was attempted and denied by connector permissions; live role/session proof remains external.

## 2026-08-10 — debugging `enhet saknas`

- Traced the symptom from `RinkelUserMappingForm` through `get_tenant_rinkel_resources`, allocations and central device inventory.
- Root cause: central directory sync could interpret an incomplete `/users` catalog item as a complete empty device inventory and deactivate known devices.
- Verified Rinkel documents separate `GET /users` and `GET /users/:id` endpoints; implementation now hydrates detail before destructive reconciliation.
- Added a fail-closed device requirement to user allocation and richer UI diagnostics instead of the generic `enhet saknas` state.
- `remediation-regression-tests`: PASS; static `verify.mjs`: PASS for 51 migrations; custom Rinkel runtime suite: 15/15 PASS.
- Full dependency install, PGlite replay and linked Supabase proof remain external/environment-blocked and are not claimed complete.

## 2026-09-07

Uppdrag: ta reda på varför det inte går att ringa ut och göra nummertilldelning till ett klick.

Diagnos gjord mot primär evidens: Rinkels publicerade API-schema (inget device-endpoint,
`deviceId` nullbar skalär, `POST /dial` kräver `deviceId`) och det länkade produktionsprojektets
faktiska rader. Grundorsak: Kundexas devicemodell motsade leverantörens kontrakt och gjorde en
device till villkor för administration i stället för för samtal.

Åtgärdat i kod, applicerat på produktionsdatabasen efter användarens godkännande, verifierat med
full `npm run verify` samt md5-jämförelse av alla berörda funktionsdefinitioner mellan produktion
och PGlite-replayen. Torrkörning av tilldelningen mot produktionsdata (rullad tillbaka) visar att
hela kedjan utom leverantörens device är klar.

Upptäckte och backfillade en andra odokumenterad produktionsmigration, samt en strängare
`is_tenant_admin`-guard i live som repot saknade.

Kvar: extern åtgärd hos Rinkel (logga in på en enhet), därefter livetest av dial/CDR/recording.

## 2026-09-17 — Rinkel och 46elks borta, Sinch är leverantören

Bytet är genomfört hela vägen: källkod, schema, testsviter och driftdokumentation.
`npm run verify` grön i sin helhet (exit 0).

**Migrationer**: 202609170007 (telefonifunktioner utan leverantörens objektmodell),
202609170008 (`caller_id_options_for_current_user`), 202609170009 (18 tabeller,
44 funktioner, 17 kolumner droppade, med en självkontroll som fäller migrationen om
något blir kvar), 202609170010 (rättar gallringen av hängande försök).

**Tre defekter som borttagningen avslöjade**, alla samma form — ett skydd villkorat på
ett leverantörsnamn, som slutade gälla i samma stund som namnet byttes:

- `protect_rinkel_call_projection` inledde med `if old.provider<>'rinkel'`. Monotoniciteten
  var alltså avstängd för varje samtal som ringts sedan bytet: en sen händelse kunde
  backa ett avslutat samtal till "ringer".
- `complete_manual_call_work_v2` hoppade över sin normalisering av slutstatus av samma skäl.
- Min egen portering av gallringen använde `dial_attempt_holds_seat(status)`, som
  inkluderar `matched` — alltså uppkopplat. Den hade släppt säljarens plats mitt i ett
  samtal. Testsviten fångade den; den ursprungliga funktionen räknade upp statusarna en
  och en av precis det skälet.

**Kontraktet som gör bytet varaktigt**: `scripts/verify.mjs` skannar `src/`, `scripts/`
och `supabase/functions/` och fäller bygget om ett leverantörsnamn står utanför de
uppräknade adapterfilerna. Migrationer är undantagna eftersom de är historik, men ingen
migration efter borttagningen får återinföra namnet. Slutbeviset är de genererade
typerna: de läses ur det levande projektet, så ett namn där betyder att något faktiskt
finns kvar i databasen.

`.json` lades till i skanningen efter att ruttklassificeringen visat sig bära både en
borttagen rutt och tre motiveringar med leverantörens namn.

**Kvar**: allt i `next-actions.md` kräver leverantörskonto eller ett riktigt samtal.

---

## 2026-09-18/20 — Avtalsposten stod på en rad som inte gick att testa

**Två fel i samma kedja, båda hittade genom att mäta produktionen i stället för att läsa
koden.**

`testResendIntegration` (serveråtgärden) och `/api/v1/integrations/resend/test` krävde en
sparad `credentials_ciphertext` och dekrypterade den utan att använda resultatet. Kravet
var sant när API-nyckeln var företagets egen. Efter `202609180002` är nyckeln Kundexas,
och testet läser bara `from_name` och `test_recipient` -- båda i klartext. Kravet träffade
precis de rader migrationen backfillade: knappen svarade "Spara Resend-konfigurationen
först" på en integration som inte saknade något testet läser. Utan godkänt test blir
integrationen aldrig `active`, och utan `active` vägrar utskicksarbetaren. Hela
avtalsposten för båda företagen stod still där. Fixat i `10ed8d0`.

`platformEmailConfigured` i `/api/ready` är utskicksarbetarens rapport och läser
Edge-funktionens miljö. Testet körs i webbappen och läser Vercels. Två uppsättningar
variabler, satta var för sig, och den ena sa ingenting om den andra: svaret kunde vara
helgrönt medan knappen sa att kontot inte är konfigurerat. Webbappen rapporterar nu
`webEmailConfigured` (ja/nej, aldrig nyckeln). Fixat i `fe3c7d9`.

**Mönstret är samma som resten av passet**: en spärr som var riktig i en tidigare modell
och blev en fälla när modellen ändrades. Ingen av dem syntes i typkontroll, test eller
bygge -- bara i produktionens rader.

Tre nya `verify`-kontroller, alla prövade genom att återinföra felet.

**Varför SMS är avstängt** (frågan kom upp, svaret är mätt): det är defaulten i
`ensure_tenant_defaults`, och tidsstämplarna visar att flaggorna aldrig rörts -- alla utom
Gridex `contract_delivery_sms`, som slogs på ensam och därför inte gör något. Grinden
kräver båda. Dessutom finns bara ett nummer i hela systemet, `+12085810392`, med
`supports_sms = false`. Knappen som ändrar flaggorna sitter under Administration;
Integrationer visar dem men kan inte ändra dem.

## 2026-09-22 — Avtalet under produkten

Byggt enligt användarens modell (ADR-0019): migration `202609220003_contract_belongs_to_product.sql`
applicerad i produktion, typer regenererade från länkat projekt (bara den nya kolumnen och RPC:n
tillkom). "Nytt avtal" är nu kund → samtal → produkt; resten ligger under "Fler val".
Mallredigeraren har knappar som sätter in kundfält där markören står, med val för "får vara tom".

Andra flöden som var trasiga och rättades i samma pass:
- Dialern skickar säljaren till `/app/contracts/new` efter samtal, men sidan nekade säljare
  sedan PR #29 -- vägen samtal → avtal var stängd för just den som ringer.
- "Ladda upp PDF" visades för alla med `contracts.write`; åtgärden kräver författarrätt.
- "Ny produkt" visades för alla; `createProduct` kräver `products.manage` (ägare/admin).
- Formuläret för nytt avtal på mallsidan visades för säljare, som nekades efter att ha skrivit klart.

Produktionsdata: Gridex har **inga produkter**; mallen "Gridex hemsida · Mina sidor" är godkänd
men saknar produkt och är därför inte valbar förrän den kopplas. Noll avtal i databasen.

## 2026-09-23 — Webbtelefonen har aldrig registrerat sig

Produktionsgenomgång efter PR #33: alla sju arbetare friska, inga fastnade jobb, säkerhetsråden
oförändrade (PostGIS + avsiktliga definer-RPC:er). Men **ingen webbtelefonsession har någonsin
registrerats**: nio sessioner, ingen `registration_id`, inget hjärtslag efter öppnandet. Det är
därför ingen kan ringa ut.

Uteslutet: JWT:n är byte för byte lika med Sinch dokumenterade testvektor; `setSupportManagedPush`
krävs inte för app-till-telefon; SDK:ts 48h-TTL-krav gäller ett anspråk vi inte sätter.

Orsaken har varit osynlig eftersom SDK:t ersätter felet med "Unable to create instance!" och vår
`onClientFailed` loggade bara felets namn. Nu:
- SDK:t får en egen `fetchApi` som minns leverantörens senaste nej; det sparas som `close_reason`
  på sessionen.
- `/api/ready` → `checks.webphoneRegistration`: servern gör samma `POST /ocra/v2/applications/{key}/instances`
  som SDK:t och rapporterar status och leverantörens meddelande (10 min cache, ingen hemlighet ut).
- Tokenförnyelsen stängde sin egen session (ny session öppnades, hjärtslaget fortsatte mot den gamla).
- Cron-anropet till Edge-arbetarna fick 50 av 60 s; nu 40 så att "failed"-hjärtslaget hinner skrivas.

**Orsaken hittad (2026-09-23):** serverprovet i `/api/ready` gav `webphoneRegistration: ok, 200` —
nyckel, hemlighet och JWT godkänns av Sinch. Men sajtens CSP hade
`connect-src 'self' <supabase>` och blockerade därför varje anrop från webbläsaren till
`ocra.api.sinch.com` (och PubNub-signaleringen). Registreringen kunde aldrig lyckas i en webbläsare.
Rättat: `webphoneConnectSources` (`*.sinch.com`, `*.pubnub.com`, `*.pndsn.com`, https+wss) i
`connect-src`, med verify-vakt. Provet rapporterar nu även värdnamnen i Sinch svar.

## 2026-09-23 — Genomgång av hela flödet (säljare, samtal, avtal, SMS)

Fel som rättades:
- **ICE/ACE utan SVAML.** Sinch-webhooken svarade `{accepted:true}` på allt. ICE kräver en `action`
  ("If there is no response … the call is disconnected"). Nu `connectPstn` (med klientens CLI) för
  samtal från webbtelefonen till ett nummer, `hangup` för inkommande/övrigt, `continue` på ACE.
  Svaret ges även om registreringen i databasen misslyckas. Sinch har hittills skickat **noll**
  händelser (`provider_webhook_events` tom) — callback-adressen behöver registreras i Sinch.
- **"Registrera tidigare samtal" hade inga val.** Formulären läste ringlistornas `list_dispositions`
  (tom i produktion, ingen lista finns), medan `register_external_manual_call` godtar
  `manual_contract_disposition_allowed`. Nu `manualContractDispositions()` = samma regel.
- **STOPP-svar spärrade inget.** Nu spärras numret för SMS i `compliance_blocks`
  (`source = sms_opt_out_reply`), vilket `evaluate_contact_policy_for_tenant` redan läser.
- Teamledare nådde inte Produkter (krävde `products.manage`), där avtalen nu ligger.
- Säljarens meny: 16 → 6 val (Dialer, Återkomster, Mina samtal, Kunder, Ringlistor, Avtal).
- Dialern: "Öppna kundkortet" för vald kund; kortet "Säkerhetskontroller" och långa texter bort.

## 2026-09-23 — Första riktiga samtalet

Användaren testade: webbtelefonen **registrerade sig** för första gången (CSP-fixen höll), Sinch
tog emot samtalet (externt id), men det ringde inte och gick inte att lägga på; säljaren låstes.
Loggen: reservation 08:11:46, `dialing accepted` 08:11:47, sedan inga benhändelser och inget
`/calls/end`; sidan laddades om 08:12:29. Försöket stod kvar `dial_requested`.
- Lyssnaren kopplades på efter en väntan på servern → tidiga händelser förlorades. Flyttad först.
- Sinch avslutsorsak (`CallEndCause` + fel) rapporterades inte → nu `webphone.ended.detail` i
  `call_events`. **Nästa test visar varför det inte ringde.**
- Reservationen skickade aldrig `webphoneSessionId` → stängd flik släppte inte platsen (15 min lås).
  Nu skickas den, prövad i rutten mot säljarens egen levande session.
- Knappen "Lägg på/Avbryt" hängde på dialerns interna läge → nu `callId && !afterCall`.
- Det fastnade testförsöket släpptes manuellt (`call.released_by_support`, audit).
- Sinch har fortfarande skickat noll webhook-händelser: callback-URL ej registrerad.

## 2026-09-23 — Andra testsamtalet: orsaken syns, efterarbetet rättat

- Sinch avslutsorsak nu loggad: **"Failure: Unable to connect call (destination user not found)"**
  till `+12089912106` från `+12085810392`. Sinch dokumentation: ett testkonto (trial) kan bara ringa
  verifierade nummer. Kontot behöver uppgraderas eller numret verifieras i Sinch Dashboard.
- Sessionen kopplades till försöket och platsen släpptes direkt när samtalet bröts (#37 fungerar).
- **Efterarbete gick inte att spara (409 `call_not_finished`).** `complete_manual_call_work_v2`
  normaliserar `unanswered` → `no_answer`, men `calls_projection_monotonic` återställer tyst ett
  avslutat samtals status; den inre funktionen godtog inte `unanswered`. Migration
  `202609230001_after_call_work_accepts_every_finished_call.sql` (produktion + PGlite-test):
  `is_terminal_call_status` i `complete_manual_call_work` och `emit_call_webhook_event`.
  Bekräftat i produktion med rollback. Rutten ger nu svenska meddelanden i stället för rå kod.

## 2026-09-23 — Callback registrerad; första ICE; CLI utan plus

Användaren registrerade callback-URL:en. Första ICE kom 09:08:54 med `"cli": "12085810392"` (utan +),
`originationType: "MXP"`, `to: {type: number}`. Vårt svar gick utan `cli` eftersom E.164-kontrollen
krävde plus → Sinch: "Unable to connect call". Nu normaliseras siffror-utan-plus till E.164.
Sinch getting-started bekräftar: CLI ska vara testnumret tilldelat appen; testkonto når bara
verifierade nummer.

Mikrofonen: SDK:t öppnade en ny `getUserMedia` per samtal (behörighetsfråga per samtal i
Safari/Firefox). Nu en återanvänd ström per session via `mediaStreamFactory`, varje samtal får
`clone()`, släpps när dialern lämnas.

## 2026-09-23 09:18 — Test efter CLI-fixen

Två samtal 09:18:22 och 09:18:42: ICE mottagen, webhook 200 från ny driftsättning (cli skickas nu),
men Sinch avslutade efter ~1 s: "Failure: Unable to connect call". Ingen DiCE/ACE mottagen.
Kundexas sida fungerar (reservation, session, avslut, efterarbete "no_answer" sparat). Kvar hos Sinch:
testkonto → mottagaren måste vara verifierad; CLI måste vara tilldelat appen. SVAML skalat till
`connectPstn` + `cli` + `maxDuration` för att utesluta vårt svar.

Sinch loggar för samtalen 09:18: "App Call ended … GENERALERROR FAILED". Verifierat nummer och
tilldelat A-nummer bekräftade av användaren. Ingen CALLBACKERROR, så ICE-svaret godtogs; felet
uppstår på PSTN-benet. Lade till "Testsamtal" under Integrationer (admin): `ttsCallout` direkt
via Voice API från företagets förvalda nummer — skiljer konto/nummer från webbläsarvägen och
ger Sinch felmeddelande i klartext. Loggas i audit_logs (`telephony.test_call`).

## 2026-09-23 09:50 — Testsamtal ringde; ICE kopplas nu till försöket

Testsamtalet (ttsCallout, call_id fa3959bc…) ringde +12089912106 och lade på efter uppläst mening
(väntat). Konto, A-nummer, verifierad mottagare och PSTN fungerar alltså; felet sitter i
webbläsarvägen (app → PSTN). SVAML-versionen utan locale/indications (PR #40, 09:28) har ännu inte
provats från webbläsaren.

Avstämningen visade 3 `unmatched` ICE: ICE kommer ~0,5 s före klientens rapport av samtals-id.
Migration 202609230002 (tillämpad i prod): ICE utan träff på `external_call_id` matchas mot öppet
försök med samma säljare (`user`) och nummer (`to.endpoint`) från senaste 2 min och får sitt id.
PGlite-test inkl. negativt tvåtenanttest och DiCE-orsak som når samtalet. ACL oförändrad
(service_role). Ingen DiCE har kommit för något webbläsarsamtal hittills.

## 2026-09-23 12:00 — Webbläsarsamtal efter PR #40: fortfarande GENERALERROR

Sinch-logg: Incoming MXP call → Callback sent → Received partner callback response → App Call ended
GENERALERROR (≈1 s). ICE matchades nu (`processed`, 202609230002 fungerar). Ingen DiCE.
Åtgärd: `connectPstn` anger nu `number` uttryckligen (= ICE `to.endpoint`), som varje exempel i
Sinchs referens. Om det inte hjälper: supportärende hos Sinch med call-id bad86a0a-2025-448e-9f3c-bf90e92305b8.

## 2026-09-23 12:30 — PR A: samtalsutfall och automatisk listuppringning

Första riktiga webbläsarsamtalet (10:23) landade rätt: ICE/ACE/DiCE processed, completed, not_interested.
Genomgång (3 utforskningar) → migration 202609230003 (prod, ACL oförändrad):
- DiCE `failed` ersätter klientens `unanswered` (triggerundantag via `kundexa.provider_authoritative`);
  DiCE fyller längd/orsak när status redan är samma.
- Klientens `ended` på besvarat samtal → `completed` (tidigare fastnade `answered` utan DiCE).
- `finalize_dial` uppdaterar bara platshållande försök som tillhör anroparen; sen accepted = alreadySettled.
- Skip → next_attempt_at +10 min. Listor: `nix_listed` + contract_eligible för interested/order (backfill).
- Manuellt not_interested/wrong_number/dnc/nix stänger kundens öppna listplatser.
- Listutfall: next_activity_at = least(), skriver inte över.
Klient: Failure/Denied → `failed` (end-cause.ts); auto-dialern pausar på failed och efter 3 snabba
utfall; "Pausa efter samtalet" i alla faser; dial-fel pausar sessionen. calls/route.ts felväg använde
admin-klient mot finalize_dial (authentication_required) → säljarens klient. Avtalsknapp följer
tenantens manual_call_eligible_dispositions (dialer, kundkort) och listans egna utfall (samtalssidan).
