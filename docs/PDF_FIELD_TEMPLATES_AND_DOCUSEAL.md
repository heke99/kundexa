# PDF-mallar med kundkortsfält och DocuSeal

Datum: 13 oktober 2026. Status: användarkrav och genomförandespecifikation; inte implementerat.

Användaren godkänner publicering av sparade granskningar, avtalsplan och projektminne till
`heke99/kundexa`. Användaren kräver en mallresa där administratören placerar textfält på en PDF,
kopplar dem till kundkortet och säljarens inmatning sedan visas på dessa platser i avtalet.
Det är den beskrivna funktionen som ska levereras; full funktionsparitet med Scrive är inte verifierad.

## Avsedd användarresa

1. Behörig malladministratör laddar upp en PDF för en produkt.
2. Administratören drar text-, datum- och signaturfält till rätt sida/plats och justerar storleken.
3. Varje informationsfält kopplas till en godkänd datakälla eller ett definierat avtalsfält.
4. Administratören förhandsgranskar med exempeldata och godkänner en ny låst mallversion.
5. Säljaren fyller i kundkortet, väljer produkt och får bara de kompletteringar mallen behöver.
6. Kunduppgifterna sparas innan avtalet skapas. En ifylld PDF visas för kontroll före utskick.
7. Kunden öppnar och signerar; Kundexa hämtar slutdokument och signeringsbevis och visar status.

Vanlig säljare ska inte administrera fältplacering, providerinställningar eller mallversioner.
Kundkortet är huvudkälla för kunduppgifter. Produktspecifika avtalsuppgifter kan visas bredvid
kundkortet men sparas på avtalsutkastet, inte som godtyckliga permanenta kundkolumner.

## Exempel på kopplingar

| PDF-fält | Källa i Kundexa | Vem fyller i |
|---|---|---|
| Kundnamn | `customer.display_name` | Säljaren i kundkortet |
| Organisationsnummer | `customer.organization_number` | Säljaren; relevant för företag |
| Adress | `customer.address_line1` | Säljaren i kundkortet |
| E-post | `customer.email` | Säljaren i kundkortet |
| Produkt | `product.name` | Härleds från produktvalet |
| Månadspris | `price.recurring_fee` | Godkänd prisversion |
| Startdatum | `contract.starts_on` | Säljaren inom produktens regler |
| Underskrift | Signeringsfält för mottagaren | Kunden under signeringen |

Kopplingarna ovan använder existerande deklaration i `src/lib/contracts/template-context.ts`.
Personnummer är endast relevant om mallens målgrupp och ändamål kräver det. Prisformat,
valuta och eventuella skatteuppgifter måste vara uttryckligt definierade i produkten.

## Vad DocuSeal stöder

Kontrollerat i officiella källor den 13 oktober 2026:

- Visuell PDF-fältbyggare finns. Inbyggd mallbyggare och signeringsvy listas som Pro-funktioner.
- Submissions API kan förifylla namngivna fält genom `submitters[].values` och låsa dem med
  fältkonfigurationens `readonly`. Signeringsfält lämnas till rätt mottagare.
- Slutdokument och auditmaterial kan hämtas efter signeringen. Alla obligatoriska parter måste
  vara klara; en enskild mottagarhändelse räcker inte.
- Kundkortskoppling, Kundexas behörigheter och produktpolicy är vårt integrationsarbete.

