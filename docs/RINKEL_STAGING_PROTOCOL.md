# Rinkel stagingprotokoll

Detta protokoll är den enda live-acceptansvägen för Kundexas centrala Rinkel-telefoni. Markera inte en kontroll som verifierad från mockar. Spara datum, utförare, intern `call_id`/`attempt_id`, provider-call-ID och maskerad evidens.

Tillåtna statusar: `VERIFIED_MOCK`, `VERIFIED_LOCAL_DB`, `VERIFIED_SUPABASE_STAGING`, `VERIFIED_REAL_RINKEL`, `NOT_RUN`.

## Gate A – central anslutning och katalog

| Kontroll | Krav | Status |
|---|---|---|
| Central integrationsrad | Exakt en aktiv kanonisk Rinkel-rad | NOT_RUN |
| API-nyckel | `GET /users` och `GET /numbers` lyckas | NOT_RUN |
| Devicekatalog | Aktiva/inaktiva devices synkas utan dubbletter | NOT_RUN |
| Nummerkatalog | Provider `numberId` och E.164 sparas separat | NOT_RUN |
| Nummerägarskap | Ett aktivt nummer tillhör högst en tenant; flera team inom samma tenant är tillåtna | NOT_RUN |

I `/app/platform/telephony` körs i ordning:

1. **Testa API och katalog**.
2. **Synkronisera katalog**.
3. **Registrera och synka webhookar**.

Webhookregistrering verifieras genom att Kundexa läser tillbaka samma event, publika HTTPS-URL, `application/json` och `active=true` från Rinkel. Ett syntetiskt provider-test är inte en production-readiness-gate.

## Gate B – tilldelning och seller readiness

1. Tilldela en aktiv Rinkel-användare till testbolaget.
2. Tilldela ett aktivt nummer till ett eller flera team **inom samma bolag**.
3. Öppna tenantens `/app/integrations`.
4. Mappa Kundexa-säljaren till:
   - aktiv Rinkel user-allokering,
   - en konkret aktiv Rinkel-device,
   - ett aktivt tilldelat nummer.
5. Slå på `Telefoni aktiv` och `Manuell dialer aktiv`.
6. Låt `Automatisk dialer` vara av tills Gate D är grön.
7. Sätt caller-ID-standard om ingen list-/campaign-/teamstandard ska styra testet.

| Kontroll | Krav | Status |
|---|---|---|
| User allocation | Rinkel-user är aktiv och tilldelad rätt tenant | NOT_RUN |
| Device mapping | Säljaren har exakt vald aktiv device | NOT_RUN |
| Nummergrant | Team/säljare har `dial`/`manage` till rätt allocation | NOT_RUN |
| Caller-ID | Resolvern väljer rätt provider `numberId` och E.164 | NOT_RUN |
| Telefonipolicy | Manuell telefoni aktiv och aktuellt klockslag tillåtet | NOT_RUN |

## Gate C – verkligt utgående samtal

Ring ett kontrollerat testnummer från Kundexa och **besvara samtalet**. Ett obesvarat test verifierar inte `callStart`.

Förväntad kedja:

```text
Kundexa reserve
→ exakt ett POST /dial
→ HTTP 204 accepted
→ outgoingCall
→ callStart
→ callEnd
→ worker
→ CDR reconciliation
```

Krav:

- `POST /dial` skickas exakt en gång.
- `deviceId` och `numberId` kommer från serverns mapping/resolver.
- HTTP 204 skapar inte en påhittad provider-tid; `outgoingCall.datetime` äger initieringstiden.
- Samma Rinkel call-ID korreleras till samma `calls.id`.
- `outgoingCall`, `callStart` och `callEnd` blir `verified` först efter lyckad workerbearbetning.
- `callEnd` ger korrekt provider outcome/status och eventuell recording-referens.
- CDR kan reparera call-ID/tider/duration/cause/recording utan att backa en nyare terminal state.

| Kontroll | Krav | Status |
|---|---|---|
| Manuell dial | Rätt device börjar ringa | NOT_RUN |
| Destination | Rätt testnummer rings exakt en gång | NOT_RUN |
| outgoingCall | Mottaget, korrelerat och processat | NOT_RUN |
| callStart | Mottaget, korrelerat och processat | NOT_RUN |
| callEnd | Mottaget, korrelerat och processat | NOT_RUN |
| CDR | Provider-ID, tider, duration och cause stämmer | NOT_RUN |
| Inspelning | Om provider stöder det: recording hittas och accesskontroll fungerar | NOT_RUN |

Efter detta ska kärnwebhookstatus normalt vara **3/4**.

## Gate D – verkligt inkommande samtal och 4/4

Ring det tilldelade Rinkel-numret från en extern telefon.

Förväntat:

```text
incomingCall
→ tenant härleds från numrets enda aktiva tenant-allokering
→ callStart/callEnd vid normal hantering
→ worker
```

`incomingCall` måste processas utan tenantkonflikt. När den är processad ska kärnstatus bli **4/4 VERIFIED**. Först då får auto-dial readiness vara grön.

| Kontroll | Krav | Status |
|---|---|---|
| incomingCall | Mottaget, tenant-korrelerat och processat | NOT_RUN |
| Kärnwebhookar | `incomingCall/outgoingCall/callStart/callEnd` = 4/4 verified | NOT_RUN |
| Worker | Heartbeat yngre än tre minuter | NOT_RUN |
| Konflikter | Inga öppna korrelations-/nummerägarkonflikter | NOT_RUN |
| Failed/dead-letter | Inga oförklarade workerfel | NOT_RUN |
| Auto-dialer | Kan aktiveras först när ovanstående readiness är grön | NOT_RUN |

## Recovery- och säkerhetstester

| Kontroll | Krav | Status |
|---|---|---|
| Timeout/nätfel efter dial | Ingen blind POST-retry; attempt blir osäkert och CDR/webhook reparerar | NOT_RUN |
| Sent provider-event | `provider_outcome_unknown/reconciliation_required` får återgå till verklig ringing/answered state | NOT_RUN |
| Dubblett webhook | Idempotent; samma provider-event skapar inte dubbla calls/jobs | NOT_RUN |
| Fel eventordning | `callStart/callEnd` före `outgoingCall` retryas och korreleras senare | NOT_RUN |
| CDR-konflikt | Flera kandidater blir öppen konflikt, aldrig godtycklig tenantmatch | NOT_RUN |
| Cross-tenant nummer | Ny aktiv allocation till annat bolag nekas | NOT_RUN |
| RLS/två tenants | Tenant A kan inte läsa/ändra tenant B | NOT_RUN |
| Retention/legal hold | Policy rensar korrekt; legal hold skyddar | NOT_RUN |

## Evidens att spara

Spara minst:

- intern `call_id` och `attempt_id`,
- correlation/request ID från Kundexa,
- Rinkel provider-call-ID,
- vald provider user/device/number,
- tider för `outgoingCall`, `callStart`, `callEnd`,
- webhookstatus/counters före och efter testet,
- CDR-evidens,
- worker heartbeat/jobbutfall,
- resultat för tenant A och tenant B.

Klistra aldrig in API-nycklar, webhook-secret, fullständiga authheaders eller temporära recording-URL:er.
