# Förfrågan till Rinkel — SIP-/WebRTC-uppgifter för egen webbtelefon

Skickas till Rinkels support eller kontaktperson. Byt ut det som står i `[hakparentes]`.
Frågorna är ställda så att **varje svar är ett ja eller ett nej** — det är det som avgör
vilken väg Kundexa kan bygga, och ett svävande svar hjälper inte.

---

**Ämne:** SIP-/WebRTC-uppgifter för inbyggd webbtelefon — Gridex (kundnr [KUNDNUMMER])

Hej,

Vi är kund hos er via [BOLAG], med [ANTAL] plats(er) och numret +46 10 808 69 54.
Vi bygger ett eget säljsystem, Kundexa, som i dag startar utgående samtal genom ert
REST-API med `POST /dial`.

Det fungerar, men det ger oss ett samtalsförlopp vi inte kan använda i säljarbete:
eftersom `/dial` kräver ett `deviceId` ringer samtalet **först upp säljarens egen
telefon**, och kunden kopplas in först när säljaren svarat. Vi vill i stället att
samtalet startar direkt i webbläsaren och går ut på vårt Rinkel-nummer, utan att
någon mellanliggande telefon ringer.

För att kunna göra det behöver vi registrera en mjukvarutelefon i webbläsaren mot er
plattform (SIP över WebSocket med WebRTC-media). Därför fyra frågor:

**1. Kan vi få SIP-registreringsuppgifter per användare/plats?**
Konkret: SIP-domän, WSS-URL (SIP över WebSocket), användarnamn/authorization-id och
lösenord. Om ni har en testplats vi kan registrera mot först vore det bästa möjliga.

**2. Tillhandahåller ni TURN, eller ska vi hålla en egen?**
WebRTC behöver STUN/TURN för att ta sig igenom brandväggar. Om ni tillhandahåller det:
vilken adress, och hur autentiseras den? Om inte, finns det något ni rekommenderar
mot er plattform?

**3. Finns det ett API för att skapa och rotera de uppgifterna?**
Vi vill inte hantera långlivade SIP-lösenord manuellt per säljare. Kan uppgifterna
skapas, hämtas och roteras via ert API — helst kortlivat eller tokenbaserat?

**4. Finns något sätt att starta ett utgående samtal *utan* `deviceId`?**
Alltså att samtalet går ut direkt på numret och kunden ringer upp först. Om `/dial`
har ett läge för det, eller om ni planerar ett, vill vi gärna veta.

**En sak till, om ni har svar på den:** vi ser inget sätt i API:et att avsluta ett
pågående samtal — det finns ingen hangup- eller terminate-endpoint. Finns den, eller
är det avsiktligt att nedkoppling bara sker på enheten?

Om svaret på fråga 1 är nej vore vi tacksamma för ett rakt besked om det, så vi vet
att den vägen är stängd och kan planera därefter.

Tack på förhand.

Vänliga hälsningar,
[NAMN]
[BOLAG]
[TELEFON] · [E-POST]

---

## Vad svaret betyder för oss

| Svar på fråga 1 | Vad det innebär |
|---|---|
| **Ja** — vi får SIP-uppgifter | Billigaste vägen. Numret, avtalet och faktureringen står kvar hos Rinkel; bara enheten byts från mobil till webbläsare. Adaptern i Kundexa kopplas mot Rinkel och webbtelefonen är klar. |
| **Nej** | Rinkel kan inte bära en inbyggd webbtelefon. Då flyttas utgående röst till en operatör med riktig WebRTC-SDK (Twilio, Telnyx, Sinch, Vonage) och numret portas dit. Kundexa-koden är redan byggd med ett adapterlager, så bytet sker på ett ställe. |

Fråga 4 är intressant även om fråga 1 blir nej: ett `/dial` utan `deviceId` skulle lösa
grundproblemet — att det ringer säljaren först — helt utan webbtelefon.
