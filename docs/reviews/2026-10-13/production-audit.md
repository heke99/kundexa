# Kundexa granskning av kod databas och produktionsberedskap

**Datum:** 13 oktober 2026.
**Bedömning:** Kärnflödena bör inte godkännas för full produktion ännu. Webben och bakgrundsarbetarna är driftsatta, men det finns konkreta hinder i avtalskonfiguration, samtalsljud, signering, återhämtning och behörigheter.

## Underlag och avgränsning

Granskningen är omstartad från aktuell källkod och den körande databasen. Tidigare rapporter används inte som belägg för fynden nedan.

- Repository: heke99/kundexa, main `de852fcd5bccc6fdffc82d49c7a2611545d09e33`, 24 september 2026. GitHubs aktuella main kontrollerades på nytt.
- Produktionsdomän: www.kundexa.se. Vercel visar READY på samma commit, deployment `dpl_JBwrvBiFdKRvzBYVCvRTLbQznBnY`.
- Supabase: Kundexa, projekt `lhvifuxcqghtbiulzkrf`. Aktuella tabeller, migrationshistorik, 270 applikationsfunktioner i public/private, 296 RLS-policyer i public/storage och 182 applikationstriggers lästes.
- Den driftsatta process-outbox, version 25, hämtades. Entrypoint-koden överensstämmer med repositoryt bortsett från avslutande blankrad.
- Sinch SDK:s installerade typer och implementation lästes för ljudström och DTMF.
- Databasens lagrade driftdata är en ögonblicksbild från cirka 10.28–10.36 svensk tid. Tabellantal är inventeringsuppgifter, inte ett revisionsintyg över all historisk trafik.

Inga applikationstester, byggkontroller, verkliga samtal, kundutskick, acceptanser eller produktionsändringar genomfördes i denna omstart. Användaren tillät senare flödestester, men de konstaterade hindren går att belägga genom kod och databas. Rapporten påstår därför inte att faktisk tvåvägskommunikation eller extern leverans har verifierats.

**Prioritet:** P1 ska rättas före skarp användning av berört flöde. P2 ska rättas i stabiliseringen. **Belägg:** DB = aktuell databas; kod = implementerat kontrollflöde; villkorat = felet uppstår vid den angivna situationen. Ett bekräftat kodfel är inte detsamma som en observerad kundincident.

## Vad Kundexa ska göra

Kundexa är en gemensam arbetsplattform för flera försäljningsorganisationer. Den tänkta kedjan är:

Import eller prospektering → ett kanoniskt kundkort → listor och teamfördelning → uppringning → samtalsutfall och återkomst → produkt och godkänt avtal → SMS eller e-post → kundens besked → bevis och accepterad avtalskopia → aktivering och onboarding.

Kundkortet är kärnan. Listmedlemskap är en arbetskö, inte en separat kundkopia. Organisationerna ska vara åtskilda, och säljarens, teamledarens och administratörens åtkomst ska kontrolleras i databasen.

Den aktuella telefonin använder **Sinch i webbläsaren**. Servern reserverar samtalet; SDK:t startar det; signerade Sinch-händelser avgör koppling och utfall. Äldre Rinkel-dokument ska inte användas som produktionsinstruktion för denna version.

Avtalsleveransen använder transactional outbox, Resend för e-post och en SMS-adapter. Acceptansmodellen knyter kundens besked till dokumenthash, avtalsversion, mottagare, generation och källsamtal. BankID och extern e-signering har databasförberedelser men saknar en färdig ansluten produktionskedja.

## Aktuellt driftläge

