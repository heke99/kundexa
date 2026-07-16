CRM-system med dialer, kunddata, avtal och automatiseringar
1. Produktens grundidé
Systemet ska vara en komplett plattform för försäljning, kundhantering, telefoni och avtal.
Hela arbetsflödet ska finnas i samma system:
Importera eller hitta prospekt → filtrera målgrupp → fördela leads → ringa kunder → dokumentera samtal → skapa eller ladda upp avtal → skicka via SMS och e-post → kund signerar → följa upp kund och avtal.
Systemet ska inte bestå av flera fristående lösningar som bara länkas ihop. Kundkortet ska vara den gemensamma kärnan för samtal, avtal, aktiviteter, anteckningar, dokument och försäljningshistorik.
Systemet ska kunna erbjudas som en multi-tenant SaaS-lösning där flera företag använder samma plattform men där varje företags data är fullständigt separerad.

2. Företag, organisationer och team
Varje kundföretag i systemet ska kunna skapa sin egen organisation med:
* Företagsadministratörer
* Teamledare
* Säljare
* Avtalsansvariga
* Kvalitetskontroll
* Backoffice
* Ekonomianvändare
* Läsbehöriga användare
* Anpassade roller
Organisationen ska kunna innehålla:
* Flera team
* Flera avdelningar
* Flera kontor
* Olika kampanjer
* Separata kundlistor
* Egna telefonnummer
* Egna e-postavsändare
* Egna produkter och avtalsmallar
* Egna automatiseringsregler
En säljare ska normalt se sina egna kunder och leads.
En teamledare ska se teamets kunder, avtal, aktiviteter och resultat.
En administratör ska kunna se och hantera allt inom organisationen.
Behörighet ska kunna styras på:
* Företagsnivå
* Teamnivå
* Kampanjnivå
* Kundnivå
* Avtalsnivå
* Dokumentnivå
* Inspelningsnivå
* Exportnivå
* Fältnivå

3. Kundregister och prospekt
Systemet ska hantera:
* Privatpersoner
* Företag
* Kontaktpersoner
* Företagsgrupper
* Arbetsställen
* Prospekt
* Befintliga kunder
* Tidigare kunder
* Förlorade kunder
* Spärrade kunder
* Kunder med aktiva avtal
* Kunder med utgående avtal
Varje kundkort ska kunna innehålla:
* Namn
* Personnummer när det är tillåtet och nödvändigt
* Organisationsnummer
* Telefonnummer
* Mobilnummer
* Fast telefonnummer
* E-post
* Adress
* Postnummer
* Ort
* Kommun
* Län
* Land
* Koordinater
* Företagsnamn
* Juridisk form
* Bransch
* SNI-kod
* Omsättning
* Resultat
* Antal anställda
* F-skatt
* Momsregistrering
* Arbetsgivarregistrering
* Webbplats
* Kontaktpersoner
* Nuvarande leverantör
* Produkter kunden har
* Kundstatus
* Leadstatus
* Avtalsstatus
* Ansvarig säljare
* Ansvarigt team
* Kampanj
* Datakälla
* Senaste datakontroll
* Senaste kontakt
* Nästa aktivitet
* Antal ringförsök
* Anteckningar
* Taggar
* Dokument
* Samtal
* Inspelningar
* Skickade avtal
* Signerade avtal
* Förlorade affärer
* Spärrar och invändningar
* Samtycken och rättslig grund
* Fullständig händelsehistorik

4. Kund- och leadstatusar
Systemet ska kunna hantera exempelvis:
* Nytt prospekt
* Ej kontaktad
* Tilldelad
* Kontaktförsök pågår
* Inget svar
* Upptaget
* Fel nummer
* Återuppringning
* Kontaktad
* Kvalificerad
* Intresserad
* Inte intresserad
* Offert önskas
* Offert skickad
* Avtal skapat
* Avtal skickat
* Avtal öppnat
* Signering påbörjad
* Signerat
* Nekat
* Avtal förfallet
* Befintlig kund
* Förnyelse aktuell
* Uppsagd kund
* Förlorad kund
* Spärrad
* Ring ej
* Dubblett
* Ogiltiga kontaktuppgifter
Statusar ska kunna anpassas av administratören.

