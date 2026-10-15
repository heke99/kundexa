# Kundexa plan för avtalsutskick signering och BankID

> **Inriktning ändrad 15 oktober 2026:** användaren förtydligar att endast behövda DocuSeal-delar ska portas direkt till Kundexa. En separat installation av hela DocuSeal är inte önskad. Den aktuella arkitekturen finns i [portningsplanen](KUNDEXA_BUILD_WITH_DOCUSEAL.md). Äldre förslag om separat tjänst nedan är historik.


**Datum:** 13 oktober 2026.
**Status:** Sparad genomförandeplan. Inga produktionsrättningar eller leverantörsinstallationer genomförda i detta dokumentationspass.

Kundexa ska få en sammanhängande avtalskedja från säljarens samtal till utskick, kundens besked, bevis och aktivering. Signeringsmetoden ska kunna ändras per produkt utan att säljarens arbetsflöde byggs om.

## Sparade fynd och baslinje

- [Produktionsgranskning med 28 fynd](reviews/2026-10-13/production-audit.md).
- [Signering och säljarvy med 3 signeringsfynd och 12 UI-fynd](reviews/2026-10-13/signing-and-seller-review.md).
- Referenskod: main `de852fcd5bccc6fdffc82d49c7a2611545d09e33`.
- Databas: Kundexa `lhvifuxcqghtbiulzkrf`, läst 13 oktober 2026.
- Telefondelen använder Sinch, inte Rinkel.
- Ingen DocuSeal-/DocuSign-adapter är inkopplad. Nuvarande mall använder simple_click med låg identitetsnivå.
- En aktiv produkt och en aktiv prisversion finns. Den godkända mallen saknar fortfarande produktkoppling, innehåller instruktionstext och kräver bindnings-/uppsägningsvärden som prisversionen saknar.
- SMS är inte driftklart: outbound_sms är avstängt och det enda numret saknar SMS-stöd.
- E-postnycklar rapporteras av utskicksarbetaren, men Resend-webhookarna är inte registrerade som klara.
- Sju workers hade färska healthy-hjärtslag vid granskningen. Det bevisar inte hela avtalskedjan.

De två fyndregistren överlappar delvis. Deras antal ska inte summeras som ett antal unika produktionsfel. Fynd är OPEN tills de rättats och kontrollerats på den levererade versionen. Äldre dokument som säger noll produkter, ej mergad septemberkod eller Rinkel-device som aktuellt krav ska läsas som historik.

## Föreslagen signeringsarkitektur

**Ny arbetsförutsättning:** Användaren uppger godkännande från DocuSeal för återanvändning
av hela deras projekt. Genomförandet utgår från egen anpassad dokumenttjänst med återanvänd
kod. Tidigare villkor om standardpaket/köp är inte en blockerare för redan godkänd återanvändning.
Se [byggordningen med DocuSeal-kod](KUNDEXA_BUILD_WITH_DOCUSEAL.md).

**Tillagt användarkrav 13 oktober:** PDF-mallar ska ha visuellt placerbara fält kopplade till
kundkortet, förifyllning och enkel förhandsgranskning för säljaren. Se
[PDF-fält och DocuSeal](PDF_FIELD_TEMPLATES_AND_DOCUSEAL.md) för modellen och genomförandet.
Detta kompletterar PR 2, 4, 5 och 6; funktionen är ännu inte implementerad.

Kundexa äger kund, produkt, pris, godkänd avtalsversion, rättigheter, försäljningsresa och status. Leverantören äger sin signeringsoperation. Utskick och signering är separata delar.

| Metod | Nu eller senare | Kundens resa | Slutresultat |
|---|---|---|---|
| Enkel webbacceptans | Första stabiliserade kedjan | Kund öppnar PDF och lämnar uttryckligt besked | Låst acceptans, samma avtalskopia, separat bevis |
| DocuSeal PDF-signering | Nästa leverans, om DocuSeal väljs | Kund fyller/signerar genom providerresa | Hämtad slutligt signerad PDF och auditmaterial |
| BankID-signering | Framtida adapter | Kund granskar avtalet och genomför BankID-signering | Verifierat signeringsresultat bundet till rätt dokument och mottagare |

**Rekommendation:** Behåll grunden i Kundexa och koppla in DocuSeal genom SigningProvider. Förbered BankID som en annan adapter. DocuSeal-installation och eventuell Pro-version är inte beställda eller godkända genom denna plan.

Utveckla inte en egen generell PDF-signaturmotor. Återanvänd befintliga signing_envelopes, recipients, attempts, events, documents och finaliserings-RPC:er där deras regler håller. BankID får inte antas vara en inställning i DocuSeal; den vägen kräver en vald och verifierad BankID-signeringstjänst eller direkt integration.

### Gemensamt kontrakt för signeringsadaptrar

Varje adapter behöver kunna:

- skapa eller säkert återfinna en signeringsoperation för samma avtal/version/generation;
- ge en mottagarsession eller kundlänk;
- läsa aktuell providerstatus server-side;
- avbryta en operation;
- hämta eller producera verifierbart slutmaterial;
- verifiera händelser enligt leverantörens verkliga protokoll;
- redovisa stöd för flera mottagare, ordning, kod, BankID och slutdokument.

