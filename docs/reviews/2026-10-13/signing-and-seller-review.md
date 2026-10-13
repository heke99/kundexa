# Kundexa signering och säljarens arbetsyta

**Datum:** 13 oktober 2026.  
**Slutsats:** Kundexa har ingen inkopplad DocuSeal- eller DocuSign-integration i den granskade versionen. Avtal hanteras genom Kundexas egen dokumenterade webbacceptans. Säljarens meny är redan förenklad, men arbetsflödet och vissa befogenheter behöver ändras för att motsvara en enkel säljarvy.

## Underlag

GitHub-pluginet användes för att kontrollera aktuellt Kundexa-main och läsa DocuSeals repository. Kundexa-main är fortfarande `de852fcd5bccc6fdffc82d49c7a2611545d09e33`. Koden för nav, rollbehörigheter, dashboard, dialer, kundkort, listor och avtal granskades. Den körande databasen lästes på nytt för signeringspolicy, integrationer och utvalda åtkomst-/dashboardfunktioner.

Detta är en granskning av rollstyrd rendering och kontrollflöden i koden, inte en visuell genomgång inloggad som en verklig säljare. Inga kodändringar, verkliga samtal eller utskick gjordes i detta tillägg. Fynden beskriver implementationen och vad som kan hända; de påstår inte att varje fel inträffat i drift.

## Vilken signering finns faktiskt

| Del | Aktuell implementation | Bedömning |
|---|---|---|
| DocuSign eller ”Docsign” | Ingen adapter, API-konfiguration eller anropskedja hittades i Kundexa | Ingen etablerad integration |
| DocuSeal | Nämns i produktkrav som alternativ och teknisk proof of concept | Planerat alternativ, inte inkopplat |
| SigningProvider | Interface och tomt leverantörsregister finns | Förberedelse |
| Leverantörsregistrering | registerSigningProvider/getSigningProvider hittas som definitioner, inga applikationsanrop | Ingen registrerad motor i koden |
| Aktuell mall | simple_click, identityAssuranceLevel=low, requireFinalProviderDocument=false | Kundexas egen enkla acceptans |
| Databasintegrationer | Två Resend-e-postintegrationer, inga platform_integrations | Ingen registrerad extern signeringsintegration |
| Signeringshistorik | 0 signing_envelopes, 0 signing_events, 0 signing_recipients | Ingen lagrad extern signeringsresa |
| Accepterad PDF | Bevisworkern kopierar den ursprungliga PDF:ens bytes och sparar separat bevis | Inte en PDF som signerats av DocuSeal |
| BankID/external_esign | Vanliga prepare_contract_delivery_v2 avvisar dessa metoder | Kan inte slås på enbart genom att ändra mallpolicy |

En extern tjänst kan finnas separat från Kundexa utan att framgå av denna kod. Granskningen visar att en sådan tjänst inte är inkopplad i Kundexas granskade avtalskedja.

### SIGN 01 Leverantörsgrunden saknar en konkret integration

`src/lib/signing/provider.ts` beskriver hur skapa, avbryta, läsa status och hämta slutdokument ska fungera. Någon implementation av detta mot DocuSeal hittades inte.

**Konsekvens:** Befintliga tabeller och finaliseringsfunktioner innebär inte att extern e-signering fungerar.

**Behöver byggas:** Adapter, serverkonfiguration, submission-/mottagarmapping, signeringslänk, verifierad webhookhantering, avstämning och import av slutdokument.

### SIGN 02 Dagens accepterade PDF är en oförändrad avtalskopia

`processEvidence` verifierar käll-PDF:ens hash och laddar sedan upp samma bytes som accepted-PDF. Den får document_type=signed_pdf, men workersteget lägger inte till en DocuSeal-signatur eller producerar ett externt signeringsdokument. Bevis och kundens acceptans lagras separat.

**Bedömning:** Detta ska beskrivas som dokumenterad acceptans med accepterad avtalskopia. Det är inte en färdig DocuSeal-integration. Detta är en teknisk beskrivning, ingen slutsats om avtalets juridiska giltighet.