5. Import av listor
Systemet ska kunna ta emot kund- och prospektlistor genom:
* CSV
* Excel
* Manuellt skapade listor
* Publikt API
* Externa leverantörers API
* Webhooks
* Schemalagda importer
* SFTP
* Säker filleverans
* Import från andra CRM-system
* Import från dataleverantörer som Merinfo
* Import från myndighets- eller företagsregister
Varje import ska sparas som en egen importkörning med:
* Importnamn
* Källa
* Datum och tid
* Uppladdande användare
* Antal poster
* Antal nya kunder
* Antal uppdaterade kunder
* Antal dubletter
* Antal fel
* Antal spärrade poster
* Importerade fält
* Resultatrapport
* Möjlighet att återställa importen
Systemet ska vid import:
1. Validera filer och API-data.
2. Normalisera telefonnummer.
3. Normalisera organisationsnummer och personnummer.
4. Normalisera adresser.
5. Kontrollera obligatoriska fält.
6. Identifiera dubletter.
7. Matcha mot befintliga kunder.
8. Kontrollera interna spärrar.
9. Kontrollera om kontaktuppgifter saknas.
10. Flagga osäker eller gammal data.
11. Spara datakälla och hämtningstid.
12. Fördela leads till team eller säljare.
13. Förhindra att importer skriver över manuellt verifierad information utan regler.
14. Hantera konflikter mellan olika datakällor.
15. Kunna simulera importen innan den genomförs.

6. Integration med Merinfo och andra dataleverantörer
Systemet ska kunna integreras mot Merinfo eller liknande leverantörer för att:
* Söka efter företag
* Söka efter privatpersoner där användning är tillåten
* Hämta kontaktuppgifter
* Hämta telefonnummer
* Hämta adresser
* Hämta företagsuppgifter
* Hämta branschuppgifter
* Hämta omsättning
* Hämta antal anställda
* Hämta status och juridisk form
* Hämta kontaktpersoner
* Skapa målgruppsurval
* Importera urval direkt till en lista
* Uppdatera befintliga kunder
* Kontrollera om information har förändrats
Integrationen ska byggas genom en generell dataleverantörsmodell.
Systemet ska därför inte hårdkodas endast för Merinfo.
Det ska finnas stöd för flera leverantörer genom exempelvis:
* data_providers
* provider_connections
* provider_field_mappings
* provider_imports
* provider_usage_logs
* provider_licenses
För varje uppgift ska systemet kunna spara:
* Datakälla
* Extern identifierare
* När uppgiften hämtades
* När den senast verifierades
* Vilken användare som hämtade den
* Tillåtet användningsändamål
* Eventuell gallringsfrist
* Om uppgiften får exporteras
* Om uppgiften får användas för marknadsföring
Merinfos webbplats ska inte skrapas. Integrationen ska ske genom avtalad API- eller filleverans.

7. Företagsfilter
Systemet ska kunna filtrera företag på exempelvis:
* Land
* Län
* Kommun
* Ort
* Postnummer
* Geografisk radie
* SNI-kod
* Bransch
* Underbransch
* Juridisk form
* Företagsstatus
* Aktivt företag
* Avregistrerat företag
* Konkurs
* Likvidation
* Registreringsdatum
* Nystartat företag
* Antal anställda
* Omsättningsintervall
* Resultatintervall
* Balansomslutning
* Exportverksamhet
* Importverksamhet
* Huvudkontor
* Arbetsställe
* Privat ägande
* Offentligt ägande
* F-skatt
* Momsregistrering
* Arbetsgivarregistrering
* Telefonnummer finns
* Mobilnummer finns
* E-post finns
* Webbplats finns
* Kontaktperson finns
* Antal kontaktpersoner
* Senast uppdaterad
* Datakälla
* Tidigare kontaktad
* Senaste kontakt
* Antal ringförsök
* Ringresultat
* Kundstatus
* Leadstatus
* Avtalsstatus
* Aktivt avtal
* Utgående avtal
* Ansvarig säljare
* Ansvarigt team
* Kampanj
* Produktintresse
* Nuvarande leverantör
* Tidigare köp
* Förlorad orsak
* Spärrstatus

8. Privatpersonsfilter
När det finns lagligt stöd för behandlingen ska systemet kunna filtrera på:
* Land
* Län
* Kommun
* Ort
* Postnummer
* Geografisk radie
* Åldersintervall
* Telefonnummer finns
* Mobilnummer finns
* Fast telefonnummer finns
* E-post finns
* Senast uppdaterad
* Datakälla
* Tidigare kontaktad
* Senaste kontakt
* Antal ringförsök
* Ringresultat
* Kundstatus
* Leadstatus
* Aktivt avtal
* Tidigare avtal
* Ansvarig säljare
* Ansvarigt team
* Kampanj
* Produktintresse
* Befintlig kundrelation
* Intern ring-ej-status
* NIX-status när det krävs
* Invändning mot direktmarknadsföring
* Samtycke
* Annan rättslig grund
Systemet ska inte tillåta målgruppsfilter baserade på känsliga personuppgifter.