Låt providerKey och signeringsmetod vara olika värden. En signeringsbegäran binder tenant, contractId, versionId, generation, recipientId, käll-PDF:ens hash, policy och extern operation. Policy och dokument får inte ändras mitt under signeringen.

Idempotens gäller hela operationen: samma nyckel med ny resurs eller ändrat innehåll ger konflikt. Vid tappat providersvar ska systemet stämma av, inte skapa ett nytt signeringsärende blint.

## Genomförande i ordning

### PR 1 Behörigheter och avtalsintegritet

**Fynd:** KX26 22–25 och UI 02/12.

- Rätta kundernas INSERT/UPDATE-policyer så läsroller inte kan skriva.
- Lås avtalsstatus, generation och mottagarens signed/required bakom kontrollerade övergångar.
- Kontrollera tenantstatus vid API-nyckelarbete.
- Begränsa publika skrivrättigheter på spatial_ref_sys utan att skada PostGIS-beroenden.
- Inför uttrycklig behörighet för kommersiell överstyrning. Vanlig sales hämtar godkända priser och villkor server-side.
- Bevara tenantisolering, åtkomst till delade köer, dokumentimmutabilitet och audit.

**Klart när:** direkta API-/databasvägar har samma rättigheter som UI; vanlig säljare kan inte aktivera avtal eller ändra otillåtna villkor; läsroller och avstängda aktörer nekas.

### PR 2 En färdig produkt och gemensam avtalsplanering

**Fynd:** KX26 01–05,12–14; SIGN 03.

- Koppla godkänd mall till rätt produkt.
- Skapa slutliga villkor i en ny godkänd version; ange avsedda bindnings-/uppsägningsvärden eller korrekt valfri malltext.
- Välj produktens juridiska avsändare, målgrupp och giltiga prisversion.
- Samla UI/API-planering i samma tjänst: kanaler, tillåtna svarssätt, kodkrav, mottagare, sista svarsdag och meddelandeinnehåll.
- Rätta OTP-metoden utan att felmärka vanlig webbacceptans som verifierad BankID-signering.
- Bind idempotens till resurs och requesthash.
- Börja med e-post och webbacceptans enligt nuvarande konfiguration. Lägg SMS efter dess konkreta nummer-/kanalkonfiguration.
- Uppdatera Resend-webhookens token/signaturkonfiguration och registrera verifierat leveransläge.

**Klart när:** en vald produkt ger rätt PDF och kommersiella uppgifter, UI och API ger samma kundinstruktioner och varje erbjudet svarssätt går att använda.

### PR 3 Utskickskö som tål avbrott

**Fynd:** KX26 15–19,26,28.

- Inför tidsbegränsad outboxlease och ägarskyddad färdigmarkering.
- Återta avbrutna jobb med provideravstämning när extern leverans kan ha skett.
- Kontrollera samtliga verksamhetskritiska Supabase-returer.
- Spara hållbar försöksidentitet före externt utskick och provideridentitet efter acceptans.
- Projektera meddelande, avtalsleverans och påminnelse konsekvent.
- Skilj Resends tillfälliga 409 från oförenlig idempotent payload.
- Avstäm tidiga unmatched-webhookar.
- Gör readiness beroende av obligatoriska kontroller och färska workerresultat.

**Klart när:** ett avbrott eller nätverksfel inte ger dubbla leveranser, permanent processing eller falskt completed.

### PR 4 Bevis slutdokument och aktivering

**Fynd:** KX26 20–21,23; SIGN 02.

- Bind bevis och bekräftelsebilagor till exakt acceptans, version och generation.
- Använd låsta avtalsparter, inte aktuella tenant-/kundnamn.
- Låt bekräftelsen vänta på det egna färdiga bevis-/dokumentpaketet.
- Behåll separata statusar för köad, skickad, levererad, öppnad, accepterad, signerad och aktiv.
- Aktivering kräver rätt metod, obligatoriska mottagare, aktuellt bevis och slutmaterial.
- Enkel acceptans får ge accepterad kopia med separat bevis. Extern signering får inte slutföras genom den enkla acceptansrutten.

**Klart när:** kunden och säljaren får rätt dokument, hash och status och onboarding startas högst en gång.

### PR 5 Sammanhängande säljarresa och fungerande samtalsgrund

**Fynd:** UI 01–11 samt KX26 06–11.

- Samordna sparande av kunduppgifter och efterarbete före avtal eller nästa lead.
- Visa fyra dagliga huvudval: Ringa, Återkomster, Kunder och Avtal.
- Lägg ringlistor och samtalshistorik i Ringa; skilj egna resultat från gemensam kö.
- Samla produktval, förhandsgranskning och utskick i samma arbetsyta; bevara listans position.
- Visa faktisk mottagare och endast kontrollerat tillgängliga kanaler.
- Använd vanliga svenska fel-/statustexter. Håll mallbyggare, providerdata och adminverktyg utanför säljarvyn.
- Rätta fjärrljud, enhetsval, DTMF, uppstart och samtalskontroll vid nätverksfel.
- Behåll stöd för verkligt manuellt registrerat källsamtal enligt befintliga regler. Ett providerbekräftat samtal ska inte införas som nytt generellt avtalskrav i detta arbete.