| Område | Observation | Betydelse |
|---|---|---|
| Webb | Produktion READY på granskad commit | Driftsatt webb, inte bevis för fungerande affärsflöden |
| Workers | Sju registrerade workers hade färska healthy-hjärtslag | Schemaläggningen fungerar vid lästillfället |
| Utskickskö | 68 lagrade jobb, samtliga completed; endast telefoni-/äldre Rinkel-retention | Inga observerade fastnade utskicksjobb, men heller inga lagrade avtalsutskick |
| Avtal och meddelanden | Inventeringen visar 0 contracts, contract_deliveries, acceptances, email_messages och sms_messages | Avtalskedjan har ingen lagrad användning som kan bedömas här |
| Produkter | En aktiv produkt och en aktiv prisversion | Produktdata finns |
| Avtalsmall | En aktiv godkänd mall, product_id = NULL | Ingen produktkopplad avtalsmall för säljarens normala flöde |
| Telefonnummer | Ett aktivt röstnummer, supports_sms = false | Röstnummer finns, SMS-numret saknas |
| SMS | outbound_sms = false i båda organisationerna | SMS-utskick blockeras även om Edge-miljön rapporterar SMS-nycklar |
| E-post | Resend-integrationerna är active; webhook_status = not_configured i båda | Utskick kan vara konfigurerat, leveransåterrapportering är inte registrerad som klar |
| Telefoni | En organisation har utgående samtal påslagna; den andra saknar detta | Organisationerna är inte lika långt konfigurerade |
| Samtal | 18 lagrade samtal, inklusive completed, failed, unanswered, busy och cancelled | Historik och webhookprojektioner finns; detta bevisar inte hörbart ljud |
| Webphone | Alla inventerade sessioner är closed eller lost; senaste hjärtslag 24 september | Ingen aktiv webphone vid lästillfället; normalt när ingen arbetar |
| Datakälla | Aktivt allabolag-jobb; 13 fel med legacy_direct_scraper_disabled_use_parsehub | Jobbet är fortfarande schemalagt till en avstängd väg |
| Storage | De fyra verksamhetsbucketarna är privata | En bra grund för dokument och inspelningar |

## Fynd som hindrar försäljningskedjan

### KX26 01 Produkten saknar kopplat avtal — P1 — DB och kod

Den enda godkända mallen har `product_id = NULL`. Sidan för nytt avtal läser endast aktiva mallar med produktkoppling, och server action söker mall på vald produkt. Produkten kan därför inte användas för att skapa avtal i säljarens normala flöde.

**Rätta:** Koppla en färdig, godkänd mall till rätt produkt och kontrollera målgrupp, juridisk avsändare och prisversion. Att endast ha en fristående godkänd mall räcker inte.

**Källa:** `contract_templates`; `src/app/(dashboard)/app/contracts/new/page.tsx:51–81`; `src/app/actions/contracts.ts:106–129`.

### KX26 02 Godkänd mall innehåller fortfarande ofärdiga villkor — P1 — DB

Mallens villkor avslutas med: ”Här ska tenantens juridiskt granskade fullständiga villkor anges innan versionen godkänns.” Versionen är ändå approved.

**Rätta:** Ersätt instruktionstexten med de avsedda slutliga villkoren och godkänn en ny mallversion. Detta är ett konstaterat innehålls-/godkännandefel; rapporten tar inte ställning till avtalets juridiska giltighet.

**Källa:** Aktuell `contract_template_versions.terms_template`, `status` och `approved_at`.

### KX26 03 Prisdata saknar värden som den godkända mallen kräver — P1 — DB och kod

Prisversionens `binding_months` och `notice_months` är NULL. Mallen använder båda som obligatoriska variabler. `renderStrictTemplate` avvisar NULL utan valfri markering.

**Konsekvens:** Efter rättad produktkoppling uppstår ytterligare ett hinder om säljaren inte manuellt fyller i dessa värden.

**Rätta:** Sätt avsedda produktvillkor eller skriv medvetet valfria mallfält med korrekt text för avtal utan bindning/uppsägningstid. Godkänn mallen mot faktisk produktdata.

**Källa:** `product_price_versions`; aktuell mall; `src/lib/domain/template.ts:43–56`; `src/app/actions/contracts.ts:162–180`.

### KX26 04 SMS-avtal är inte konfigurerade för drift — P1 för SMS — DB

`outbound_sms` är avstängt. Det enda numret har `supports_sms = false`. `sms_acceptance` och `inbound_sms` är också avstängda. I den ena organisationen är `contract_delivery_sms` påslaget, men den flaggan ensam räcker inte.

**Rätta:** Tilldela ett SMS-kompatibelt nummer med korrekt callbacktoken och konfigurera kanalerna som ska erbjudas. SMS-svar kräver dessutom mottagning och acceptans aktiverade. E-post med webbacceptans kan vara ett separat första leveransmål.

**Källa:** `tenant_features`, `phone_numbers`; `delivery-readiness.ts`; `process-outbox/index.ts:177–243`.