9. Sparade och dynamiska listor
Användare ska kunna skapa:
* Statiska listor
* Dynamiska listor
* Kampanjlistor
* Teamlistor
* Personliga arbetslistor
* Återuppringningslistor
* Avtalsuppföljningslistor
* Förnyelselistor
* Spärrlistor
* Importlistor
En dynamisk lista ska uppdateras automatiskt när kunddata förändras.
Exempel:
Aktiebolag i Skåne inom restaurangverksamhet, 1–20 anställda, omsättning över 2 miljoner kronor, giltigt telefonnummer, inget aktivt avtal och inte kontaktade de senaste 60 dagarna.
Listor ska kunna:
* Sparas
* Dupliceras
* Delas med team
* Låsas
* Arkiveras
* Exporteras med behörighet
* Användas i kampanjer
* Användas av dialern
* Användas i automatiseringar
* Schemaläggas för automatisk uppdatering

10. Leadfördelning
Leads ska kunna fördelas:
* Manuellt
* Jämnt mellan säljare
* Baserat på team
* Baserat på geografi
* Baserat på produkt
* Baserat på bransch
* Baserat på säljarens kompetens
* Baserat på säljarens kapacitet
* Baserat på prestation
* Baserat på språk
* Baserat på öppettider
* Baserat på tidigare kundrelation
* Genom köer
* Genom round-robin
* Genom viktad fördelning
Administratören ska kunna bestämma:
* Hur många leads en säljare får
* Hur länge säljaren får behålla leadet
* När ett lead ska återgå till teamets kö
* När ett lead får omfördelas
* Vad som händer om säljaren är frånvarande
* Om leads får överlåtas mellan säljare
* Om säljare får välja egna leads

11. Inbyggd dialer
Dialern ska vara direkt integrerad i CRM-systemet.
Den ska stödja:
* Klicka för att ringa
* Preview dialer
* Power dialer
* Progressiv dialer
* Prediktiv dialer som en senare och strikt kontrollerad funktion
* Manuella samtal
* Köbaserad uppringning
* Inkommande samtal
* Utgående samtal
* Blandade inkommande och utgående kampanjer
* WebRTC i webbläsaren
* SIP-telefoner
* Mobil vidarekoppling
* Samtalsköer
* Svarsgrupper
* Vidarekoppling
* Nummerpresentation
* Kampanjnummer
* Lokala nummer
* Egna nummer per företag
* Egna nummer per team
* Samtalsinspelning där det är tillåtet
* Realtidsstatus
* Samtalsövervakning med behörighet
* Medlyssning med behörighet
* Coachning av säljare
* Pausstatusar
* Efterarbete
* Schemalagda återuppringningar
* Automatiska samtalsresultat
* Samtalsanteckningar
* Samtalstaggar
* Blockering av spärrade nummer
* Missade samtal
* Röstbrevlåda
* Samtalsköhistorik
* Samtalstid
* Väntetid
* Svarstid
* Kontaktgrad
När ett samtal kopplas fram ska rätt kundkort öppnas automatiskt.

12. Samtalsresultat
Efter varje samtal ska säljaren ange ett resultat.
Exempel:
* Inget svar
* Upptaget
* Röstbrevlåda
* Fel nummer
* Numret ur bruk
* Ring senare
* Inte intresserad
* Intresserad
* Offert önskas
* Avtal ska skickas
* Avtal skickat
* Redan kund
* Bytt leverantör
* Vill bli kontaktad via e-post
* Vill bli kontaktad via SMS
* Ring ej igen
* Kund spärrad
* Klagomål
* Eskalera till teamledare
Varje samtalsresultat ska kunna styra:
* Nästa aktivitet
* Nästa ringtid
* Leadstatus
* Prioritet
* Omfördelning
* Automatisering
* SMS-utskick
* E-postutskick
* Avtalsskapande
* Spärrning
* Rapportering

13. Kampanjer
Administratören ska kunna skapa kampanjer med:
* Kampanjnamn
* Beskrivning
* Startdatum
* Slutdatum
* Aktiva dagar
* Tillåtna ringtider
* Tilldelade team
* Tilldelade säljare
* Kundlistor
* Produkter
* Samtalsmanus
* Frågeformulär
* Samtalsresultat
* Maximalt antal försök
* Väntetid mellan försök
* Telefonnummer
* E-postmallar
* SMS-mallar
* Avtalsmallar
* Automatiseringar
* Mål
* Budget
* Kostnadsgränser
* Behörigheter

14. CRM-pipeline
Systemet ska ha en visuell försäljningspipeline.
Exempel:
Nytt lead → kontaktförsök → kontaktad → kvalificerad → offert → avtal skickat → signerat → aktiverad kund
Varje affär ska kunna innehålla:
* Kund
* Ansvarig säljare
* Team
* Produkt
* Affärsvärde
* Sannolikhet
* Förväntat avslutsdatum
* Nästa aktivitet
* Affärssteg
* Dokument
* Anteckningar
* Samtal
* Offert
* Avtal
* Förlustorsak
* Konkurrent
* Nuvarande leverantör
* Förnyelsedatum
Separata pipelines ska kunna skapas för:
* Nyförsäljning
* Merförsäljning
* Förnyelse
* Kundräddning
* Support
* Partners
* Företagsförsäljning
* Privatkundsförsäljning

