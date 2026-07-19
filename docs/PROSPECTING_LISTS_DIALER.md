# Prospektering, listor, dialer och återkomster

## Levererat mål

Kundexa använder nu ett sammanhängande flöde från prospektering till avslutat listarbete:

1. Teamadministratören söker eller filtrerar i den befintliga licensstyrda katalogen och sparar ett segment.
2. Segmentet synkroniseras till en statisk eller dynamisk ringlista utan att duplicera kundkort.
3. En eller flera säljare kopplas många-till-många till en eller flera listor.
4. Administratören väljer manuellt eller automatiskt sekventiellt ringläge, ringtider, tidszon, försökstak, callbackpolicy, caller-ID, inspelning och utfall.
5. Säljaren öppnar en tilldelad lista i sidomenyn. Systemet prioriterar förfallna återkomster, låser exakt ett prospekt och visar det kanoniska kundkortet.
6. Samtalet köas genom den befintliga 46elks/outbox-motorn. Inga providerhemligheter går till webbläsaren.
7. Nästa samtal blockeras tills providerhangup och obligatoriskt efterarbete är klara.
8. Utfall, anteckning, återkomst, order, kundlivscykel och liststatus skrivs i en databastransaktion.

## Kanonisk modell

| Ansvar | Befintlig/utökad tabell | Regel |
| --- | --- | --- |
| Person/företag/prospekt | `customers` | Ett kort per tenant och part; listor skapar inte kopior |
| Katalogkoppling/deduplicering | `master_entities`, `identity_keys`, `tenant_entities` | Externa poster matchas och länkas före nytt kundkort |
| Lista | `customer_lists` | Beskriver urval och arbetsregler |
| Prospekt i lista | `customer_list_members` | Köstatus, claim, försök och utfall; ingen kopierad kunddata |
| Säljare på lista | `customer_list_seller_assignments` | Många-till-många, status, start/slut och daglig kapacitet |
| Ringsession | `dialer_sessions` | Ägare, läge, aktiv post, återkomst och samtal |
| Samtal | `calls`, `call_events`, `call_recordings` | Kanonisk samtalshistorik och idempotenta providerhändelser |
| Återkomst | `activities` | Personlig ägare eller global team-/listkö |
| Anteckning | `notes`, `note_revisions` | Synlighet, kopplingar, fästning, historik och arkivering |
| Order | `sales_orders`, `sales_order_items` | Spårbar till kund, samtal, lista, produkt/pris och säljare |
| Kontaktspärr | `compliance_blocks`, `nix_checks` | Kontrolleras vid materialisering, claim och precis före samtal |

Alla affärstabeller är tenantbundna. RLS och server-RPC kontrollerar tenant, roll, team, listtilldelning och sessionsägarskap.

## Teamadministratörens listflöde

På `/app/lists` kan behörig owner, admin eller team lead skapa listor. På listkortet kan administratören:

- aktivera, pausa, avsluta eller arkivera listan;
- välja manuell eller automatisk sekventiell ringning;
- ange prioritet, ringdagar, lokala ringtider och IANA-tidszon;
- ange start/slut, maxförsök, retrytid och paus före nästa automatiska samtal;
- välja om återkomster får vara personliga, globala eller båda;
- tillåta hopp, låsa bearbetade prospekt till säljare och lagra bläddringsregeln;
- välja ett aktivt 46elks-nummer som caller-ID och aktivera inspelning enligt tenantens retentionpolicy;
- skriva samtalsmanus och konfigurera listans utfall;
- masskoppla säljare samt pausa, återaktivera, tidsstyra och kapacitetsbegränsa varje tilldelning;
- lägga till befintliga kunder manuellt eller köra ett sparat katalogsegment;
- se återstående arbete, policyresultat och arbetsbelastning per säljare.

Liststrategin kan inte ändras av en vanlig säljare.

## Prospektering och dynamiska listor

Katalogvyn använder samma `directorySearchSchema` och databasfunktion för sökning, summering och sparade segment. Tillgängliga filter omfattar bland annat entitetstyp, geografi, postnummer, SNI, bolagsform, anställda, omsättning, resultat, ålder, kontaktkanaler, telefontyp, källa, dataålder, registreringsuppgifter, tidigare kontakt, kontaktförsök, livscykel, ansvarig säljare/team, avtal, NIX och kontaktspärr.

`materialize_segment_to_customer_list` gör följande atomiskt och revisionsloggat:

- skapar en ny segmentsnapshot;
- återanvänder ett befintligt tenantkundkort när `tenant_entities` redan länkar katalogposten;
- skapar annars ett kanoniskt prospektkort och tenantkoppling;
- utvärderar direktmarknadsförings- och NIX-policy;
- lägger endast godkända kandidater i listan;
- köar NIX när en aktiv adapter finns och frisläpper senare godkända kandidater;
- tar vid dynamisk synk bort poster som inte längre matchar endast när de ännu inte har bearbetats;
- sparar segment-, snapshot- och synktid på listan.

