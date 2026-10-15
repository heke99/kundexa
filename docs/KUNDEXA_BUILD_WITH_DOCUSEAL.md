# Porta valda DocuSeal-delar till Kundexa

Uppdaterad 15 oktober 2026 efter användarens förtydligande: **vi ska inte installera hela DocuSeal; vi ska porta det vi behöver**. Detta ersätter den tidigare rekommendationen om en separat dokumenttjänst. Användarens uppgivna tillstånd att återanvända DocuSeal-kod gäller fortsatt.

## Arkitektur

Kundexa behåller sin befintliga Next.js-applikation, autentisering, tenantmodell, Supabase-databas, privata dokumentlagring och transactional outbox. Kunden öppnar en tids- och generationsbunden signeringslänk i Kundexa. Ingen separat DocuSeal-app, Rails-server, databas, API-nyckel eller inloggning behövs.

| Del | Genomförande |
|---|---|
| PDF-byggare och kopplingar | Kundexas befintliga PDF-byggare, godkänd fältkatalog och typade avtalskompletteringar |
| Signaturinmatning | Relevant DocuSeal-logik för ritad underskrift portas till TypeScript/React med samma underliggande signature_pad-bibliotek |
| Validering och beskärning | Utvalda upstreamfunktioner portas med källreferens, ändringsbeskrivning och bibehållna licenstexter |
| Dokumentberedning | Kundexa fyller låsta uppgifter och placerar underskriften i exakt den granskade PDF-versionens fältrutor |
| Signeringssession | Kundexas befintliga signing_envelopes/recipients, kompletterade med kontrollerade lokala övergångar |
| Slutdokument och audit | Produceras och hashbinds i Kundexa från ett hållbart signeringskvitto, sparas privat och finaliseras atomiskt |
| Utskick | Kundexas outbox och befintliga e-posttransport; samma inbjudan/bekräftelse skapas högst en gång |
| BankID senare | Separat verifierad metod som ska kunna använda samma frysta avtal |

Den första porten stöder en obligatorisk kundsignatär med ritad elektronisk underskrift och uttryckligt godkännande. Namn, uppgiven underskrift, dokumenthash, tidpunkt, version/generation och händelsebevis binds till samma kvitto. Detta är låg identitetsnivå. Det är inte BankID, en kvalificerad/avancerad signatur eller ett påstående om certifikatbaserad PDF-signering.

## Funktioner som portas

Utgångspunkt är `docusealco/docuseal` på commit `3c65b0e4ba872fe71d5566c0d09c3ace59a7fb8a`. Portade filer identifierar originalet och avvikelser i sina källhuvuden. Ursprung och licenstexter finns i `third_party/docuseal/`.

Vi återanvänder bara funktioner som behövs för Kundexas avtalsresa. DocuSeals användarhantering, organisationer, malladministration, databas, jobbsystem, inbjudningar, externa API och hela Rails-applikation införs inte. De befintliga kundkorten är fortfarande enda CRM-källa.

## Skydd som ska gälla även efter porten

- Godkänd PDF-källa, fältplaceringar, kopplingar och policy är versionslåsta.
- Kunden ser samma ifyllda dokument som säljaren granskar; redan låsta avtalsuppgifter går inte att ändra under signering.
- Publika tokens kontrolleras mot tenantstatus, rätt mottagare, aktiv version/generation och utgångstid. Äldre eller avbrutna länkar nekas.
- Ett accepterat signeringsunderlag sparas före slutdokumentframställningen. Retry använder samma kvitto och frysta uppgifter, inte klientens senare ändringar.
- Den ritade signaturen valideras, placeras med bibehållna proportioner och får aldrig automatiskt ersätta en kundhandling.
- Signerat dokument och separat audit har egna hashar. Kontrollerad finalisering kräver rätt kvitto, dokument och generation.
- Aktivering och bekräftelse följer Kundexas behörigheter, RLS och outbox.

## Leverans och drift

PR #55 uppdateras till denna inriktning. Den tidigare `services/docuseal/`-installationen och den externa HTTP-adaptern tas bort. Blockeringen i Alpines paketkälla är därför inte en blockerare för den valda lösningen.

Driftsättning använder Kundexas vanliga webb-, migrations- och Edge-flöde. Innan produktion återstår identifierad staging, riktiga JWT/Storage-tester, slutliga produktvillkor och ett kontrollerat komplett utskick/signering/återhämtningsprov. Kod- och komponenttest ersätter inte dessa driftprov.