**Källa:** `supabase/functions/process-outbox/index.ts:575–618,638–641`; `src/app/accept/[token]/page.tsx`.

### SIGN 03 Den egna acceptanskedjan är inte fullt godkänd

Den föregående granskningens verifierade hinder gäller fortfarande: produktmallen saknar produktkoppling, avtalsvillkoren är ofärdiga, OTP-metoderna matchar inte databasen och utskicks-/återhämtningsfel återstår.

**Bedömning:** Varken extern signering eller hela den egna avtalsresan kan förklaras fullt fungerande med nuvarande kod och konfiguration.

## Vad DocuSeal kan bidra med

DocuSeals aktuella README beskriver PDF-formulär, signaturfält, flera signatärer, PDF-signering, API och webhooks. API-dokumentationen beskriver submission.completed efter samtliga signatärer och hämtning av slutligt signerade dokument.

Det gör DocuSeal till en möjlig extern motor bakom Kundexas säljarflöde. Det är en arkitekturbedömning utifrån dokumenterade funktioner; ingen Kundexa-integration har verifierats.

README listar bland annat embedded signering/editor, white-label, roller, automatiska påminnelser och SMS-verifiering under **Pro Features**. Hela det önskade upplägget ska därför inte antas ingå i den öppna grundversionen. Bestäm först om kundens vanliga signeringslänk räcker eller om inbäddning och white-label verkligen krävs.

