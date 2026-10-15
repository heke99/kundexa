# Next actions

## 2026-10-15 Produktionsrelease verifierad

Första praktiska operatörssteg: logga in www.kundexa.se/app/integrations och välj Registrera leveranskvitton automatiskt (befintligservernyckel, inga secrets visas). Signeradeevent gör webhookactive, healthreadyblirdåomvärderad peraktivtenant. Förnya GitHub SUPABASE_ACCESS_TOKEN via säkraGitHubSettings för framtidaEdgeautomation. ProviderägdaPostGISrättigheter/Authskydd/Sinchpatch hanterasmed rättadminåtkomst. Ingenproduktaktivering förränanvändarenberomdet.

## 2026-10-15 Auktoriserad produktionsrelease

Slutför PR55 CI, merge och Vercelrelease; verifierahealth/ready/arbetare och rättSHA. Behörig inloggad operator kan på Integrationer välja Registrera leveranskvitton automatiskt; serverns befintliga Resendkey används utan hemlighetsdelning. Aktiveraingenprodukt. Native skickflöde provas först med kontrollerad slutmottagare och färdigmall näranvändaren efterfrågar det. Följ providerbegränsade PostGISACL/Auth/Sinchvarningar separat.

## 2026-10-15 Systemgranskning och uppföljande rättningar

Granska senaste PR55-rättningar. Välj/etablera testmiljö före release; applicera framåtmigrationer, regenerera typer, deploya webb och uppdaterade Edge tillsammans. Konfigurera och verifiera Resendwebhook i rätt konto för varje aktiv tenant, koppla slutlig produkt+pris+PDF-mall och kör kontrollerad fullresa. Utred Sinch-uppdatering för ren dependency-audit; aktivera lösenordsskydd enligt driftbeslut. Skicka inga kunderutskick innan dessa verifieringar.

## 2026-10-15 Aktuell korrigering: port i Kundexa

Efter lokal verifiering: uppdatera befintlig utkast-PR55. Applicera endast senare på identifierad staging, regenerera schema, deploya webb/Edge och verifiera hela inbyggda flödet med riktiga testidentiteter. Ingen ny server eller DocuSeal-nyckel behövs.

## 2026-10-13 Full återanvändning av DocuSeal och byggordning

Följ docs/KUNDEXA_BUILD_WITH_DOCUSEAL.md: skydda avtals-/kundgrund och sparande; inventera och avgränsa auktoriserad dokumentkod; inför PDF-fältkoppling/versioner; bygg enkel säljarresa och riktig extern signeringskedja; rätta telefoni och verifiera drift. BankID är senare separat adapter.

## 2026-10-13 Kompletterad avtalsresa

Efter behörighets-/avtalsgrund: versionsbundna PDF-mallar och typade fältkopplingar, säljarens sparande/ifyllda preview, därefter DocuSeal-adapter och faktisk slutdokumentimport. Följ docs/PDF_FIELD_TEMPLATES_AND_DOCUSEAL.md tillsammans med avtalsplanen. Inga dokumentationsfynd ska markeras lösta.

## 2026-10-13 Nästa arbetsordning

Följ `docs/CONTRACT_PRODUCTION_PLAN_2026-10-13.md`:

1. PR 1: skrivbehörigheter och avtalsintegritet.
2. PR 2: komplett produktmall/pris och gemensam UI/API-planering.
3. PR 3: avbrottssäker utskickskö och leveransavstämning.
4. PR 4: versionsbundna bevis, bilagor och aktivering.
5. PR 5: gemensamt kund-/efterarbetssparande, enkel säljarresa och samtalsgrund.
6. PR 6: DocuSeal-adapter om drift/funktioner väljs.
7. PR 7: BankID-förberedelse; verklig integration separat när tjänst/konfiguration finns.

Första leveransmål är kontrollerad e-post/webbacceptans. Full extern signering är ett eget mål,
inte uppnått genom en lyckad acceptans. Inga fynd är rättade i dokumentationspasset.

**2026-09-24, samtalsarbetsytan:** Provsamtal från en ringlista: svara, fyll i e-post/adress under samtalet,
välj "Intresserad" med tangent 1, "Spara och skapa avtal" ska öppna ny flik och pausa sessionen. Kontrollera
att kortet i den smala telefonpanelen på kundkortssidan är läsbart.


