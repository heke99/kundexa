# Telefoni och SMS

Kundexa kör mot **Sinch** i dag. Den här sidan beskriver hur telefonin hänger
ihop och var leverantören faktiskt sitter, så att ett framtida byte är en ny
adapter och inte en ombyggnad.

## Var leverantören bor

Leverantörens namn får finnas på exakt fem ställen. `scripts/verify.mjs` skannar
källträdet och fäller bygget om det står någon annanstans.

| Vad | Fil |
| --- | --- |
| Webbtelefonens adapter | `src/lib/telephony/webphone/sinch.ts` |
| Registreringstoken (JWT) | `src/lib/telephony/sinch/registration-token.ts` |
| Callback-signatur | `src/lib/telephony/sinch/callback-signature.ts` |
| Klientens SDK-hook | `src/hooks/use-sinch-webphone.ts` |
| SMS-adaptrar | `supabase/functions/_shared/sms-provider.ts`, `src/lib/messaging/provider.ts` |
| Nummerhyra | `src/lib/telephony/numbers/sinch.ts`, `src/lib/telephony/numbers/index.ts` |

Allt annat -- reservationen, platsmodellen, ringtiderna, NIX-spärren,
efterarbetet, avtalsutskicket -- talar om "en telefonitjänst" och "ett SMS".

## Utgående samtal

Webbläsaren är telefonen. Säljaren behöver inget konto hos leverantören och
ingen registrerad enhet: klienten identifierar sig med Kundexas eget
användar-ID och servern intygar det med en kortlivad JWT.

```text
säljaren klickar ring
→ POST /api/v1/calls          reserve_outbound_call: plats, samtalsrad, A-nummer, NIX, ringtider
→ webbtelefonen ringer upp    leverantörens SDK i fliken, med A-numret bundet vid registreringen
→ POST /api/v1/calls/dialing  webbläsaren rapporterar leverantörens samtals-id
→ POST /api/webhooks/sinch    leverantörens händelser är sanningskällan för förloppet
```

Servern ringer aldrig själv. `reserve_outbound_call` reserverar och stannar;
`scripts/verify.mjs` fäller en dialrutt som växer ett eget `fetch`.

### A-numret

A-numret kommer ur företagets egna `phone_numbers` och väljs i ordningen
uttryckligt val → lista → kampanj → team → företagets förval. Ett nummer som
inte är aktivt eller inte bär röst erbjuds aldrig.

Ett samtal utan A-nummer får ett samtals-id i svaret men når aldrig mottagaren,
så adaptern vägrar dela ut uppgifter innan numret finns.

### Vad som krävs för att säljaren ska kunna ringa

`telephony_status_for_current_user` svarar, och varje hinder bär sin egen
mening:

- `OUTBOUND_CALLS_DISABLED` — funktionen är av för företaget.
- `TELEPHONY_DISABLED` — telefonin är avstängd för företaget.
- `OUTSIDE_CALLING_HOURS` — utanför företagets ringtider.
- `CALLER_ID_MISSING` — företaget har inget nummer att visa.
- `ACTIVE_CALL_ALREADY_EXISTS` — säljaren har redan ett pågående samtal.
- `WEBPHONE_NOT_CONFIGURED` — serverns nycklar saknas (läggs till av rutten).

## Platsen

En säljare har en plats i taget. `dial_attempts` med ett partiellt unikt index
över de statusar som håller platsen är hela spärren; `dial_attempt_holds_seat`
definierar vilka de är.

Platsen släpps av: säljaren som avslutar samtalet, webbtelefonens egen rapport
att benet dog, sessionen som tappar registreringen, och som sista utväg
`release_stale_dial_attempts` i maintenance-workern. Den sista rör aldrig ett
uppkopplat samtal (`matched`) hur länge det än pågår.

En sen leverantörshändelse kan inte ta tillbaka en släppt plats
(`keep_dial_attempt_terminal`). Den får berika raden, inte öppna den.

## Inkommande händelser

`POST /api/webhooks/sinch`, signaturverifierad. Adressen sätts för hand i
leverantörens kontrollpanel och går inte att läsa tillbaka; `/api/ready`
rapporterar vilken adress den borde vara.

- 403 utan orsak när signaturen inte håller.
- 503 när nycklarna saknas, så leverantören gör om leveransen.
- 200 för händelser vi inte behandlar, så de inte köar upp.

## SMS

SMS bär avtalsutskick och kundens svar, så det är lastbärande.

```text
outbox_jobs: sms.send
→ getSmsProvider(tenant)           kontomodell: Kundexas konto eller företagets eget
→ provider.send(...)               vår egen id följer med som client_reference
→ POST /api/webhooks/sms/delivery  leveransrapport, autentiserad per nummer
→ POST /api/webhooks/sms/inbound   kundens svar; ett "JA" blir en avtalsacceptans
```

Omkörning efter en timeout frågar leverantören på **vår egen referens**, aldrig
på ungefärlig tid och innehåll. Den gamla heuristiken kunde både markera ett
osänt avtal som skickat och skicka det två gånger.

Segmentantalet räknas lokalt eftersom leverantören inte rapporterar det.
Kostnaden lämnas tom när den inte rapporteras — den läses som fakturaunderlag.

Båda webhookarna autentiseras med en token per nummer. En läckt callback-URL
kan därför inte rapportera för ett annat nummer eller ett annat företag.

## Att skaffa ett nummer

Numren hyrs under Integrationer: sök på land, typ och siffror, se priset per
rad, bekräfta. Numret hamnar direkt i `phone_numbers` med sin callback-token och
med de kapabiliteter leverantören faktiskt rapporterar -- inte de kryssrutor
någon råkade fylla i.

Två saker som är medvetet gjorda så här:

