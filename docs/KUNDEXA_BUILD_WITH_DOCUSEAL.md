# Bygg Kundexa med återanvänd DocuSeal-kod

Datum: 13 oktober 2026. Genomförandeplan, inte implementerad kod.

Användaren uppger att DocuSeal godkänt återanvändning av hela projektet och relevanta delar
som egen lösning efter ett samarbete. Detta är arbetsförutsättningen. Inventering av den
faktiska källkodsversionen och modulerna återstår; ingen standardprenumeration antas behövas
enbart för redan godkänd kodåteranvändning. Drift, meddelandeleverans och BankID kan ha egna kostnader.

## En produkt, tydliga ansvar

Kundexa är användarens CRM, dialer och avtalsarbetsyta. Återanvänd DocuSeals mallbyggare,
fältplacering, dokumentberedning, kundsignering och slutmaterial i en egen anpassad
dokumenttjänst bakom Kundexa. Behåll en avgränsad tjänst så beroenden inte måste skrivas om
till Next.js och så dokumentarbetet kan uppdateras utan att telefonen bryts.
Det är ett implementationsval, inte ett krav på att köpa DocuSeals molntjänst.

| Ansvar | Ägare |
|---|---|
| Tenant, användare, team och rättigheter | Kundexa |
| Kunden, ringlistan, samtalet och efterarbetet | Kundexa |
| Produkt, pris, godkänd mallversion och fältkopplingar | Kundexa |
| Visuell PDF-byggare och signeringspresentation | Återanvänd dokumenttjänst |
| Frysta avtalsuppgifter, utskickskö och affärsstatus | Kundexa |
| Signeringsoperation och signerad PDF | Dokumenttjänst; importeras till Kundexa |
| BankID-signering senare | Separat adapter/tjänst, kopplad till samma frysta avtal |

Ingen dubbel kunddatabas som kan bli två olika sanningar. Dokumenttjänsten får de frysta
uppgifter som behövs för avtalet. Lokala och externa operationer mappas till rätt tenant,
mallversion, avtal, mottagare och generation. Provider-ID från browsern räcker inte som behörighet.

## Leveranser i ordning

### 1. Fungerande och skyddad grund

Rätta kundskrivning, kommersiella överstyrningar, direkt avtalsaktivering och API-tenantstatus
enligt oktoberfynden. Samordna kundkortssparande och efterarbete innan nytt avtal/lead.
Koppla verklig produkt till färdig godkänd mall och prisversion; hitta inte på slutvillkor.

Första delmålet: säljaren kan spara rätt uppgifter och skapa ett korrekt utkast inom sina rättigheter.

### 2. Ta in och avgränsa dokumentkoden

Inventera den auktoriserade källan, lås en upstreamreferens och kartlägg byggare, PDF-beredning,
signeringsflöde, databasschema, jobb, certifikathantering och externa beroenden.
Behåll ursprung/proveniens så uppdateringar och felrättningar går att följa.
Inför egen konfiguration, privat lagring, drift/hälsa och en begränsad serverintegration.
Ingen runtimekod får markeras införd bara genom en kopierad komponent eller en plan.

Första delmålet: en isolerad dokumenttjänst kan skapa en mall och producera ett granskningsdokument.

### 3. Mallbyggare och kundkortskoppling

Administratören laddar upp PDF, drar fält till rätt platser, kopplar datakällor och godkänner
en version. Använd befintlig tillåten fältkatalog; definiera typade avtalsfält för kompletteringar.
Återanvänd byggaren, lägg Kundexas produkt-/datakoppling runt den.
Lås original, placeringar, fältregler och godkänd version. Senare ändring skapar ny version.

Första delmålet: sparat kundnamn/adress och godkänt pris visas korrekt i den ifyllda PDF:en.

### 4. Enkel säljarresa

Fyra huvudval: Ringa, Återkomster, Kunder och Avtal. Ringlistor/historik ligger under Ringa.
Under samtal: kundkort, kort anteckning, återkomst och produktval. Därefter samma arbetsyta
för komplettering, ifylld förhandsgranskning, synlig mottagare och utskick. Bevara köposition.
Mallbyggare, integrationer och avancerad kommersiell överstyrning hör till behörig administration.
UI, server actions, publikt API och databasanrop ska följa samma rättigheter.

Första delmålet: säljaren behöver inte lämna samtalsarbetsytan eller öppna dokumentadministrationen.

### 5. Verkligt utskick, kundsignering och slutdokument

Bygg extern orchestration via SigningProvider; den nuvarande utskicks-RPC:n avvisar extern
signering. Lås avtalsuppgifter och granskningsdokument före utskick. Återanvänd Kundexas
outbox efter rättning av leases, databasfel och leveransavstämning. Börja med kontrollerad e-post.
Kundexa äger inbjudningar/påminnelser; motsvarande automatisk sändning i dokumenttjänsten stängs av.

Kunden granskar och signerar rätt avtal. Verifiera händelser och stäm av status server-side.
Hämta slut-PDF och bevis för rätt generation; slutdokument får egen hash. Finalisera genom
kontrollerad övergång först när alla obligatoriska mottagare är klara. Aktivera högst en gång.
Skickat, levererat, accepterat, signerat och aktivt hålls isär.

Första delmålet: en kontrollerad mottagare får, signerar och återfår exakt rätt avtal; säljaren ser status.

### 6. Dialer och produktionsgodkännande

Rätta fjärrljud, verkliga mic-/speaker-val, DTMF, startfel och återhämtning vid nätverksavbrott.
Inför kontroll av arbetarnas färskhet och verkliga blockerare i readiness.
Verifiera kundkort → samtal → efterarbete → avtal → signering → slutdokument som sammanhängande resa.
Behåll befintligt stöd för verkliga manuella källsamtal, utan nytt generellt provider-svarskrav.

SMS kommer när befintliga kanal-/nummerblockerare är lösta. BankID kommer som separat metod
med verifierad signeringsorder, dokumentbindning och resultat; det är inte en inloggningsknapp.

Första produktionsmål: kontrollerad e-postsignering och en fungerande säljarresa med samtal,
rätt innehåll, tenantisolering och återhämtning. Resterande oktoberfynd måste hanteras enligt
sin påverkan innan hela systemet kallas grönt.

## Vad som krävs utöver återanvänd kod

- Kundexas fältkoppling, behörighet, versioner, integration och felrättningar.
- Drift för dokumenttjänsten med databas, privat dokumentlagring, backup och övervakning.
- Fungerande e-post-/SMS-transport; återanvänd befintliga leverantörer där de passar.
- Färdiga avtalstexter/produktvillkor och kontrollerade mottagare för verifiering.
- Separat BankID-anslutning senare; stöd och avtal hos vald tjänst måste fastställas då.

Ingen ytterligare generell e-signleverantör antas behövas för det första DocuSeal-baserade PDF-flödet.

## Koppling till sparad granskning

Denna byggordning konkretiserar, och ersätter inte, fyndregistret eller
[avtalsplanens PR 1–7](CONTRACT_PRODUCTION_PLAN_2026-10-13.md).
Detaljer om PDF-fält finns i [PDF-specifikationen](PDF_FIELD_TEMPLATES_AND_DOCUSEAL.md).
Alla tidigare fynd kvarstår OPEN tills faktisk rättning verifierats.
I detta pass ändras endast dokumentation; ingen DocuSeal-kod importerad eller produktionsändring gjord.