15. Avtalssystem
Systemet ska visa alla avtal som:
* Användaren har skapat
* Användaren har skickat
* Teamet har skapat
* Teamet har skickat
* Organisationen har skapat
* Kunden har öppnat
* Kunden har signerat
* Kunden har nekat
* Har förfallit
* Har avbrutits
* Har ersatts
* Är aktiva
* Snart löper ut
* Har sagts upp
Avtal ska kunna filtreras på:
* Status
* Kund
* Säljare
* Team
* Kampanj
* Produkt
* Avtalstyp
* Signeringsmetod
* Skapandedatum
* Skickat datum
* Signerat datum
* Startdatum
* Slutdatum
* Förnyelsedatum
* Avtalsvärde
* Bindningstid
* Datakälla

16. Skapa avtal i systemet
Systemet ska kunna skapa avtal genom:
* Avtalsmall
* Produktmall
* Dynamiskt formulär
* Tidigare avtal
* Kopiering av befintligt avtal
* API
* Import
* Uppladdad PDF
Avtal ska automatiskt kunna fyllas med:
* Kundens namn
* Personnummer eller organisationsnummer
* Adress
* Kontaktuppgifter
* Företagsuppgifter
* Kontaktperson
* Säljarens namn
* Team
* Företagets uppgifter
* Produkt
* Pris
* Avgifter
* Rabatt
* Bindningstid
* Startdatum
* Slutdatum
* Uppsägningstid
* Villkor
* Betalningsuppgifter
* Kampanj

17. Uppladdning av PDF-avtal
Användaren ska kunna:
1. Ladda upp en befintlig PDF.
2. Förhandsgranska PDF-filen.
3. Ange dokumentnamn.
4. Ange avtalstyp.
5. Ange dokumentkategori.
6. Koppla dokumentet till kund.
7. Koppla dokumentet till affär.
8. Koppla dokumentet till säljare och team.
9. Placera signaturfält.
10. Placera datumfält.
11. Placera textfält.
12. Placera kryssrutor.
13. Placera initialfält.
14. Placera företagsfält.
15. Placera obligatoriska fält.
16. Ange flera signatärer.
17. Ange signeringsordning.
18. Ange sista svarsdatum.
19. Ange påminnelseregler.
20. Skicka via SMS.
21. Skicka via e-post.
22. Skicka via både SMS och e-post.
23. Se leveransstatus.
24. Se när länken öppnades.
25. Se när PDF-filen visades.
26. Se när signering påbörjades.
27. Se när signering slutfördes.
28. Spara signerad PDF.
29. Spara signeringsbevis.
30. Skicka slutlig kopia till kunden.

18. Avtalsmallar och produktkatalog
Administratören ska kunna skapa:
* Produkter
* Tjänster
* Paket
* Engångsavgifter
* Månadsavgifter
* Rörliga avgifter
* Rabatter
* Kampanjpriser
* Provisioner
* Bindningstider
* Uppsägningstider
* Förnyelseregler
* Betalningsvillkor
* Avtalsvillkor
* Avtalsmallar
* Bilagor
* Frågeformulär
* Dynamiska fält
* Obligatoriska fält
Mallar ska versionshanteras.
Det ska alltid gå att fastställa:
* Vilken mallversion som användes
* Vilka villkor som visades
* Vilken PDF som skickades
* Vilka priser som accepterades
* Vilka bilagor som ingick
* Vilken signeringsmetod som användes

19. Signering
Systemet ska kunna stödja:
* E-signering via säker länk
* BankID genom separat integration
* Engångskod via SMS
* E-postverifiering
* Företagssignering
* Flera signatärer
* Signeringsordning
* Intern attest
* Firmatecknarkontroll
* Signering av privatperson
* Signering av företagsrepresentant
Efter signering ska systemet:
1. Låsa den signerade versionen.
2. Skapa en signerad PDF.
3. Skapa signeringsbevis.
4. Beräkna dokumenthash.
5. Spara tidsstämplar.
6. Spara signeringshändelser.
7. Uppdatera avtalsstatus.
8. Uppdatera kundstatus.
9. Informera ansvarig säljare.
10. Informera teamledare vid behov.
11. Skicka bekräftelse till kunden.
12. Skicka signerad kopia till kunden.
13. Starta eventuell onboarding.
14. Skicka webhook till externa system.
15. Arkivera avtalet enligt organisationens regler.

20. Utskick via SMS och e-post
Avtal och andra dokument ska kunna skickas genom:
* SMS
* E-post
* Både SMS och e-post
* Manuellt utskick
* Automatiskt utskick
* Schemalagt utskick
* Påminnelseutskick
Varje utskick ska ha:
* Mottagare
* Avsändare
* Kanal
* Mall
* Tidpunkt
* Leveransstatus
* Öppningsstatus
* Klickstatus
* Felmeddelande
* Antal försök
* Leverantör
* Kostnad
* Kopplat avtal
* Kopplad kund
* Kopplad kampanj

