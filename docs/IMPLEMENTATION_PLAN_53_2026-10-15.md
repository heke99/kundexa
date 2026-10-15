# Genomförande av plan 53

Datum: 15 oktober 2026. Implementation: [utkast PR #55](https://github.com/heke99/kundexa/pull/55). Referens: [PR #53](https://github.com/heke99/kundexa/pull/53), dokumentationscommit `18858a51f1a4183dd89ecce88fa6d799086bb5bf`. Implementationen utgår från main `de852fcd5bccc6fdffc82d49c7a2611545d09e33` och använder framåtmigrationerna `202610150001`–`202610150005`.

Detta dokument beskriver kod och lokal verifiering. Inga produktionsmigrationer, externa kundutskick, riktiga samtal eller skarpa signeringar har utförts. Användaren har ingen DocuSeal-server och har uttryckligen valt att **förbereda installationen**.

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
| PR 6, DocuSeal | Separat adapter, isolerad fryst mall för exakt ifylld PDF, hållbar initialclaim, återhämtning, e-postinbjudan via Kundexa, verifierad callback/serveravstämning, publik generationsbunden signeringslänk, avbrytande samt privat import av signerad PDF och audit-PDF. |
| Avstämning | Authentiserad Node-cron var femte minut återläser status och återhämtar okända försök utan ny blind submission. Felade gamla försök blockerar inte senare jobb. Heartbeat och readiness följer utfallet. |
| Drift | Readiness kräver huvudfunktionernas konfiguration och färska friska workers. Resend-webhooken markeras aktiv efter verifierad signatur; hemlighets-/URL-byte återställer vänteläge. Inaktiva äldre scraperadaptrar pausar sitt jobb efter synligt fel. |
| PR 7, BankID | Metod och provider hålls separata. BankID är inte en tillgänglig adapter och erbjuds inte som verifierad signering. Verklig BankID-anslutning ingår inte i denna installation. |

Kundexas PDF-fältredigerare och koppling till CRM är egna komponenter. PDF.js visar originalet och pdf-lib producerar det frysta granskningsdokumentet; någon egen generell PDF-signaturmotor har inte byggts. Den befintliga DocuSeal-motorn återanvänds som en separat källpinnad tjänst med ett smalt självhostat tillägg. Tillägget behövs eftersom den granskade öppna upstreamversionen saknar API för att skapa en PDF-mall.

## Verifiering

- `npm run verify`: **PASS** (exit0), Node **22.17.0**, npm **10.9.2**. Genererat schema, Edge, samtliga tester/SQL-runtime, OpenAPI, TypeScript och Next produktionsbygge passerar.
- SQL kör samtliga migrationer i PGlite och testar verkliga roller, två tenants, otillåtna direktanrop, positiv sales-wrapper, leases, replay och extern reserve → claim → invitation → completion → replay. Ändrade dokument/hashar/generationer och saknad audit nekas.
- PDF-tester kör verkliga PDF-bytes, flera sidor, svenska tecken, samma snapshot vid retry, typade kompletteringar, överflöde, sidrotation och förbjudna/tenantfrämmande sökvägar.
- Webbläsarkontroll med Chromium: canvas på två sidor, pixelposition, dragning, fältregler, filbyte/återuppladdning samt produktberoende kompletteringar. Temporära testvyer är borttagna. Detta är komponentverifiering med kontrollerad PDF-transport, inte en verklig säljarinloggning.
- Adapter- och orkestreringstester kör faktisk TypeScript-logik med kontrollerad HTTP/DB-transport. De verifierar inte extern drift.
- Ruby-syntax för controller/initializer, shell-syntax och Compose-konfiguration: PASS.
- Full Dockerbyggning: **BLOCKED**. Upstreambyggningen nådde APK-paketkällan genom sessionens proxy/CA men fick HTTP 403. Ingen Rails-boot eller verklig signering har godkänts.

Genererade Supabase-typer har inte handredigerats. Inga nya tabellkolumner krävs. Nya RPC-anrop ligger vid en begränsad server-/Edge-gräns; full typregenerering från staging återstår efter att migrationerna applicerats där.

## Kvar före drift

1. Välj server och signeringsdomän. Följ [installationsunderlaget](../services/docuseal/README.md). Det finns bas-Compose och valbar separat privat Postgres med verifierad image-digest. Ingen server eller betald tjänst har beställts.
2. Bygg och starta den källpinnade tjänsten i en miljö som når dess paketkällor. Verifiera Rails, PDF-behandling, privata volymer, TLS, API/headerkonfiguration och backup/restore.
3. Applicera migrationerna på identifierad staging, regenerera typer och deploya webb plus ändrade Edge Functions. Kör riktiga JWT/RLS/Storage-tester med två tenants.
4. Ange verklig första produkt, prisvillkor, juridisk avtalstext och egen testmottagare. Ofärdiga produktionsvillkor har inte ersatts med gissade uppgifter.
5. Konfigurera och prova Resend-callbacken samt hela e-postsigneringen. SMS är fortsatt beroende av ett lämpligt nummer och aktiva funktioner.
6. Prova ett riktigt samtal/headset och hela säljarresan. Prova även avbrott, okänt create-utfall, dubbel webhook, utgången/gammal länk och avbrytande.

Första externa flödet är avsiktligt **en obligatorisk kundsignatär via e-post**, med flera signaturfält om mallen behöver det. Orkestreringen nekar andra mottagaruppsättningar i denna version; adapterns mer generella flerpartsinterface betyder inte att en flerpartsprodukt är driftgodkänd. Fria SMS/e-postformulär finns kvar som separata behöriga sidofunktioner; avtalsutskick följer avtalsflödet.

De historiska granskningsregistrens fynd är inte automatiskt stängda i produktion. Produktionskonfiguration, leverantörsprov och leveransgodkännande ska registreras mot den faktiskt driftsatta versionen.