**2026-09-24, efter kodgranskningen:**
1. Merga grenen och applicera `202609240011` i produktion (jämför funktionernas md5 mot PGlite efteråt).
2. Provsamtal: svara och lägg på; kontrollera att `metadata.provider_answered` sätts av ACE.
3. Avtalssvar via SMS kan provas först när ett svenskt SMS-nummer finns.
**2026-09-24, systemgenomgången:**
1. ~~Merga grenen~~. Klart: PR #48, `f6fca59`. Vercel READY, Edge Functions deployade och
   `*/5` observerat. Kontrollerat vid mergen:
   - att Vercel är READY på merge-SHA:n;
   - att `list_edge_functions.updated_at` är nyare än mergen för `maintenance-worker`,
     `process-outbox` och `parsehub-worker`;
   - att `maintenance-worker` kör var femte minut och rapporterar `results[].status`.
2. Provsamtal efter merge: ett spärrat eller oreserverat nummer ska läggas på, ett reserverat ska
   kopplas, och mottagaren ska se team- eller listnumret.
3. Skapa en produkt, koppla mallen och skicka ett avtal till egen e-post. Koden ska stå i mejlet när
   kanalen är e-post och metoden OTP.
4. Aktivera en säljare, dela en lista med säljarens team eller kampanj, och prova dagsgräns 1, paus och
   "Lägg om".
5. Ladda upp en riktig fil. Prova sedan "Skapa endast nya" och "Granska konflikter" på en fil med
   befintliga kunder.

**2026-09-24, efter PR F-merge:** ~~applicera RLS-delen av `202609240002` i prod~~. Klart
2026-09-23 (se current-state). Uppladdning med riktig fil är NOT RUN.

**2026-09-24:** PR F — importfixar (dubbletter org.nr+telefon, återimport behåller ringläge,
rollback rör inte befintliga platser, fel sparas, nytt försök efter rollback, direkt skrivrätt bort,
synliga uppladdningsfel, ParseHub, plattformsimport, stegindikator). Användaren: dela en lista med
ett team och ring som säljare i teamet (NOT RUN).

**2026-09-22, först:** Skapa produkten (t.ex. "Elavtal rörligt") under Produkter, öppna mallen
"Gridex hemsida · Mina sidor", välj produkten under Redigera och spara. Den godkända
versionen gäller direkt. Skapa sedan ett avtal från en kund och skicka det till egen e-post.

Uppdaterad 2026-09-18. Bytet till Sinch är genomfört och **mergat till main** (PR #19,
`69f5d6f`). Webben och Edge-funktionerna är deployade; `/api/ready` svarar
`telephonyConfigured: true`, och de tre webhookarna svarar 403 på en osignerad begäran.
Det som återstår kräver leverantörskonto, ett nummer eller ett riktigt samtal.

**Ingen avtalsleverans har någonsin körts i produktion.** Det finns noll rader i
`sms_messages` och `email_messages` med en acceptlänk, så hela kedjan är oprövad skarpt.

## Användarens egna steg

1. **Registrera callback-adressen** i Sinch kontrollpanel. Använd den adress
   `GET /api/ready` skriver ut (`checks.webhookUrl`) — i dag
   `https://www.kundexa.se/api/webhooks/sinch`, alltså **med `www`**. Apex redirectar
   till www, och en POST som möter en omdirigering kan tappas tyst.
2. **Köp eller porta numren med svensk originering.** I dag finns **ett enda nummer i
   hela systemet**, `+1 208 581 0392` (US, röst men inte SMS). Gridex skulle alltså ringa
   svenska mottagare med ett amerikanskt nummer, Trustcall har inget alls, och
   `queue_sms_message` kastar `sms_sender_missing` för båda — inget avtals-SMS kan skickas
   av någon förrän ett svenskt nummer med både röst och SMS finns. Ett svenskt nummer som origineras
   utomlands blockeras av operatörerna enligt PTS föreskrift — det avgör både om samtalet
   kopplas och minutpriset (originerings­prefixet är ungefär elva gånger i skillnad).