Källor: [DocuSeal repository](https://github.com/docusealco/docuseal), [API och webhooks](https://www.docuseal.com/docs/api).

### Föreslagen inkoppling om DocuSeal väljs

1. Kundexa väljer godkänd produkt, mall och dokumentversion med låsta kommersiella uppgifter.
2. En serverstyrd adapter skapar DocuSeal-submission och mappar tenant, avtalsversion, generation och varje mottagare till externa ID:n.
3. Kundexa sparar signeringslänken och skickar den genom sin befintliga utskickskedja. DocuSeals egna inbjudningar stängs av om Kundexa äger utskicken, så samma inbjudan inte skickas två gånger.
4. Kunden signerar genom DocuSeals signeringsresa.
5. Kundexa verifierar webhookens avsändare enligt vald installations dokumenterade säkerhetsmodell och hämtar aktuell status server-side. En mottagarhändelse räcker inte för att slutföra ett avtal med flera obligatoriska signatärer.
6. Efter korrekt completion hämtas slutlig PDF och auditmaterial till privat lagring. Hash, version, generation och mottagare kontrolleras.
7. Den befintliga finaliseringsfunktionen färdigställer avtalet och köar rätt bekräftelse. Aktivering/onboarding följer avsedda regler.

**Befintliga punkter att ändra:** prepare_contract_delivery_v2 behöver en separat extern signeringsväg; den enkla acceptanssidan får inte slutföra ett avtal som kräver providerfinalisering; gamla webhookar måste nekas om generationen ersatts. Remote retries måste återfinna samma submission utan nya parallella signeringsbegäranden.

Säljaren ska arbeta i Kundexa. Mallbyggaren och DocuSeals administration hör till behörig administratör.

## Säljarens nuvarande meny

En vanlig sales-roll utan plattformsroll får dessa sju val:

| Menyval | Föreslagen placering |
|---|---|
| Dashboard | Slås ihop med säljarens arbetsyta |
| Dialer | Huvudvalet Ringa |
| Återkomster | Eget huvudval |
| Mina samtal | Historikflik i arbetsytan |
| Kunder | Eget huvudval |
| Ringlistor | Listval inne i Ringa |
| Avtal | Eget huvudval, tydligt Mina avtal |

Import, användare, integrationer, API, automationer och produkthantering ligger redan utanför den vanliga säljarens huvudmeny. Det ska behållas.

## Fynd i säljarresan

### UI 01 Osparade kunduppgifter följer inte med när säljaren går vidare — P1

LiveCustomerCard håller ett lokalt utkast och sparar först när den egna knappen ”Spara uppgifter” används. ”Spara och skapa avtal” sparar samtalsutfallet, inte detta utkast. Den manuella dialern navigerar bort; listdialern byter till loading och fortsätter till separat avtalsflik. Kundkortskomponenten kan avmonteras med osparade uppgifter.

**Exempel:** Säljaren skriver kundens e-post och adress, väljer Intresserad och klickar ”Spara och skapa avtal”. Avtalet läser fortfarande databasens tidigare kunduppgifter.

**Rätta:** Gemensam sparsekvens som inväntar kunduppgifter och efterarbete före avtalet eller nästa lead. Visa fel och stanna kvar om något inte sparas. Enbart en liten text ”Ändringar som inte är sparade” räcker inte.

**Källor:** `live-customer-card.tsx:50–97,140–144`; `dialer-panel.tsx:193–220,354–356`; `list-dialer-workspace.tsx:328–365`.

### UI 02 Säljaren kan ändra villkor som borde styras av produkten — P1 om rollen ska vara strikt

Under ”Fler val” finns bindningstid, uppsägningstid, betalningsvillkor, avtalsvärde och särskilda villkor även för sales. Server action accepterar överstyrningarna och skickar dem till avtals-RPC:n. Att valuta, språk och ägare ligger som dolda fält hindrar inte dessa ändringar.

**Rätta:** Inför en uttrycklig rättighet för kommersiella ändringar. För vanlig säljare hämtas värden server-side från godkänd produkt-/prisversion. Tillåt endast fastställda val eller rabattintervall om verksamheten behöver det. Säljaren kan få ändra startdatum enligt produktregler.

**Källor:** `contracts/new/page.tsx:194–206`; `actions/contracts.ts:162–189,286–310`.

### UI 03 Säljarens avtal kräver onödigt många förflyttningar — P2

Efterarbetet leder till sidan för nytt avtal; produktval leder vidare till den stora avtalsdetaljsidan; där finns utskicksformuläret. Listdialern öppnar en ny flik, pausar sessionen och ber säljaren komma tillbaka efter utskicket.

**Rätta:** Använd en sammanhängande panel: kunduppgifter → produkt → förhandsgranskning → mottagare/kanal → skicka. Behåll listans position och återgå till nästa uppgift efter lyckat köande.

**Källor:** `list-dialer-workspace.tsx:337–355`; `actions/contracts.ts:328–329`; avtalsdetaljsidan.

### UI 04 Dashboarden hjälper inte säljaren att börja arbeta — P2

Startsidan visar statistik, senaste avtal och ”Arbetsläge”, men saknar en tydlig primär ”Börja ringa”-åtgärd och en faktisk arbetskö för nästa steg. Senaste avtal-tabellen har inga länkar på avtalsraderna, trots att kundsvar längre upp länkar till detaljer.

**Rätta:** Placera dagens återkomster, tilldelad lista, avtal som behöver uppföljning och en tydlig startknapp överst. Lägg egna nyckeltal längre ned. Gör historikraderna klickbara.

**Källa:** `src/app/(dashboard)/app/page.tsx`.

### UI 05 ”Mina” betyder åtkomstscope snarare än egna poster — P2

dashboard_overview aggregerar allt som RLS låter personen läsa. Mina samtal-sidan saknar user_id-filter. Samtals-/avtalsåtkomst kan även komma genom åtkomst till kunden/teamet. En säljare med delad teamåtkomst kan därför få fler än sina egna poster i en vy som kallas ”Mina”.

Detta är inte en konstaterad läcka mellan företag. Det är en skillnad mellan personligt arbetsläge och tillåten delad åtkomst.

**Rätta:** Separera Mina och Teamets gemensamma kö. Personliga resultat filtreras på säljaren; gemensamma arbetsuppgifter visas uttryckligt.

**Källor:** Live dashboard_overview, can_access_call, can_access_contract_row och can_access_customer_row; `calls/page.tsx`.

### UI 06 Tekniska texter finns kvar i säljarens vy — P2

Exempel: ”access-scope” på dashboarden, ”kanonisk PDF” i avtalsbeskrivningar, ”Realtime” och ”säker fallback” i dialern. Vissa dokument-/bevisstatusar faller tillbaka till interna enumvärden. Avtalsregistret länkar fortfarande till PDF-arkiv och Pipeline även för säljaren.

**Rätta:** Använd uppgiftsnära texter: ”Dina kunder”, ”Avtalets PDF”, ”Anslutningen återställs” och ”Väntar på kundens svar”. Lägg tekniska detaljer och administrativa genvägar i en separat behörig vy.

**Källor:** Dashboard; `contracts/page.tsx:110`; `contracts/[id]/page.tsx:132,148,151`; `dialer-panel.tsx:320–321`.

### UI 07 Signeringskanaler hanteras olika för utskick och påminnelse — P2

Första utskicket läser kanalblockerare och väljer en möjlig kanal. Påminnelseformuläret erbjuder alltid E-post, SMS och Båda. Det sker även när SMS är avstängt. Vid fel i läsningen av initial kanalberedskap återställs dessutom båda blockerarna till NULL.

**Rätta:** Använd samma kanalkontroll för första utskick, omutskick och påminnelse. Vid okänd beredskap visas ”Kan inte kontrollera utskick just nu” i stället för att erbjuda en osäkert fungerande kanal.

**Källa:** `contracts/[id]/page.tsx:90–116,142,148`.

### UI 08 Vald SMS-mottagare visas inte tydligt i utskicksformen — P2

Utskicksformen visar mottagarens namn och e-post, men inget telefonnummer. Server action använder kundkortets huvudnummer. Säljaren kan därför inte tydligt kontrollera vilket nummer som får avtalet från själva utskicksformen.

**Rätta:** Visa den faktiska mottagaren per kanal före skicka. Om ändring tillåts ska den valideras och bindas till den aktuella mottagaren. Detta ska inte bli ett fritt val av godtycklig mottagare.

**Källor:** `contracts/[id]/page.tsx:142`; `actions/contracts.ts:562–570`.

### UI 09 Avtalschecklistan är hårdkodad och kan vara missvisande — P2

LiveCustomerCard kräver visuellt alltid person-/organisationsnummer, e-post och adress. Den känner inte till vald produktmall eller leveranskanal. Dess checkmarkeringar bygger på lokala, ännu osparade värden.

**Rätta:** Visa bara vad den valda mallen och kanalen faktiskt behöver. Skilj ”ifyllt” från ”validerat och sparat”. Begär personnummer endast när produktens dokumenterade behov kräver det.

**Källa:** `live-customer-card.tsx:34–39,108,136–138`.

### UI 10 Säljaren flyttas till fristående kommunikationssidor — P2

Kundkortets SMS/E-post-länkar leder till egna sidor med kundval och meddelandeformulär. Sidorna är behöriga men dolda i säljarens meny. Det bryter den sammanhållna kundarbetsytan.

**Rätta:** Visa historik och tillåtna meddelandemallar direkt på kundkortet. Fria meddelanden kan finnas som uttryckligt tillåten sidofunktion; avtalsutskick ska alltid följa avtalsflödet.

**Källor:** `customers/[id]/page.tsx:66–68`; sms/page.tsx; email/page.tsx.

### UI 11 Order och avtal ger konkurrerande val i efterarbetet — P2

Vid positivt utfall kan listdialern erbjuda ”Skapa order från samtalet” med produkt, antal och fritt enhetspris, samtidigt som ”Spara och skapa avtal” finns. Säljaren behöver förstå två parallella affärsobjekt för en försäljning.

**Rätta:** Bestäm produktens försäljningsmodell. Om produkten säljs via avtal ska säljaren i första hand välja produkt och skapa avtalet; eventuell order skapas under rätt affärsregel. Om båda behövs ska sambandet vara tydligt och prisöverstyrning behörighetsstyrd.

**Källa:** `list-dialer-workspace.tsx:390–396`.

### UI 12 Förenklad meny måste följas av motsvarande serverregler — P1

sellerNavHrefs styr endast vilka länkar som visas. routeAccessMap medger fler sidor och tidigare granskning visade breda skrivpolicyer för kunder och avtalsstatus. En strikt säljarvy kan därför inte uppnås genom att bara ta bort knappar.

**Rätta:** Sätt samma befogenheter i rendering, actions, API, RPC och RLS. Skydda kommersiella villkor, aktivering, tilldelning och signeringsstatus även vid direkta anrop. Dolda men behöriga kundhistoriksidor är inte i sig en säkerhetslucka; det är oavsiktlig skrivåtkomst som ska stängas.

**Källor:** `nav-config.ts:sellerNavHrefs`; `permissions.ts:routeAccessMap`; aktuella kundpolicyer och föregående produktionsrapport.

## Föreslagen säljarvy

Fyra huvudval räcker för det dagliga arbetet:

| Huvudval | Säljaren ser | Primär åtgärd |
|---|---|---|
| Ringa | Nästa uppgift, tilldelad lista, aktuellt kundkort och egna dagsresultat | Börja/Fortsätt ringa |
| Återkomster | Mina återkomster och tydligt märkt gemensam teamkö | Ring eller boka om |
| Kunder | Tillåtna kunder, kontaktuppgifter, anteckningar och samlad historik | Öppna kund, ring, notera |
| Avtal | Mina ej skickade, väntande, godkända och avböjda avtal | Skicka, följ upp, hämta PDF |

Mina samtal ligger som historikflik. Ringlistorna väljs i Ringa. Profil, headset och utloggning nås från en liten kontomeny eller ljudpanel.

### Under samtalet

Visa kundens namn och nummer, ringstatus, lägg på, mikrofon av/på, manus och relevanta anteckningar. Kundfält ska visas efter vald kundtyp och produktbehov. Fördjupad historik öppnas i samma arbetsyta utan att bryta samtalet.

### Efter samtalet

Visa utfall och anteckning. Återkomsttid visas bara när ett återkomstutfall valts. Positiv försäljning visar produktval och avtalsåtgärd. Systemet sparar kunduppgifter och efterarbete i rätt ordning innan nästa steg tillåts.

### Vid avtal

Visa godkänd produkt, avsedda priser och villkor, faktisk mottagare, möjlig kanal, PDF-förhandsgranskning och en tydlig Skicka-knapp. Administrativa inställningar, mallredigering, hash, providerdata och signeringskonfiguration hålls utanför säljarens dagliga arbetsyta.

## Prioriterad ändringsordning

1. Säkra kunduppgifter och efterarbete före avtalsövergång eller nästa lead.
2. Bestäm tillåtna kommersiella ändringar för sales och genomför server-/databasskydd.
3. Rätta produkt-/mallkonfiguration och befintlig acceptans-/utskickskedja.
4. Samla Ringa och förenkla avtalsresan utan extra flikar.
5. Rätta personliga resultat, mottagarvisning, kanalval och feltexter.
6. Om DocuSeal väljs: bygg och verifiera en separat extern signeringskedja innan den erbjuds.

## Kodreferenser

- [Signeringsabstraktion](https://github.com/heke99/kundexa/blob/de852fcd5bccc6fdffc82d49c7a2611545d09e33/src/lib/signing/provider.ts)
- [Säljarens meny](https://github.com/heke99/kundexa/blob/de852fcd5bccc6fdffc82d49c7a2611545d09e33/src/components/app-shell/nav-config.ts)
- [Live kundkort](https://github.com/heke99/kundexa/blob/de852fcd5bccc6fdffc82d49c7a2611545d09e33/src/components/call-workspace/live-customer-card.tsx)
- [Listdialer](https://github.com/heke99/kundexa/blob/de852fcd5bccc6fdffc82d49c7a2611545d09e33/src/components/list-dialer-workspace.tsx)
- [Avtalsåtgärder](https://github.com/heke99/kundexa/blob/de852fcd5bccc6fdffc82d49c7a2611545d09e33/src/app/actions/contracts.ts)