21. E-postsystem
E-postdelen ska stödja:
* SMTP
* Transaktionella e-postleverantörer
* Egna avsändardomäner per företag
* SPF
* DKIM
* DMARC
* Leveransrapporter
* Studsar
* Klagomål
* Blockerade adresser
* Mallar per företag
* Mallar per team
* Versionshantering
* Flera språk
* Anpassad branding
* Automatiska påminnelser
* Loggning av alla utskick

22. SMS-system
SMS-delen ska stödja:
* Flera SMS-leverantörer
* Avsändarnamn
* Avsändarnummer
* Eget nummer
* Leveransrapporter
* Kortlänkar
* Länkar under egen domän
* Stoppord
* Avregistrering
* Reservleverantör
* Kostnadstak
* Begränsningar per användare
* Begränsningar per team
* Begränsningar per kampanj
* Begränsningar per företag
* Schemalagda SMS
* Mallar
* Versionshistorik
SMS och telefoni kommer inte vara helt kostnadsfria i produktion eftersom operatörstrafiken kostar pengar.
Systemet ska därför byggas med leverantörsadaptrar så att man kan byta mellan exempelvis olika SIP-, telefoni- och SMS-leverantörer.

23. Adminstyrda automatiseringar
Automatiseringar ska inte vara hårdkodade.
Administratören ska kunna skapa och ändra automatiseringar för:
* Hela företaget
* Ett team
* En kampanj
* En lista
* En produkt
* En kundtyp
* En avtalstyp
* En särskild pipeline
Varje automatisering ska bestå av:
* Trigger
* Villkor
* Fördröjning
* Åtgärd
* Undantag
* Prioritet
* Aktiv eller inaktiv status

24. Automatisering av ringförsök
Administratören ska kunna bestämma:
* Maximalt antal ringförsök
* Exempelvis 7 försök
* Minsta tid mellan försök
* Tillåtna ringdagar
* Tillåtna ringtider
* Skillnad mellan inget svar och upptaget
* När ett lead ska flyttas till en annan kö
* När ett lead ska omfördelas
* När teamledare ska informeras
* När SMS ska skickas
* När e-post ska skickas
* När leadet ska pausas
* När leadet ska avslutas
* När kunden får kontaktas igen
* När kunden ska spärras
Exempel:
* Efter 1 obesvarat försök: nytt försök senare samma dag.
* Efter 3 obesvarade försök: vänta 48 timmar.
* Efter 5 försök: flytta till lågprioriterad kö.
* Efter 7 försök: avsluta kampanjen för kunden i 90 dagar.
* Vid kundens invändning: spärra omedelbart och stoppa alla framtida utskick.

25. Automatiseringstriggers
Exempel på triggers:
* Ny kund skapad
* Ny lead importerad
* Lead tilldelad
* Lead inte bearbetad
* Samtal startat
* Samtal avslutat
* Inget svar
* Upptaget
* Fel nummer
* Återuppringning bokad
* Kund intresserad
* Offert skapad
* Avtal skapat
* Avtal skickat
* SMS levererat
* E-post levererad
* Dokument öppnat
* Dokument inte öppnat
* Signering påbörjad
* Avtal signerat
* Avtal nekat
* Avtal förfallet
* Avtal löper snart ut
* Kund byter team
* Kund invänder mot marknadsföring
* Kund spärras
* Kund blir inaktiv

26. Automatiseringsåtgärder
Systemet ska kunna:
* Skapa aktivitet
* Skapa återuppringning
* Ändra kundstatus
* Ändra leadstatus
* Ändra affärssteg
* Tilldela säljare
* Tilldela team
* Omfördela lead
* Flytta kund till lista
* Ta bort kund från lista
* Skicka SMS
* Skicka e-post
* Skicka avtal
* Skicka påminnelse
* Skapa uppgift
* Informera teamledare
* Informera administratör
* Skicka webhook
* Anropa externt API
* Spärra kund
* Stoppa framtida kontakt
* Skapa förnyelseaffär
* Skapa onboarding
* Arkivera kund
* Arkivera avtal

27. Säkerhet i automatiseringar
Automatiseringar ska ha:
* Versionshistorik
* Testläge
* Förhandsvisning
* Simulering
* Prioritetsordning
* Konflikthantering
* Revisionslogg
* Godkännande för massåtgärder
* Begränsning av SMS
* Begränsning av e-post
* Begränsning av samtal
* Kostnadstak
* Stoppknapp
* Möjlighet att återställa ändringar
* Skydd mot oändliga loopar
* Idempotens
* Felkö
* Återförsök
* Notifiering vid fel

