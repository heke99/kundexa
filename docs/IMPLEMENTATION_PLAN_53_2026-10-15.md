# Genomförande av plan 53

Datum: 15 oktober 2026. Implementation: [utkast PR #55](https://github.com/heke99/kundexa/pull/55). Referens: [PR #53](https://github.com/heke99/kundexa/pull/53), dokumentationscommit `18858a51f1a4183dd89ecce88fa6d799086bb5bf`. Implementationen utgår från main `de852fcd5bccc6fdffc82d49c7a2611545d09e33` och använder framåtmigrationerna `202610150001`–`202610150009`.

Detta dokument beskriver kod och lokal verifiering. Inga produktionsmigrationer, externa kundutskick, riktiga samtal eller skarpa signeringar har utförts. Användarens förtydligande gäller: **porta de delar som behövs direkt till Kundexa**. Ingen separat DocuSeal-installation ingår.

## Uppföljande systemgranskning 15 oktober

Rätt Supabase-/Vercelprojekt är läst. Produktion kör fortfarande main `de852fc`: `/api/health` och den äldre `/api/ready` svarar 200, Sinchregistrering lyckas, sju workers är friska och den tillgängliga runtimefelvyn för 24 timmar är tom. Databasen bekräftar den sparade avsändaren `avtal@kundexa.se`. Det andra anslutna Resendkontot används inte som bevis för Kundexas leverans.

Drift är ändå inte godkänd: 15-oktobermigrationerna och porten är inte driftsatta; Resendintegrationerna har ingen registrerad verifierad webhook; den aktiva godkända mallen saknar produktkoppling. Läckta-lösenordsskydd är avstängt. En läst hälsokontroll ersätter inte full avtalsresa med riktiga testidentiteter.

Granskningen rättade dessutom mänskligt signaturnamn separat från låst företagsmottagare, atomisk återkörbar avbrytning (007), kontrollerat stopp vid Resend-nyckelbyte efter osäkert utskick (008), anonym PostGIS-körning (009), readiness per aktiv tenant och matchande webb-/Edge-konfiguration, workerbudget, anteckningslåsning under sparning, individuell PDF-förekomstredigering och ritning efter skärmrotation. Tidigare migrationer är oförändrade.

Next/SWC är uppdaterat till 16.4.1 med kompatibla säkerhetspatchar. Nexts TypeScript-CLI-probe fungerar inte i denna sandbox; `experimental.useTypeScriptCli=false` använder TypeScript 5.9:s befintliga compiler API. Den ordinarie obligatoriska typkontrollen körs fortfarande före bygget.

Produktionsberoendekontrollen visar efter uppdateringen 0 critical, 0 moderate och 6 high. De sex höga posterna härleds till samma FTP-parserbrist i Sinch/PubNubs Nodeproxy-kedja. SDK:n laddas från klienthooken med browserbundle. Ren dependency-audit kräver en kompatibel leverantörsuppdatering; ingen obekräftad majoroverride har gjorts. Detta är en kvarvarande varning, inte ett påstående om konstaterad exploatering.

## Levererad kod

| Område | Resultat |
|---|---|
| PR 1, behörighet | Kundskrivning skiljs från läsåtkomst. Avtalsstatus, generation, mottagarbevis, pris och rendering skyddas också vid direktanrop. Sales-rendering sker genom service-only wrapper med verifierad aktör. API kontrollerar tenantstatus. PostGIS publika skrivrätt tas bort. |
| PR 2, gemensam planering | UI/API använder samma kanal-, kod- och svarspolicy. OTP-metoden följer låst policy. Idempotens binds till resurs och normaliserat requestinnehåll, med konfliktgrind i databasen. |
| PR 3, utskick | Leases och ägarskyddad completion, återtagning, fryst transportpayload, kontrollerade DB-fel, korrekt Resend 409, SMS-projektion och replay av tidiga e-posthändelser. |
| PR 4, dokument och bevis | Parter och manifest fryses. Acceptansbilagor binds till egen version/generation/acceptans. Extern bekräftelse kräver det egna slutdokumentet och audit-PDF:n. Enkel acceptans kan inte slutföra extern signering. |
| PDF-mallar | Administratören laddar upp privat PDF, placerar fält på verkliga PDF-sidor och kopplar godkända datakällor. Även typade avtalskompletteringar (text, datum, tal) stöds. Godkända versioner låser filhash, positioner, regler och policy. |
| Säljarresa | Kundutkast sparas före nästa steg. Fyra dagliga menyval, egna historikvyer och avtal i samma samtalsarbetsyta. Vald produkt visar enbart sina godkända kompletteringar. Ifylld PDF kan granskas före utskick; faktiska mottagare och tillgängliga kanaler visas. |
| Telefoni | Fjärrström spelas upp, mikrofon/högtalare används i samtalet, rätt SDK-DTMF, återstart och reservation/start-claim med bevarad samtalskontroll. Okänt leverantörsutfall ger ingen blind omringning. |
| PR 6, inbyggd signering | Utvalda DocuSeal-funktioner för validering, beskärning och bildplacering är portade med proveniens. Kundexa visar PDF, fångar ritad underskrift och uttryckligt samtycke, låser kvitto före rendering och skapar privat slut-PDF samt audit-PDF. Atomiska service-RPC:er binder tenant, version, generation, token, hash och första accepterade försök. |
| Avstämning | Authentiserad Node-cron var femte minut återläser status och återhämtar okända försök utan ny blind submission. Felade gamla försök blockerar inte senare jobb. Heartbeat och readiness följer utfallet. |
| Drift | Readiness kräver huvudfunktionernas konfiguration och färska friska workers. Resend-webhooken markeras aktiv efter verifierad signatur; hemlighets-/URL-byte återställer vänteläge. Inaktiva äldre scraperadaptrar pausar sitt jobb efter synligt fel. |
| PR 7, BankID | Metod och provider hålls separata. BankID är inte en tillgänglig adapter och erbjuds inte som verifierad signering. Verklig BankID-anslutning ingår inte i denna installation. |

Kundexas befintliga autentisering, databas, privata lagring och transactional outbox används. PDF.js visar originalet, pdf-lib producerar dokumenten och signature_pad fångar ritningen. Portad kod och licenstexter finns i `third_party/docuseal`. Första flödet är enkel elektronisk underskrift utan BankID eller certifikatbaserad PDF-signering.

## Verifiering

Efter systemgranskningens sista rättningar: full `npm run verify` **PASS**, exit0, Node22.17.0/npm10.9.2, 140 migrationer och Next16.4.1 produktionsbygge. Samtliga119servertraces saknar FTP/proxy/PubNubNode-kedjan. SQL009 verifierar verkliga roll-/ACL-beteenden med harmlösa fixtures; faktisk PostGIS C-körning är NOT RUN.

- `npm run verify`: **PASS** (exit0), Node **22.17.0**, npm **10.9.2**. Genererat schema, Edge, samtliga tester/SQL-runtime, OpenAPI, TypeScript och Next produktionsbygge passerar.
- SQL kör samtliga migrationer i PGlite och testar verkliga roller, två tenants, otillåtna direktanrop, positiv sales-wrapper, leases, replay och extern reserve → claim → invitation → completion → replay. Ändrade dokument/hashar/generationer och saknad audit nekas.
- PDF-tester kör verkliga PDF-bytes, flera sidor, svenska tecken, samma snapshot vid retry, typade kompletteringar, överflöde, sidrotation och förbjudna/tenantfrämmande sökvägar.
- Webbläsarkontroll med Chromium: canvas på två sidor, pixelposition, dragning, fältregler, filbyte/återuppladdning samt produktberoende kompletteringar. Temporära testvyer är borttagna. Detta är komponentverifiering med kontrollerad PDF-transport, inte en verklig säljarinloggning.
- Motor- och orkestreringstester kör faktisk TypeScript-logik med kontrollerad DB-/Storage-transport. De verifierar inte extern drift.
- Native tester verifierar PNG-validering, verkliga PDF-bildobjekt på flera sidor, deterministiska dokument vid retry och låst signeringskvitto. Ingen separat Rails-/Dockerbyggning behövs.
- Browser-QA för inbyggd signering: åtta kontroller PASS, inklusive ritning/rensning, samtycke och identiskt retry efter nätverksavbrott; inga JavaScriptfel.

Genererade Supabase-typer har inte handredigerats. Inga nya tabellkolumner krävs. Nya RPC-anrop ligger vid en begränsad server-/Edge-gräns; full typregenerering från staging återstår efter att migrationerna applicerats där.

## Kvar före drift

1. Applicera migrationerna på identifierad staging, regenerera typer och deploya webb plus ändrade Edge Functions. Kör riktiga JWT/RLS/Storage-tester med två tenants.
2. Ange verklig första produkt, prisvillkor, juridisk avtalstext och egen testmottagare. Ofärdiga produktionsvillkor har inte ersatts med gissade uppgifter.
3. Konfigurera och prova Resend-callbacken samt hela e-postsigneringen. SMS är fortsatt beroende av ett lämpligt nummer och aktiva funktioner.
4. Prova ett riktigt samtal/headset och hela säljarresan. Prova även avbrott, avbruten dokumentrendering, dubbel submit, utgången/gammal länk och avbrytande.

Första inbyggda flödet är avsiktligt **en obligatorisk kundsignatär via e-post**, med flera signaturfält om mallen behöver det. Orkestreringen nekar andra mottagaruppsättningar i denna version; adapterns mer generella flerpartsinterface betyder inte att en flerpartsprodukt är driftgodkänd. Fria SMS/e-postformulär finns kvar som separata behöriga sidofunktioner; avtalsutskick följer avtalsflödet.

De historiska granskningsregistrens fynd är inte automatiskt stängda i produktion. Produktionskonfiguration, leverantörsprov och leveransgodkännande ska registreras mot den faktiskt driftsatta versionen.