### KX26 05 Leveranswebhookar för e-post är inte registrerade som klara — P1 för leveransstatus — DB och kod

Båda Resend-integrationerna har `webhook_status = not_configured`. Den ena saknar även credentials_ciphertext. Webhookrutten kräver en matchande tokenkonfiguration och ett dekrypterbart signing secret. Arbetarens centrala e-postnyckel innebär inte att denna separata webhookkonfiguration är klar.

**Rätta:** Konfigurera och verifiera Resend-webhooken för det gemensamma kontot, med korrekt endpointtoken och signaturhemlighet. Skilj ”leverantören tog emot mejlet” från ”mejlet levererades”. Extern Resend-konfiguration lästes inte här.

**Källa:** `tenant_integrations`; `src/app/api/webhooks/resend/[token]/route.ts:37–56`.

## Telefoni och dialer

### KX26 06 Kundens ljudström spelas inte upp — P1 — kod och SDK

SDK:t exponerar `call.incomingStream`. Kundexas adapter kopplar aldrig denna ström till ett audio-element eller motsvarande uppspelning. Det audio-element som finns i ljudhooken spelar endast en lokal testton. Även installerad SDK-kod lästes: den håller fjärrströmmen men erbjuder här ingen automatisk ljuduppspelning.

**Rätta:** Koppla fjärrströmmen till faktisk uppspelning, hantera autoplayfel och vald utgång, och städa vid avslut. En ringstatus eller testton räcker inte för att godkänna samtalsljudet.

**Källa:** `use-sinch-webphone.ts:326–384`; `use-audio-devices.ts:221–245`; Sinch `Call.d.ts` och `DefaultCall.js:193–194`.

### KX26 07 Rapporteringsfel kan få UI att tappa ett startat samtal — P1 — villkorat kodfel

Efter lyckad `callPhoneNumber` sparas SDK-samtalet, men `placeCall` inväntar därefter HTTP-rapporteringen till `/calls/dialing`. Ett nätverksfel kastas vidare. Dialerhooken sätter då calling=false och kastar, innan panelen har sparat callId. Panelens lägg-på-funktion returnerar när callId saknas.

**Konsekvens:** Ett leverantörssamtal kan ha startat medan panelen behandlar det som misslyckat och saknar normala kontroller.

**Rätta:** Bevara callId/attemptId före SDK-start. Skilj ett rapporteringsfel från ett faktiskt uppringningsfel. Behåll lägg-på-kontrollen och återförsök rapporteringen med samma identitet.

**Källa:** `use-sinch-webphone.ts:365–384`; `use-dialer.ts:212–224`; `dialer-panel.tsx:153–181`.

### KX26 08 Förlorat reservationssvar saknar säker återhämtning — P1 — villkorat kodfel och DB-definition

Vid ett förlorat eller oläsbart svar från `/calls` markeras utfallet som okänt. Servern har då endast reserverat; webbläsaren har ännu inte startat SDK-samtalet. Panelen saknar callId och får ingen normal uppföljning. Replay returnerar inte destinationen, och klienten antar att ett replayat samtal redan är uppkopplat. Listdialern fångar dessutom alla fel som om samtalet aldrig kom iväg och försöker pausa.

**Rätta:** Behåll stabil requestidentitet, återläs samma reservation och skilj reserverat, SDK-startat, leverantörsokänt och avslutat. Återuppta bara när det är säkert att ringa. Pausflödet måste förstå okända utfall.

**Källa:** `use-dialer.ts:130–201`; `list-dialer-workspace.tsx:185–203`; live `reserve_outbound_call`; `calls/route.ts:274 ff`.

### KX26 09 Uppstart fastnar efter nätverksreject — P2 — villkorat kodfel

`start` sätter startedRef=true före sessionsanropet. Sessionsanropet ligger utanför try/catch. Ett nätverksreject lämnar spärren satt, och senare startanrop returnerar direkt.

**Rätta:** Lägg hela uppstarten under felhantering och återställ ett retrybart läge.

**Källa:** `use-sinch-webphone.ts:178–185,239–315`.

### KX26 10 Vald mikrofon och högtalare används bara i ljudkontrollen — P2 — kod