Källor: [repository](https://github.com/docusealco/docuseal),
[API](https://www.docuseal.com/docs/api),
[embedding](https://www.docuseal.com/embedding),
[pris/funktionsplan](https://www.docuseal.com/pricing).

Rekommenderad riktning är DocuSeal som separat dokument-/signeringstjänst genom Kundexas adapter.
Inbyggd mallbyggare är förstahandsval om motsvarande licens/driftmodell väljs. Köp, installation
eller liveaktivering görs inte genom denna specifikation. En fristående mallbyggare kan vara ett
första administratörsflöde; säljarens resa ska fortfarande ligga i Kundexa.

Open source-repot är AGPLv3 med ytterligare tillskrivningsvillkor; det är inte en MIT-komponent
att kopiera fritt in i CRM-koden. Exakt licens/funktionspaket ska väljas för den faktiska
integrationen. Moln- och självhostad Pro har enligt embedding-sidan API/embeddingavgifter;
självhosting innebär därför inte automatiskt fri inbyggd signering.
Se [licens](https://github.com/docusealco/docuseal/blob/master/LICENSE) och
[ytterligare villkor](https://github.com/docusealco/docuseal/blob/master/LICENSE_ADDITIONAL_TERMS).
Ingen bedömning av hur AGPL påverkar hela Kundexas kodbas görs här.

## Modell och implementationskrav

Utöka den befintliga mallversionen med dokumentläge: textgenererad eller PDF med placerade fält.
Behåll gamla mallar och avtal läsbara. Lägg till nya migrationer; skriv inte om levererade migrationer.

En godkänd PDF-mallversion ska låsa källfil/hash, fältschema, placeringar, kopplingar,
valideringsregler, produkt, mottagarroller och signeringspolicy. Varje fält behöver ett stabilt
internt ID, en entydig provideridentitet, svensk etikett, typ, datakälla, krav och redigeringsrätt.
Ett fält kan förekomma på flera platser i PDF:en men ska få samma värde på samtliga platser.
Providerformatets koordinater och sidnumrering ska översättas i adaptern och kontrolleras med
sidrotation/skalning; Kundexa ska inte anta ett format från ett annat PDF-bibliotek.

Okända datakällor och dubbla/tvetydiga providerfält ska stoppa mallgodkännandet. Använd en
tillåten fältkatalog, inte godtyckliga JSON-sökvägar eller körbar kod. Kompletteringsfält får
egna typade definitioner och rättigheter. Förifyllda avtalsvillkor är låsta för kunden;
vanlig säljare får inte ändra godkända priser genom vare sig UI eller direktanrop.

Spara kundkortet innan renderingen. Skapa sedan en fryst avtalssnapshot med exakt mallversion,
fältvärden, parter, prisversion och generation. Senare kundkortsändringar ska inte ändra ett
utskickat avtal. Före utskick ska säljaren se samma ifyllda innehåll som kunden granskar.

En tom original-PDF är inte tillräckligt signeringsunderlag. Ursprunglig PDF, mall/fältschema,
frysta värden, ifyllt granskningsdokument och slutligt signerat dokument ska ha tydlig lineage
och egna hashar. Slut-PDF:ens bytes ändras genom signeringen och ska inte krävas ha samma hash
som originalet. Om DocuSeal står för förifyllning måste rätt generations innehåll kunna
förhandsgranskas och bindas till signeringsoperationen. Automatisk API-signering får inte
användas som bevis för att kunden har granskat eller signerat.

Mallredigering efter godkännande skapar en ny version; ändringar i providerverktyget får inte
stilla ändra redan godkänd mall. Provider-ID ensamt är ingen versionslåsning. Adaptern ska
använda isolerad version eller verifiera låst schema/dokument innan operationen startar.

Alla lokala kopplingar och provideroperationer är tenantbundna. Browsern får ingen generell
API-nyckel. Eventuella builder-sessioner ska utfärdas server-side för behörig aktör och rätt mall.
Behörighetskontroller måste gälla också direkta anrop och två tenants. PDF och slutmaterial
sparas privat med kontrollerad åtkomst och retention.

## Ordning för genomförandet

1. Rätta de befintliga blockerarna i avtalsplanens PR 1–4 och kundkortssparandet i PR 5.
2. Lägg till versionsmodell och fältkopplingar samt administratörens PDF-mallflöde.
3. Lägg till säljarens kompletteringar och ifyllda förhandsgranskning i samma arbetsyta.
4. Koppla DocuSeal-adaptern, extern utskickskedja, statusavstämning och slutdokument.
5. Genomför kontrollerad utskick/signering och verifiera innehåll, mottagare, generation och status.

Detta kompletterar [avtalsplanen](CONTRACT_PRODUCTION_PLAN_2026-10-13.md), särskilt PR 2, 4, 5 och 6.
Nuvarande tomma providerregister och `prepare_contract_delivery_v2` som avvisar extern signering
innebär att en mallbyggare ensam inte gör avtalskedjan fungerande.

## BankID senare

PDF-mall och kundkortskoppling ska vara oberoende av signeringsmetod. Förbered separata
adapterkapabiliteter för dokumentberedning, signeringssession och slutmaterial. BankID ska
kunna signera det frysta avtalet via en separat verifierad tjänst utan ny mallbyggare eller
ny säljarresa. Inbyggt svenskt BankID-stöd i DocuSeal är inte verifierat eller utlovat.
BankID-inloggning räknas inte som avtalsunderskrift. BankID-konfiguration/köp är framtida arbete.

## Klart när

- En administratör kan placera och koppla fält i en flersidig PDF och godkänna versionen.
- Säljarens sparade kunddata hamnar på rätt platser, inklusive å/ä/ö, datum och långa värden.
- Text utanför fältrutan stoppas eller hanteras enligt vald regel; inget försvinner tyst.
- Kunden kan inte ändra låsta värden och signerar endast sitt avtal och sin generation.
- Mall-/kundändringar, dubbla händelser, nätverksavbrott och gamla länkar ändrar inte slutavtalet.
- Slut-PDF och bevis återkommer och aktivering sker högst en gång genom kontrollerad övergång.
- Säljaren behöver inte öppna mallbyggaren eller ett separat DocuSeal-administrationskonto.

Verifiering i detta pass: källkod och officiell dokumentation granskade. Ingen implementation,
databasändring, applikationstest, providerinstallation eller faktisk signering genomförd.