- **Hyrningen kontrollerar först om vi redan äger numret.** Anropet är
  debiterbart, och ett försök vars svar tappades kan ha lyckats. Att hyra igen
  vore en andra faktura för samma nummer.
- **Ett nummer som kräver identitetshandlingar går inte att hyra härifrån.**
  Det kräver leverantörens beställningsflöde med KYC, så raden visar "Kräver
  dokumentation" i stället för en knapp som alltid misslyckas.

Att säga upp ett nummer finns inte i gränssnittet. Det är ett beslut med
uppsägningstid och fakturaföljd, och en knapp är fel ställe att fatta det på --
det görs i leverantörens panel.

## Serverinställningar

Ingen av dem får ha prefixet `NEXT_PUBLIC_`, lagras i databasen eller visas i
gränssnittet.

```text
SINCH_APPLICATION_KEY        webbtelefonens applikationsnyckel
SINCH_APPLICATION_SECRET     signerar registreringstoken och verifierar callbacks
SINCH_RTC_ENVIRONMENT_HOST   ocra.api.sinch.com
TELEPHONY_PROVIDER           vilken adapter webbtelefonen använder (tom = registrets enda)

SMS_PROVIDER                 vilken SMS-adapter som används
SMS_SERVICE_PLAN_ID          plattformens eget SMS-konto
SMS_API_TOKEN                plattformens eget SMS-konto
SMS_REGION                   eu eller us

SINCH_PROJECT_ID             nummerhyra: projektet numren hyrs i
SINCH_KEY_ID                 nummerhyra: OAuth2-nyckel
SINCH_KEY_SECRET             nummerhyra: OAuth2-hemlighet
ENFORCE_SMS_IP_ALLOWLIST     valfri IP-spärr framför SMS-webhookarna, av som standard

WEBPHONE_STUN_URLS           används bara av SIP-vägen; leverantörens SDK sköter ICE själv
WEBPHONE_TURN_URLS
WEBPHONE_TURN_SECRET
```

### Ett konto, inte ett val

All utgående post -- SMS och e-post -- går genom Kundexas konton hos
leverantörerna. Det är inte en förenkling utan vad leverantörerna kräver:
avsändardomänen måste vara verifierad hos e-postleverantören, och avsändarnumret
måste höra till det SMS-konto som skickar. Båda ägs av Kundexa.

Det som skiljer företagens utskick åt är avsändarnamnet -- avtalets utställande
bolag -- svarsadressen, och avsändarnumret. Inget av det är ett konto.

Kontomodellen lästes tidigare på fem ställen med två olika defaultvärden, så ett
företag utan uttrycklig inställning fick olika svar beroende på vilken kodväg som
frågade: utskicket kunde prövas mot en nyckel och skickas med en annan.

Numren hyrs av samma skäl från plattformssidan och inte av företagen: de hyrs i
Kundexas leverantörskonto och faktureras Kundexa.

## Att byta leverantör

1. Skriv adaptern. För röst: `WebphoneProvider` (`key`, `isConfigured`,
   `provision`). För SMS: `SmsProvider` (`send`, `findSubmitted`) och
   `SmsWebhookAdapter` (`parseInbound`, `parseDeliveryReport`). För nummer:
   `NumberProvider` (`isConfigured`, `search`, `findActive`, `rent`).
2. Registrera den i `src/lib/telephony/webphone/index.ts` respektive i
   registren i SMS-portarna.
3. Lägg till en webhookrutt om nyttolastens form skiljer sig.
4. Peka `TELEPHONY_PROVIDER` och `SMS_PROVIDER` på den nya nyckeln.
5. Lägg adapterfilerna i undantagslistan i `scripts/verify.mjs`.

Databasen behöver inte röras. `calls.provider` och `dial_attempts.provider` är
textkolumner som bär vem som kopplade samtalet, och inget villkor i systemet
läser ett leverantörsnamn för att avgöra vad som ska hända — det var precis den
sortens villkor som tystade två skydd vid förra bytet.

## Avtalslänken

Länken kunden klickar på byggs på två ställen, och de måste peka på samma värd.

| Vad | Var | Variabel |
| --- | --- | --- |
| Första utskicket (SMS och e-post) | webbappen | `NEXT_PUBLIC_APP_URL` |
| Påminnelsen, och SMS-leveransens callback | utskicksarbetaren | `APP_URL` |

Glider de isär pekar påminnelsen på en annan värd än avtalet, och en POST som
möter en omdirigering kan tappas tyst. `/api/ready` jämför dem:
`checks.delivery.linkHostAligned`.

Arbetaren vägrar bygga en länk alls när `APP_URL` saknas. Tidigare gav en osatt
variabel strängen `undefined/accept/<token>` i ett SMS som rapporterades som
skickat. Felet saknar prefixet `permanent_`, så jobbet kommer tillbaka när
adressen är satt i stället för att dödbrevas med avtalet osänt.

### Vad som krävs för att ett avtal ska nå kunden

Fyra saker, och alla fyra prövas **innan** utskicket köas -- ett nej ska nå
säljaren som kan göra något åt det, inte dödbrevas i en jobbtabell:

- företagets funktionsflaggor för kanalen (`outbound_sms` och
  `contract_delivery_sms`, respektive motsvarigheterna för e-post),
- ett aktivt nummer som bär SMS, respektive en aktiv och testad Resend-integration
  med verifierad avsändaradress,
- kundens mobilnummer i E.164 respektive en giltig e-postadress,
- den kanoniska PDF:en, som binds till acceptansen med sin SHA-256.

SMS-nycklarna bor i Edge-funktionen, som webbappen inte kan läsa. Därför
rapporterar arbetaren själv om de finns -- närvaro, aldrig värden -- i sin
heartbeat, och `/api/ready` läser tillbaka det under `checks.delivery`.