Ljudhooken sparar enhetsval och använder dem för mätare/testton. Samtalsadaptern läser inte valen och anropar inte SDK:ts `setAudioTrackConstraints`.

**Rätta:** Använd gemensamt ljudtillstånd för kontroll och verkligt samtal. Applicera mikrofonens deviceId på SDK och utgång på fjärrljudets element.

**Källa:** `use-audio-devices.ts:34–35,178–180,232–238`; `use-sinch-webphone.ts`; SDK `CallClient.d.ts`.

### KX26 11 DTMF använder fel SDK-metod — P2 — kod och SDK

Kundexa kontrollerar och anropar `sendDTMF`. Installerad Sinch SDK har `sendDtmf`. Den egna typen och casten döljer skillnaden.

**Rätta:** Använd riktig SDK-typ och metod. Annars erbjuds inte fungerande knappval till telefonmenyer.

**Källa:** `use-sinch-webphone.ts:53,369,416–420`; SDK `Call.d.ts:74`, `DefaultCall.js:96`.

## Avtalsacceptans och utskick

### KX26 12 OTP-signering nekas på grund av fel metod — P1 när OTP används — kod och live DB-definition

Webbacceptansen skickar alltid p_method=web; SMS-rutten skickar sms. Den körande `record_contract_acceptance_v3` kräver däremot email_otp eller sms_otp för motsvarande signaturpolicy. Rätt kod löser inte metodkonflikten. Nuvarande mall använder simple_click, så detta är ett fel i den erbjudna OTP-vägen, inte ett påstående om pågående OTP-kundincidenter.

**Rätta:** Härled och validera avsedd metod från låst signaturpolicy; kombinera den med verifierad kanal och kod.

**Källa:** `public-contract.ts:64–71`; `webhooks/sms/inbound/route.ts:165 ff`; live `record_contract_acceptance_v3`.

### KX26 13 API-utskick ger andra svarsinstruktioner än UI — P1 när berörda policyer används — kod

API-tjänsten lämnar ingen acceptanceCode till e-postrenderingen och SMS-texten instruerar alltid kunden att svara JA/NEJ. UI beräknar kodkravet och kontrollerar vilka svarssätt som är aktiva. Databasen kan kräva kod även vid API-utskick.

**Rätta:** Låt UI och API använda en gemensam utskicksplan för policy, kod, kanaler och texter. Kontrollera att det finns ett tillåtet svarssätt.

**Källa:** `api-service.ts:262–289`; `actions/contracts.ts:630–656`; live `prepare_contract_delivery_v2`.

### KX26 14 API-idempotens är inte knuten till resurs och requestinnehåll — P2 — kod

Replay söker tenant + action + request_id, utan att jämföra contractId eller requesthash. Samma nyckel för avtal A och B kan återge A:s resultat när B begärs. Mönstret finns även för påminnelse och förlängning.

**Rätta:** Bind nyckeln till operation, resurs och kanonisk requesthash. Ändrad avsikt med samma nyckel ska ge konflikt. Detta fynd är inte en bevisad läcka mellan tenants.

**Källa:** `api-service.ts:86–95,204–206,301–303,320–322`.

### KX26 15 Jobb i processing återtas inte efter avbruten worker — P1 — kod och live DB-definition

`claim_outbox_jobs` tar bara pending/failed och sätter processing. Ingen outboxåtertagning hittades i de lästa funktionerna eller underhållsworkern. Om arbetaren dör efter claim blir jobbet kvar i ett läge som nästa arbetare inte väljer. Vid lästillfället fanns inga sådana jobb.

**Rätta:** Inför tidsbegränsade leases, ägarskyddad färdigmarkering och återtagning som först avgör om ett externt utskick redan skett.

**Källa:** Live `claim_outbox_jobs`, `complete_outbox_job`, `fail_outbox_job`; `maintenance-worker/index.ts`.

### KX26 16 Utskicksarbetaren ignorerar kritiska databasfel — P1 — driftsatt kod

Flera SMS-skrivningar, leverans-/påminnelseprojektioner och complete/fail/dead-letter-RPC:er läser inte error. Arbetaren kan därför returnera completed trots att rätt status eller leverantörsidentitet inte sparats. E-postens första lagring av provider_message_id har däremot explicit felkontroll.