3. **Sätt SMS-nycklarna** i Vercel och Supabase Edge Secrets: `SMS_SERVICE_PLAN_ID`,
   `SMS_API_TOKEN`, `SMS_REGION`. Utan dem dödbrevas varje avtals-SMS med
   `permanent_sms_provider_not_configured`.
   Sätt även `SINCH_PROJECT_ID`, `SINCH_KEY_ID` och `SINCH_KEY_SECRET` om ni vill
   hyra nummer inifrån Kundexa i stället för i leverantörens panel.
4. **Testsamtalet.** Ring, svara, lägg på. Det är enda sättet att se att webbtelefonen
   registrerar sig, att A-numret syns hos mottagaren och att händelserna når webhooken.
5. **Test-SMS med ett avtal.** Skicka, svara "JA", kontrollera att acceptansen registreras.
5b. **Slå på `outbound_sms` för Gridex.** Flaggan är `false` i produktion medan
   `contract_delivery_sms` är `true`. Utskicket stoppas nu före köandet med en
   förklaring till säljaren i stället för att dödbrevas i arbetaren, men avtalet går
   fortfarande inte iväg förrän flaggan är på. Trustcall har dessutom
   `contract_delivery_sms: false`.
6. Resend: verifiera `kundexa.se`, sätt `RESEND_API_KEY`, `DEFAULT_EMAIL_FROM_ADDRESS`,
   `DEFAULT_EMAIL_FROM_NAME` i Vercel, lägg till Gridex domän.
7. Godkänn en avtalsmall; rätta de två ogiltiga organisationsnumren.
8. Sätt `NEXT_PUBLIC_APP_URL` (Vercel) och `APP_URL` (Supabase Edge Secrets) till
   **samma** adress, och gör den till primär domän i Vercel. Webbappen bygger första
   utskickets länk ur den första, utskicksarbetaren bygger påminnelsens länk och
   SMS-leveransens callback ur den andra. Går de isär pekar påminnelsen på en annan värd
   än avtalet. `/api/ready` rapporterar nu `checks.delivery.linkHostAligned`, som är
   `false` precis när de två skiljer sig åt. Appen ligger i dag på `www` medan produkten
   var tänkt på apex — välj en av dem och sätt båda variablerna till den.

## Kvar att bygga

9. Webbtelefonens gränssnitt: mikrofontillstånd, headsetväljare, mute, hold, DTMF,
   nivåmätare före första samtalet och en AudioContext som låses upp av en användargest.
10. Beslut: ska inkommande samtal ringa i Kundexa? Kräver ringläge, svara/avvisa och en
    regel för vem som får samtalet.
11. Säga upp ett nummer inifrån Kundexa. Medvetet utelämnat: det har uppsägningstid
    och fakturaföljd, så det görs i leverantörens panel tills någon bestämt hur
    bekräftelsen ska se ut.
12. Migrationerna saknar table grants — schemat kan inte byggas om från dem ensamt.
    Kräver beslut om säkerhetshållning.

## Skulder som är värda att veta om

14. `release_stale_dial_attempts` och `release_lost_webphone_sessions` var skrivna men
    aldrig schemalagda, alltså skyddsnät som aldrig fångat någon. De körs nu ur
    maintenance-workern. Ingen av dem har ännu släppt ett försök i produktion.
15. Inspelningar hämtas inte från leverantören. `/api/v1/calls/[id]/recording` kastar
    `recording_not_fetched_from_provider` i stället för att dela ut en trasig länk, och
    gallringens leverantörshalva vägrar med `permanent_provider_recording_delete_unsupported`
    hellre än att märka en inspelning som gallrad medan kopian lever kvar.
- Prova ett webbläsarsamtal mot deploy med minimal SVAML (PR #40) och migration 202609230002; läs
  `sinch.call_ended`-orsaken på samtalet om DiCE kommer. Kommer ingen DiCE: kontrollera i Sinch-
  appen att "Calling → callback" även skickar DiCE, och öppna ärende hos Sinch med call-id.


## 2026-10-15 — Implementation av plan 53

Granska implementations-PR och installationsunderlaget services/docuseal/README.md. Välj server/domän, slutför källbuild och Rails-smoke, applicera migration001–005 på identifierad staging och regenerera typer. Ange produkt/slutvillkor/egen mottagare; verifiera callback, signering, audit/slutPDF, bekräftelse och aktivering. Kör verklig tvåtenant-RLS/Storage och samtal/headset. Ingen blind retry av okänt externt create.