Maintenance-workern synkroniserar aktiva dynamiska listor efter uppdaterade segmentsnapshots.

## Säljarens ringsession

Säljaren ser tilldelade aktiva listor i `/app/dialer`. Vid start:

1. listbehörighet, aktiv tilldelning, start/slut, ringdag, lokal tid och daglig kapacitet kontrolleras;
2. en påbörjad claim återupptas;
3. förfallen personlig eller global liståterkomst prioriteras;
4. annars låses nästa kontaktbara listpost med `FOR UPDATE SKIP LOCKED`;
5. kundkort, manus och senaste kanoniska anteckningar returneras;
6. kontaktpolicy kontrolleras igen innan samtalet köas.

I manuellt läge granskar säljaren kortet och klickar Ring. I automatiskt läge startar första samtalet efter säljarens explicita start och följande samtal först efter providerhangup, sparat utfall och konfigurerbar paus. Paus, hopp och avslut släpper både listpostens och en eventuell återkomsts claim. Två säljare kan inte samtidigt claima samma listpost.

## Efterarbete och utfall

Listutfall är konfigurerbara. Standardutfallen är intresserad, order, återkomst, inget svar, upptaget, telefonsvarare, inte intresserad, fel nummer och ring inte igen. Ett utfall kan:

- vara terminalt;
- kräva anteckning;
- kräva framtida återkomst;
- kräva order;
- ange retrytid.

`complete_dialer_work` är idempotent och transaktionell. Funktionen vägrar köras innan samtalet har terminal status och `ended_at`. Den kan skapa kanonisk anteckning, ny personlig/global återkomst, order/orderrad, kontaktspärr och kundlivscykeländring samtidigt som listclaim och session frisläpps.

Den fristående WebRTC-dialern använder `complete_manual_call_work` och har samma krav på avslutat samtal, utfall, anteckning, ny återkomst och kontaktspärr.

## Återkomster

Personliga återkomster har `assigned_user_id`. Globala återkomster har team/lista och tas atomiskt av första behöriga säljare. Återkomstvyn stödjer:

- badge och realtidsuppdatering när tiden förfaller;
- atomiskt claim och claim-expiration;
- snooze i tenantens tidszon;
- markera klar med kanonisk anteckning;
- omfördelning av admin/team lead till aktiv säljare i rätt team;
- prioritet före nya kalla prospekt i listdialern.

En liståterkomst som pausas eller vars session avslutas återgår till kön. En hanterad återkomst markeras klar av samma transaktion som efterarbetet.

## Anteckningar och order

Anteckningar sparas alltid på kundkortet. De kan vara allmänna, samtals-, callback-, order- eller interna anteckningar, med privat/team/tenant-synlighet. Ägaren eller tenantadmin kan redigera; en trigger sparar föregående version i `note_revisions`. Radering i UI är ersatt av arkivering.

Order från dialern återanvänder kundkort, aktiv produkt och prisversion. Ordern länkas till kund, samtal, lista och säljare, och prospektets livscykel uppdateras utan att skapa ett nytt kundkort. Avtals-/bekräftelseflöden fortsätter använda Kundexas befintliga versionslåsta avtals- och meddelandemotor.

## Realtid och rapportering

När Supabase Realtime finns publicerar migrationen `calls`, `activities`, `customer_lists`, `customer_list_members`, `dialer_sessions` och `sales_orders`. Dialern lyssnar specifikt på det aktiva samtalet; övriga arbetsvyer uppdateras med en debouncad server refresh. Sidomeny och notisklocka visar förfallna återkomster.

Rapportvyn summerar faktiska samtals-, callback-, medlems- och orderhändelser per lista: ringförsök, kontaktgrad, order, omsättning, hanterade återkomster och kvarvarande prospekt.

## Verifierade invarianter

`npm run verify` kontrollerar webb- och Edge TypeScript, arkitekturinvarianter, samtliga migrationer, runtime-RPC och en optimerad Next.js-build. Runtime-testet bevisar bland annat:

- säljtilldelning och atomiskt listclaim;
- caller-ID och inspelningspolicy;
- provideravslutat samtal före efterarbete;
- transaktionell order och kundkonvertering;
- global återkomstprioritet och frigivning vid sessionsslut;
- fristående callbackclaim, kanoniskt manuellt samtal och efterarbete;
- tenant/RLS-isolering och idempotenta kärnflöden.

## Produktionsberoenden

Kodflödet är klart, men skarp drift kräver livecredentials och stagingprov för 46elks, e-post, NIX och valda dataleverantörer samt juridiskt beslut om inspelning/retention. Prediktiv dialer, medlyssning och coachning ingår avsiktligt inte i denna sekventiella power-dialer-version.