**Rätta:** Kontrollera varje kritisk retur, gör statusuppdateringarna atomiska och särskilj extern acceptans från lokal färdigmarkering. Återförsök ska reparera projektionen, inte bara hoppa över posten när provider_message_id finns.

**Källa:** `process-outbox/index.ts:236–258,297,369–373,1053–1077`; driftsatt version 25.

### KX26 17 Resends tillfälliga 409-konflikt blir permanent stopp — P1 — kod och providerreferens

Alla HTTP 409 klassas permanent. Resend skiljer mellan ändrad payload och ett redan pågående anrop med samma nyckel; det senare kan återförsökas senare.

**Rätta:** Klassificera på felkod och bevara samma nyckel samt oförändrad payload för återförsök.

**Källa:** `process-outbox/index.ts:346–352`; [Resends idempotensreferens](https://resend.com/changelog/idempotency-keys).

### KX26 18 Avbrutet SMS kan få avtalsleveransen markerad sent — P2 — villkorat kodfel

Vid SMS-avstämning kan adapterstatus vara failed, men contract_deliveries sätts till delivered endast för delivered och annars sent. Påminnelsen markeras samtidigt sent.

**Rätta:** Använd en fullständig statusmappning för failed, created, sent och delivered, med samma utfall på meddelande och avtalsleverans.

**Källa:** `process-outbox/index.ts:198–217`; `functions/_shared/sms-provider.ts`.

### KX26 19 Tidig e-postwebhook kan förbli unmatched — P2 — villkorat kodfel

Resend-händelsen matchas på provider_message_id som sparas efter send-svaret. Kommer händelsen innan denna skrivning hittas ingen e-postrad. Rutten sparar unmatched och svarar 200. Ingen automatisk återprojektion av dessa e-posthändelser hittades i de granskade workerflödena.

**Rätta:** Behåll händelsen för senare avstämning och återförsök matchning när send-identiteten lagrats.

**Källa:** `webhooks/resend/[token]/route.ts`; `process-outbox/index.ts:319–365`; maintenance-worker.

### KX26 20 Bekräftelsen väljer senaste dokumentet i stället för acceptansens dokument — P2 — villkorat kodfel

Bekräftelseworkern väljer senaste signed_pdf/evidence_pdf för hela avtalet utan filter på acceptance_id, request, generation eller accepterad version. Ett fördröjt jobb kan därför bifoga en annan acceptansgeneration.

**Rätta:** Slå upp dokumenten med samma acceptans, generation och version som jobbet. Bind beroendet till färdigt bevispaket.

**Källa:** `process-outbox/index.ts:668–698`.

### KX26 21 Bevis-PDF kan namnge fel utställande bolag — P2 — kod

Bevis-PDF:s avtalsparter använder tenantens legal_name och aktuellt kundnamn. Själva avtalet och utskicken kan använda ett annat juridiskt bolag från seller_snapshot.

**Rätta:** Använd låsta partsuppgifter från den accepterade avtalsversionen för både bevis och avtalskopia.

**Källa:** `process-outbox/index.ts:580–622`.

## Behörigheter och dataintegritet

### KX26 22 Läsroller får skriva kunddata direkt — P1 — live RLS och kod

`customers_scoped_update` använder can_access_customer_row som tillåter bland annat viewer, finance och quality. Insertpolicyn kräver endast aktivt medlemskap. authenticated har INSERT/UPDATE. De lästa customertriggers begränsar inte dessa roller; can_write_customer finns men används inte här.

**Konsekvens:** Appens låsta knappar räcker inte. En inloggad läsroll kan använda databasens API för att skapa eller ändra kundposter inom sin åtkomst.

**Rätta:** Använd verklig skrivbehörighet i INSERT/UPDATE och kontrollera ansvarig användare/team samt fält som ändrar kontaktpolicy. Behåll läsregeln för SELECT.

**Källa:** Live policyerna customers_tenant_insert/customers_scoped_update, can_access_customer_row/can_write_customer, tabellprivilegier och customertriggers; `permissions.ts`.

### KX26 23 Avtalsstatus kan ändras förbi aktiveringskontroller — P1 — live RLS och triggerdefinition

contracts_writer_update tillåter bred UPDATE för can_write_contract. Triggern protect_contract_signing_projection kontrollerar accepted/signed men inte övergång till active. Därmed har en avtalsoperatör en direkt databasväg till active som inte går genom activate_completed_contract med roll-, acceptans- och beviskontroller. Mottagarens status/required är också direkt skrivbara för avtalsoperatörer.

**Rätta:** Skydda status, generation, mottagarens signeringsstatus och obligatoriska signatärer genom kontrollerade RPC:er och en tillståndsmaskin. Tillåt endast avsedda redigerbara fält direkt.

**Källa:** Live contracts_writer_update, contract_recipients_contract_update, protect_contract_signing_projection och activate_completed_contract.

### KX26 24 Geografisk referenstabell saknar RLS och har publika skrivrättigheter — P1 — DB

public.spatial_ref_sys har RLS avstängt. anon och authenticated har bland annat SELECT, INSERT, UPDATE och DELETE. Detta är en exponerad PostGIS-referenstabell, inte en konstaterad läcka av CRM-kunduppgifter. Supabases säkerhetsrådgivare flaggar den också.

**Rätta:** Ta bort obehövliga skrivprivilegier och välj en genomtänkt placering/åtkomstmodell för PostGIS. Flytta inte extension eller slå på godtyckliga policyer utan att kontrollera beroenden.

**Källa:** pg_class, role_table_grants och security advisor. [Supabases åtgärdsreferens](https://supabase.com/docs/guides/database/database-linter?lint=0013_rls_disabled_in_public).

### KX26 25 API-nyckeln kontrollerar medlemskap men inte tenantens driftstatus — P1 för API — kod

API-nyckelgrenen kontrollerar nyckel, scopes och aktiv owner/admin. Den kontrollerar inte tenants.status/onboarding_status. dataClientForIdentity använder därefter service-role. Kund-API:t läser och skriver då utan RLS-statusspärren i current_tenant_id.

**Konsekvens:** En framtida eller befintlig giltig API-nyckel kan behålla kundåtkomst efter att företaget pausas, om medlemskapet fortfarande är aktivt. Inventeringen visar inga API-nycklar nu.

**Rätta:** Kontrollera tenantens tillåtna status centralt för varje API-identitet före service-role-arbete. Följ samma onboarding-/avstängningsregel som webben.

**Källa:** `api-auth.ts:27–71`, dataClientForIdentity; `api/v1/customers/route.ts`; live current_tenant_id.

## Drift och datakällor

### KX26 26 Ready kan rapportera grönt med blockerade huvudfunktioner — P1 för driftgodkännande — kod

Efter lyckad databasläsning returnerar /api/ready status=ready och HTTP 200 även om telefoni, URL, webphone eller leveranskonfiguration är blockerad. Detaljfält finns, men de påverkar inte huvudstatusen. Outboxrapportens ålder används inte som friskhetsgräns.

**Rätta:** Separera liveness från verklig readiness. Definiera obligatoriska kontroller för vald produktionsprofil och returnera degraded/not_ready när de brister.

**Källa:** `api/ready/route.ts:122–172`.

### KX26 27 Ett aktivt datakällejobb använder en avstängd adapterväg — P2 eller P1 om prospektering krävs — DB och kod

Ingestion-jobbet har adapter allabolag och är fortfarande active, med nästa körning 14 oktober. Det saknar lyckad completion. 13 lagrade fel anger legacy_direct_scraper_disabled_use_parsehub. Workern avvisar uttryckligen äldre direktskrapning.

**Rätta:** Pausa/ersätt den gamla schemaläggningen och konfigurera den avsedda ParseHub-/avtalade datakällekedjan. Kontrollera behörigheter, mapping och vad som landar i kundlistan. En healthy worker utan tilldelat jobb betyder inte att detta jobb fungerar.

**Källa:** ingestion_jobs, ingestion_errors; `ingestion-worker/index.ts:237`.

### KX26 28 Underhållsfel i delresultat kan döljas av healthy — P2 — kod

Maintenance-workern kan lägga failed i segmentResults eller retentionResults utan att huvudsteget kastar. Scheduler-sammanfattningen räknar främst results/jobs och läser inte dessa nästlade resultat. Underhåll kan därför redovisas healthy trots delfel. Detta är inte ett påstående om ett pågående sådant fel.

**Rätta:** Returnera explicita totalsiffror och låt huvudstatus inkludera alla obligatoriska delsteg.

**Källa:** `maintenance-worker/index.ts:55–65,81–105`; `scheduled-edge-worker.ts:summarizeWorkerResult`.

## Saknad eller ofärdig omfattning

Dessa delar ska inte räknas som färdiga enbart därför att det finns tabeller eller dokumentation:

| Funktion | Bedömning av granskad version |
|---|---|
| BankID och extern e-signering | Datamodell/finaliserings-RPC finns; ingen konkret signeringsintegration/orchestrering hittades. Vanliga send-funktionen avvisar bankid/external_esign. |
| Flera signatärer och signeringsordning | Modell finns; det normala avtalsutskicket skapar en mottagare per ny generation. En full produktionsresa för flera signatärer är inte etablerad här. |
| Inkommande samtal | Funktionsflaggorna är av och Sinch SVAML lägger på inkommande PSTN. Detta är inte en fungerande inkommande växel. |
| Medlyssning, coachning och prediktiv dialer | Anges som framtida/extern mediamotor i projektets omfattningsdokument. |
| Inspelning, transkribering och AI-analys | Avstängt i båda tenantpolicyerna. Delar av äldre recordingjobben stoppas i workern. Kräver separat aktuell providerkedja om det ska säljas. |
| Betald SaaS-debitering | Projektets omfattningsdokument anger att faktisk betalprovider inte är inkopplad. usage_limits är tom i inventeringen. |
| Automatisk NIX-källa | Inga konfigurationer/checkar i inventeringen. Ena organisationen använder pre_screened_source. Det ersätter inte en verifierad automatisk NIX-integration när en sådan utlovas. |
| Geografiskt referensregister | geographic_areas är tom. PostGIS spatial_ref_sys är inte det avsedda kommun-/län-/postnummerregistret. |
| MFA för admin | Ingen enforcement hittades i granskad app-/migrationskod. Separat driftskydd kan finnas men har inte verifierats. |
| Backup/restore, larm och kapacitet | Ska få verifierade driftkrav. READY/healthy räcker inte som bevis för återställning eller kapacitet. |

Övriga säkerhetsråd från live advisor: läckta lösenordsskyddet är avstängt; citext/pg_trgm/postgis ligger i public; tre PostGIS SECURITY DEFINER-overloads är anon-körbara. De 108 authenticated-körbara SECURITY DEFINER-funktionerna är inte automatiskt 108 sårbarheter: flera innehåller uttryckliga roll-/objektkontroller. Privata tabeller med RLS utan policy kan vara avsiktligt service-only.

[Supabase lösenordsskydd](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).

## Rekommenderad väg till produktion

### 1 Stäng behörighetsluckorna

Rätta kundskrivpolicyerna, avtalsstatus-/mottagarskydden, spatial_ref_sys och tenantstatuskontrollen för API-nycklar. Gå igenom service-only-gränserna och vilka interna jobb vanliga användare får skapa. RLS finns brett, men en påslagen RLS-flagga är inte samma sak som korrekt auktorisering.

### 2 Gör en produkt komplett

Välj en första produkt och målgrupp. Koppla slutlig godkänd avtalsmall, juridiskt bolag och komplett giltig prisversion. För den nuvarande datan måste produktkopplingen, instruktionsvillkoren och obligatoriska prisfält rättas innan den vanliga säljarresan går fram.

### 3 Rätta samtalsadaptern

Implementera fjärrljud och verkliga enhetsval, rätt SDK-metoder, återstart och bevarad samtalsidentitet vid nätverksfel. Avgränsa första telefonilanseringen till fungerande utgående samtal och befintlig listdialer. Inkommande växel och avancerad telefoni får egna godkännandekriterier.

### 4 Slut avtalskedjan för en kanal först

E-post med webbacceptans är närmast nuvarande konfiguration. Rätta även OTP och API:s policy-/kodrendering innan dessa metoder erbjuds. Sätt upp leveranswebhooken. Välj därefter SMS-nummer och aktivera den avsedda SMS-vägen.

### 5 Gör kö och bevis återstartbara

Inför outboxlease/återtagning, kontrollerade DB-skrivningar, korrekt leverantörsfelklassificering, avstämning för tidiga webhooks och acceptansbundna bevis/bilagor. Ett avbrutet jobb ska kunna återupptas utan dubbla utskick eller felaktigt gröna statusar.

### 6 Gör grönt till ett tydligt driftbesked

Readiness ska avspegla vald telefoni-/utskicksprofil, senaste workerframgång och kvarvarande/blockerade jobb. Larm ska gå på staleness, dead letter och upprepade leveransfel. Rätta nästlade workerresultat och det avstängda datakällejobbet.

### 7 Godkänn begränsade verkliga flöden efter rättning

Använd en kontrollerad testorganisation och kända mottagare. Godkänn genom sammanhängande belägg:

- Samtal: reservation → leverantörsidentitet → ljud åt båda håll → avslut → sparat utfall → nästa lead.
- Avtal: produkt → korrekt PDF och priser → kö → provideracceptans → leveranshändelse → öppning → accept/avstå → låst generation → rätt bevis/bilaga → aktivering/onboarding.
- Fel: tappat reservationssvar, rapporteringsfel efter SDK-start, avbruten worker, tidig webhook och samma idempotensnyckel med ändrad resurs.
- Behörigheter: läsroller kan inte skriva; säljare når bara tillåtna resurser; avstängd tenant/medlem blockeras; två organisationer kan inte påverka varandras data.

Tester ska styrkas av koden och den slutliga databasstatusen. Ett test som bara söker efter en kodsträng eller upprepar en handskriven SDK-mock är inte tillräckligt.

## Grönt ska betyda

| Område | Kriterium |
|---|---|
| Försäljning | En riktig produkt går från samtal till accepterat och aktiverat avtal med rätt dokument och pris |
| Telefoni | Kunden och säljaren hör varandra; det går att lägga på även efter rapporteringsfel |
| Leverans | Provideracceptans, faktisk leverans och felstatus hålls åtskilda och når säljarvyn |
| Kö | Avbrott lämnar inga jobb permanent i processing; återförsök ger ingen oavsiktlig ny leverans |
| Behörighet | App, API, RPC, RLS och Storage har samma rättigheter |
| Bevis | Partsuppgifter, PDF, hash, version och generation stämmer för den aktuella acceptansen |
| Drift | Readiness blir röd när en obligatorisk huvudfunktion är blockerad; workerproblem syns och larmas |

Bedömningen gäller den granskade versionen och konfigurationen. Det finns en tydlig fungerande grund med kanoniskt kundregister, atomiska reservationer, dokumenthashar, generationer, privata bucketar och aktiva workers. Det som återstår är att täppa till ovanstående luckor och godkänna den sammanhängande försäljningskedjan. Systemet kan inte kallas helt produktionsklart enbart för att deployen är READY.

## Kodreferenser

Alla filhänvisningar avser samma granskade commit:

- [Webbtelefon](https://github.com/heke99/kundexa/blob/de852fcd5bccc6fdffc82d49c7a2611545d09e33/src/hooks/use-sinch-webphone.ts)
- [Dialerhook](https://github.com/heke99/kundexa/blob/de852fcd5bccc6fdffc82d49c7a2611545d09e33/src/hooks/use-dialer.ts)
- [Avtalsåtgärder](https://github.com/heke99/kundexa/blob/de852fcd5bccc6fdffc82d49c7a2611545d09e33/src/app/actions/contracts.ts)
- [Avtals-API](https://github.com/heke99/kundexa/blob/de852fcd5bccc6fdffc82d49c7a2611545d09e33/src/lib/contracts/api-service.ts)
- [Publik acceptans](https://github.com/heke99/kundexa/blob/de852fcd5bccc6fdffc82d49c7a2611545d09e33/src/app/actions/public-contract.ts)
- [Utskicksarbetare](https://github.com/heke99/kundexa/blob/de852fcd5bccc6fdffc82d49c7a2611545d09e33/supabase/functions/process-outbox/index.ts)
- [API-autentisering](https://github.com/heke99/kundexa/blob/de852fcd5bccc6fdffc82d49c7a2611545d09e33/src/lib/api-auth.ts)
- [Produktkrav](https://github.com/heke99/kundexa/blob/de852fcd5bccc6fdffc82d49c7a2611545d09e33/docs/PRODUCT_REQUIREMENTS.md)