28. Aktiviteter och kalender
Systemet ska stödja:
* Uppgifter
* Återuppringningar
* Möten
* Påminnelser
* Avtalsuppföljning
* Förnyelseuppgifter
* Onboardinguppgifter
* Interna kommentarer
* Tilldelning
* Prioritet
* Förfallodatum
* Återkommande aktiviteter
* Kalendervy
* Synkronisering med externa kalendrar
* Teamkalender
* Personlig kalender

29. Rapporter och dashboards
Administratörer och teamledare ska kunna se:
* Antal importerade leads
* Antal tilldelade leads
* Antal ringförsök
* Antal besvarade samtal
* Kontaktgrad
* Genomsnittlig samtalstid
* Genomsnittlig väntetid
* Antal återuppringningar
* Antal kvalificerade leads
* Antal skickade offerter
* Antal skapade avtal
* Antal skickade avtal
* Antal öppnade avtal
* Antal signerade avtal
* Signeringsgrad
* Konverteringsgrad
* Försäljningsvärde
* Förlorat värde
* Förlustorsaker
* Resultat per säljare
* Resultat per team
* Resultat per kampanj
* Resultat per lista
* Resultat per datakälla
* Resultat per produkt
* Resultat per geografiskt område
* Kostnad per samtal
* Kostnad per lead
* Kostnad per signerat avtal
* SMS-kostnader
* Telefonikostnader
* E-postleverans
* Avtal som väntar på signering
* Avtal som snart löper ut
* Kvalitetsavvikelser

30. Realtidsvy för teamledare
Teamledaren ska kunna se:
* Vilka säljare som är inloggade
* Vilka som är tillgängliga
* Vilka som ringer
* Vilka som har paus
* Vilka som har efterarbete
* Aktiva samtal
* Köstatus
* Väntande kunder
* Antal samtal
* Kontaktgrad
* Senaste aktivitet
* Skickade avtal
* Signerade avtal
* Dagens försäljning
* Mål kontra utfall

31. API
Systemet ska byggas API-first.
API:t ska kunna:
* Skapa kunder
* Uppdatera kunder
* Hämta kunder
* Söka kunder
* Importera leads
* Skapa listor
* Uppdatera listor
* Skapa kampanjer
* Skapa affärer
* Uppdatera pipeline
* Skapa aktiviteter
* Skapa samtalsuppdrag
* Hämta samtalsresultat
* Skapa avtal
* Ladda upp PDF
* Skicka avtal
* Hämta avtalsstatus
* Hämta signerade dokument
* Skapa produkter
* Synkronisera användare
* Synkronisera team
* Synkronisera prislistor
* Hantera spärrar
* Hämta rapportdata
API:t ska ha:
* API-nycklar
* OAuth där det behövs
* Tenantkontroll
* Behörigheter
* Rate limits
* Idempotens
* Versionshantering
* Revisionslogg
* Webhook-signering
* Felhantering
* Sandboxmiljö
* Dokumentation
* API-loggar
* Användningsstatistik

32. Webhooks
Exempel på webhook-händelser:
* customer.created
* customer.updated
* customer.assigned
* customer.blocked
* lead.imported
* lead.assigned
* call.started
* call.answered
* call.completed
* callback.scheduled
* deal.created
* deal.stage_changed
* contract.created
* contract.sent
* contract.delivered
* contract.opened
* contract.signing_started
* contract.signed
* contract.declined
* contract.expired
* contract.cancelled
* document.uploaded
* customer.do_not_call
* automation.executed
* automation.failed

33. Säkerhet och dataskydd
Systemet ska byggas med:
* Multi-tenant-isolering
* Rollbaserad behörighet
* Fältnivåbehörighet
* MFA
* Kryptering under överföring
* Kryptering i lagring
* Säker sessionshantering
* IP-loggar
* Enhetsloggar
* Revisionsloggar
* Backup
* Återställning
* Katastrofåterställning
* Hemlighetshantering
* Rate limits
* Intrångsskydd
* Virus- och filkontroll
* Signerade nedladdningslänkar
* Tidsbegränsade länkar
* Säker objektlagring
* Skydd mot massuttag
* Exportbehörighet
* Separat behörighet för inspelningar
* Separat behörighet för personnummer
* Separat behörighet för avtal
* Incidenthantering
* Gallringsregler
* Dataportabilitet
* Rättelse
* Radering där det är tillåtet
* Bevarande av juridiskt nödvändiga avtal
* Loggning av åtkomst till känsliga uppgifter
En vanlig säljare ska inte automatiskt kunna:
* Exportera hela kundregistret
* Se alla team
* Lyssna på alla inspelningar
* Ändra automatiseringar
* Ändra avtal efter signering
* Se känsliga uppgifter som inte behövs för arbetet
* Skicka obegränsade SMS
* Genomföra massutskick