**Klart när:** säljaren kan ringa, fylla i, spara, skapa och skicka utan osparade kunddata eller tappad samtalskontroll.

### PR 6 DocuSeal som extern signeringsmotor

**Fynd:** SIGN 01–02.

- Välj driftmodell och funktioner. Kontrollera vanlig länk kontra embedded/white-label eftersom README listar flera sådana funktioner som Pro.
- Implementera DocuSeal-adapter och konfiguration server-side.
- Skapa separat extern orchestration i avtalskedjan; dagens prepare_contract_delivery_v2 avvisar external_esign.
- Skapa submission och mappar mottagare, generation och dokumentversion.
- Bestäm en ägare för inbjudningar och påminnelser. Om Kundexa skickar ska motsvarande DocuSeal-inbjudningar stängas av för att undvika dubbla utskick.
- Verifiera callback enligt providerprotokoll, hämta status server-side och avstäm uteblivna händelser.
- Slutför först när samtliga obligatoriska parter i rätt generation är klara.
- Hämta slut-PDF/auditmaterial, spara privat och finalisera genom kontrollerad RPC.
- Verifiera avbrytning, omutskick, gamla länkar, dubbla händelser och okänt skapa-utfall.

**Klart när:** en Kundexa-produkt går till faktisk DocuSeal-signering och rätt slutdokument återkommer, utan att säljaren administrerar DocuSeal.

### PR 7 Förbered BankID utan att påstå att det är live

- Spara providerKey separat från method och erbjud bara registrerade kapabiliteter.
- Modellera BankID-order/operation och evidens utan att kräva att alla providers alltid returnerar en färdig PDF. Signeringsresultat och dokumentpaketering är olika ansvar.
- Förbered kundresan för start, pågående, avbruten, misslyckad, utgången och slutförd order.
- BankID-signering ska binda visat avtal, låst dokumenthash, mottagare, generation och avsedd signeringstext till verifierat resultat.
- Kunden ska inte bli registrerad som BankID-signerad enbart genom en inloggning eller redirect.
- Den senare implementationen väljer direktanslutning eller leverantör, läser aktuellt API och genomför dess test-/produktionskonfiguration.
- BankID ska kunna väljas i produktens policy utan att mallar, CRM, outbox och säljararbetsyta byggs om.

**Klart när förberedelsen är klar:** datamodell, adapterkontrakt och policy kan bära BankID men metoden är dold tills dess riktiga integration godkänts.

## Verifiering som visar faktisk funktion

| Kontroll | Belägg |
|---|---|
| E-post | Ett kontrollerat avtal har rätt PDF, provideridentitet och leveranshändelse |
| SMS | Konfigurerat SMS-nummer, korrekt mottagare, status och fungerande svarsväg |
| Acceptans | Beskedet hör till rätt mottagare, version, hash och generation |
| OTP | Rätt kod och metod godtas; fel kod/metod nekas |
| DocuSeal | Alla obligatoriska signatärer klara och slutdokument importerat |
| BankID senare | Verifierad signeringsoperation, inte enbart autentisering |
| Återhämtning | Avbrutet jobb/tappat svar återställs utan oavsiktliga nya utskick/ärenden |
| Säljarresa | Ändrade kundfält är sparade innan avtal och nästa lead |
| RBAC | Två tenants, relevanta roller och direkta anrop följer samma regler |
| Drift | Blockerat kärnflöde gör readiness röd och kvarvarande jobb syns |

Kontroller ska bedömas mot implementation och faktisk slutstatus. Använd kontrollerade nummer/adresser och håll automatiska tester som stöd. En mock som upprepar fel SDK-metod eller en regexkontroll av koden är inget bevis för en fungerande kedja.

## Konkreta uppgifter som behövs innan produktionskonfiguration

- Vilken produkt och målgrupp som ska användas för första kontrollerade avtalet.
- Slutlig avtalstext och godkända kommersiella villkor.
- Kontrollerad mottagare för leveranstest och ett nummer för samtal/SMS.
- Vald DocuSeal-drift och eventuella Pro-funktioner innan installation.
- Senare vald BankID-signeringstjänst/direktanslutning och dess runtimekonfiguration.

Inga av dessa värden ska gissas och inga leverantörshemligheter ska skrivas in i planen.

## Källor för externa funktioner

- [DocuSeal repository](https://github.com/docusealco/docuseal).
- [DocuSeal API och webhooks](https://www.docuseal.com/docs/api).
- [BankID utvecklardokumentation](https://developers.bankid.com/).
- [BankID signeringsorder för telefonflöde](https://developers.bankid.com/api-references/auth--sign/phone-sign).
- [BankID på samma enhet och serverstyrd statusuppföljning](https://developers.bankid.com/use-cases/mobile-bankid-on-the-same-device).

Detaljerad BankID-implementation ska utgå från den aktuella dokumentationen för den faktiskt valda integrationen. Telefon-, webb- och identifieringsflöden är inte utbytbara.