34. Ring-ej och invändningar
Systemet ska ha en central spärrmotor.
Den ska kontrollera:
* Intern ring-ej-lista
* Kundens invändning
* NIX när det krävs
* Kampanjregler
* Tillåtna ringtider
* Antal tidigare försök
* Senaste kontakt
* Datakällans användningsvillkor
* Rättslig grund
* Om kunden redan är aktiv kund
* Om kunden har en pågående tvist
* Om kunden redan har bett att inte bli kontaktad
En spärrad kund ska stoppas innan:
* Samtal
* SMS
* E-post
* Ny kampanjtilldelning
* Automatisering
* Export till extern dialer

35. Open-source-komponenter att utvärdera
CRM
Twenty
Kan användas som:
* Teknisk referens
* UI-referens
* Inspirationskälla för CRM-objekt
* Referens för dynamiska fält
* Referens för vyer och workflows
Twenty bör inte automatiskt bli systemets huvuddatabas utan licens- och arkitekturgranskning.
EspoCRM
Kan användas som:
* Referens för mogna CRM-flöden
* Referens för leads, kontakter och affärer
* Möjlig grund för enklare installationer
Nackdelen är en äldre teknisk stack och ett mer traditionellt CRM-gränssnitt.
SuiteCRM
Kan användas som:
* Referens för avancerade CRM-funktioner
* Referens för rapportering
* Referens för omfattande kundhantering
Nackdelen är att det är tungt att anpassa till ett modernt integrerat dialer- och avtalssystem.
Frappe CRM
Kan användas som:
* Alternativ CRM-bas
* Referens för anpassningsbara objekt
* Referens för Frappe-ekosystemet

36. Open-source för telefoni
Asterisk
Asterisk kan användas som underliggande telefonimotor för:
* SIP
* Samtalsköer
* Inkommande samtal
* Utgående samtal
* Vidarekoppling
* Samtalsinspelning
* API-integration
* Samtalskontroll
Asterisk ska helst ligga bakom vårt eget moderna CRM-gränssnitt.
Wazo
Wazo kan användas för:
* API-baserad telefoni
* WebRTC
* JavaScript-SDK
* WebSockets
* Samtal
* Köer
* Callcenterfunktioner
Wazo är relevant om vi vill ha en mer färdig API-baserad kommunikationsplattform.
VICIdial
VICIdial innehåller redan:
* Kampanjer
* Power dialer
* Prediktiv dialer
* Inkommande samtal
* Utgående samtal
* Blended calling
* Agentgränssnitt
Det kan användas som:
* Referens
* Separat dialermotor
* Snabb prototyp
Det bör inte användas som hela plattformens huvud-CRM eller gemensamma databas.

37. Open-source för PDF och signering
Documenso
Kan utvärderas för:
* Självhostad e-signering
* PDF-flöden
* API
* Signeringsstatus
* Egna integrationsflöden
DocuSeal
Kan utvärderas för:
* PDF-formulär
* Signaturfält
* E-signering
* API
* Webhooks
* Automatiska e-postmeddelanden
Licensen måste granskas noggrant före kommersiell white-label-användning.
OpenSign
Kan utvärderas för:
* Dokument
* Mallar
* Signeringsflöden
* REST-API
* Händelsespårning
Rekommendationen är att jämföra minst Documenso och DocuSeal genom en teknisk proof of concept.

38. Open-source för automatiseringar
n8n
n8n kan användas för:
* Interna integrationer
* Tekniska bakgrundsflöden
* Synkronisering mellan system
* API-orkestrering
* Webhookflöden
n8n bör inte nödvändigtvis vara den regelmotor som slutanvändaren ser.
Systemet bör ha en egen enklare regelbyggare för teamadministratörer.
n8n:s licens måste granskas innan det byggs in i en kommersiell SaaS-produkt.

39. Öppna och kostnadsfria datakällor
Bolagsverket
Bolagsverkets öppna API:er och värdefulla datamängder kan användas för:
* Företagsidentitet
* Organisationsnummer
* Företagsstatus
* Juridisk form
* Registrerade företagsuppgifter
* Verifiering av företag
* Vissa finansiella dokument och rapporter
Bolagsverket ersätter inte Merinfos telefonnummer och kompletta målgruppsdata.
SCB
SCB:s öppna API kan användas för:
* Officiell statistik
* Branschstatistik
* Geografisk statistik
* Marknadsanalys
* Uppskattning av målgruppens storlek
* Kommun- och regiondata
SCB:s öppna statistik är inte ett komplett register med individuella säljbara leads.
SCB kan även leverera företagsurval som betaltjänst.
OpenStreetMap och Nominatim
Kan användas för:
* Adressökning
* Geokodning
* Omvänd geokodning
* Koordinater
* Kommunmatchning
* Ortmatchning
* Geografiska radiefilter
* Kartvisning
För större produktionsvolymer bör tjänsten självhostas eller ersättas av en kommersiell geokodningstjänst.
libphonenumber
Kan användas för:
* Normalisering av telefonnummer
* Kontroll av nummerformat
* Konvertering till E.164
* Identifiering av land
* Identifiering av möjlig nummertyp
Biblioteket kan inte fastställa vem som äger numret eller om numret faktiskt är aktivt.

40. Vad som inte finns gratis
Det finns ingen komplett kostnadsfri och öppen svensk datakälla som samtidigt erbjuder:
* Privatpersoner
* Telefonnummer
* Företag
* Kontaktpersoner
* Adresser
* Avancerade målgruppsfilter
* Omsättning
* Antal anställda
* Geografiskt urval
* Direkt CRM- och dialerintegration
Den delen kommer sannolikt kräva:
* Merinfo
* Annan kommersiell dataleverantör
* SCB:s betalda företagsurval
* Licensierade register
* Kundens egna listor

41. Rekommenderad teknisk arkitektur
Huvudplattform
* Next.js eller motsvarande modern webbplattform
* TypeScript
* PostgreSQL
* Redis
* Bakgrundsworkers
* Objektlagring
* WebSockets
* REST API
* Webhooks
* Multi-tenant-arkitektur
* Rollbaserad behörighet
* Revisionslogg
Separata tjänster
* CRM-tjänst
* Kund- och leadtjänst
* Importtjänst
* Databerikningstjänst
* Dialertjänst
* Telefonitjänst
* Avtalstjänst
* Dokumenttjänst
* Signeringstjänst
* SMS-tjänst
* E-posttjänst
* Automatiseringstjänst
* Rapporteringstjänst
* Spärr- och compliance-tjänst
* API gateway
* Webhooktjänst
Lagring
* PostgreSQL för strukturerad affärsdata
* Objektlagring för PDF-filer
* Objektlagring för samtalsinspelningar
* Redis för köer och realtidsstatus
* Separat analyslager vid större volymer

42. Rekommenderad användning av open source
Vi bör inte bygga hela produkten ovanpå ett enda befintligt CRM.
Rekommenderat upplägg:
* Bygg en egen gemensam CRM- och tenantkärna.
* Använd Twenty som teknisk och visuell referens.
* Använd Asterisk eller Wazo som telefonimotor.
* Använd VICIdial som referens för avancerad dialerlogik.
* Använd Documenso, DocuSeal eller OpenSign som signeringsmotor.
* Använd n8n för interna integrationsflöden där licensen tillåter.
* Använd Nominatim för geografi.
* Använd libphonenumber för telefonnummer.
* Använd Bolagsverket för grundläggande företagsverifiering.
* Använd SCB för statistik och marknadsanalys.
* Använd Merinfo eller annan kommersiell leverantör för prospektdata och telefoninformation.
Alla externa motorer ska ligga bakom egna adaptergränssnitt.
Det ska vara möjligt att byta:
* Telefonileverantör
* SMS-leverantör
* E-postleverantör
* Dataleverantör
* Signeringsmotor
* Objektlagring
* Geokodningstjänst
utan att skriva om hela systemet.

43. Systemets huvudsakliga menyer
Det färdiga systemet bör innehålla:
1. Dashboard
2. Dialer
3. Mina samtal
4. Samtalsköer
5. Kunder
6. Företag
7. Kontaktpersoner
8. Prospekt
9. Listor
10. Importer
11. Datakällor
12. Kampanjer
13. Pipeline
14. Aktiviteter
15. Kalender
16. Avtal
17. PDF-dokument
18. Avtalsmallar
19. Produkter
20. Priser
21. Signeringar
22. SMS
23. E-post
24. Automatiseringar
25. Team
26. Användare
27. Rapporter
28. Integrationer
29. API
30. Webhooks
31. Spärrar och compliance
32. Säkerhet
33. Administration
34. Fakturering och användning

44. Slutlig produktdefinition
Produkten ska vara:
Ett komplett, multi-tenant och API-baserat Sales CRM med avancerad prospektering, Merinfo-liknande målgruppsfilter, listimport, databerikning, leadfördelning, inbyggd dialer, kampanjer, kundhistorik, PDF-avtal, SMS- och e-postutskick, e-signering, adminstyrda automatiseringar, rapportering, integrations-API och fullständig revisionshistorik.
Den viktigaste principen är:
All information ska samlas runt kunden.
Från kundkortet ska användaren kunna:
* Se kundens uppgifter
* Se datakällan
* Ringa kunden
* Se tidigare samtal
* Lyssna på inspelningar med behörighet
* Skriva anteckningar
* Skapa återuppringning
* Flytta kunden i pipeline
* Skapa offert
* Skapa avtal
* Ladda upp PDF
* Skicka PDF via SMS och e-post
* Se öppnings- och signeringsstatus
* Se signerade dokument
* Se aktiva avtal
* Se förnyelser
* Se vem som har gjort vad
* Spärra framtida kontakt
* Följa hela kundrelationen från första import till avslutat avtal
