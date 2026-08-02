# Central Rinkel-telefoni

## Kanonisk arkitektur

Kundexa använder en central Rinkel API-nyckel och exakt en kanonisk, aktiv `platform_integrations`-rad utan `tenant_id`. Tenants ansluter inte egna Rinkel-konton. Plattformen synkroniserar Rinkel-användare, deras enheter och utgående nummer centralt och historiserar därefter allokeringarna till tenant och team.

```text
RINKEL_API_KEY i server-/Edge-miljön
→ central Rinkel-klient
→ centralt användar-, device- och nummerinventarium
→ historiserad tenantallokering och nummergrant
→ säljarens mapping och valda aktiva device
→ atomisk samtalsreservation
→ exakt ett POST /dial
→ webhook för realtid
→ beständig worker
→ CDR som slutlig avstämnings- och reparationskälla
```

API-nyckeln får aldrig ha prefixet `NEXT_PUBLIC_`, lagras i databasen eller visas i UI. 46elks används endast för befintlig SMS-trafik; voice/click-to-call går genom den centrala Rinkel-lösningen.

## Kapabiliteter och status

Anslutningsstatus skiljer på vad som faktiskt har verifierats:

- API-åtkomst.
- användarkatalog.
- nummerkatalog.
- komplett dialkonfiguration.
- nåbar dialendpoint, när den uttryckligen har verifierats.
- verkligt testsamtal, vilket endast får markeras efter ett faktiskt staginganrop.
- webhookregistrering.
- fyra verifierade kärnwebhookar.
- inspelning, transkribering, Insights och note-sync som separata kapabiliteter.

Lyckad operation rensar endast det relevanta aktuella integrationsfelet. Historiska fel bevaras i audit/jobbevidens. En återaktivering sätter status till `testing`; `RINKEL_API_KEY` ensam ger aldrig `connected`.

## Användare, devices och nummer

`platform_rinkel_users`, `platform_rinkel_devices` och `platform_rinkel_numbers` är centrala resurser. `rinkel_user_allocations` och `rinkel_number_allocations` historiserar tenantägarskap. `rinkel_number_grants` bestämmer faktisk åtkomst. `rinkel_user_mappings_v2.selected_device_id` pekar på den aktiva, synkroniserade device som säljaren ska använda.

En säljare kan inte ringa när vald device har försvunnit eller blivit inaktiv. Tenantklienter läser endast tenantfiltrerade DTO:er via RPC och ser aldrig andra tenants resurser eller rå providerpayload.

## Caller-ID-resolver

Servern väljer Rinkels interna `numberId` i denna ordning:

1. explicit nummerallokering för samtalet,
2. ringlistans standard,
3. kampanjens standard,
4. teamets standard,
5. tenantens standard,
6. plattformens reservstandard,
7. säljarens äldre standard som bakåtkompatibel sista reserv.

Varje kandidat måste vara aktiv, tillhöra rätt tenant/allokering, vara grantad till användaren och ha ett aktivt Rinkel-nummer. Ett explicit men otillåtet val ger fel; det får inte tyst falla vidare till ett annat nummer. Samtalet sparar resolverns källa och allokerings-ID för audit.

## Utgående samtal och idempotens

`POST /api/v1/calls` härleder tenant, medlemskap, policy, device och caller-ID server-side. Därefter skickas exakt ett provideranrop:

```json
{
  "deviceId": "SERVER_DERIVED_DEVICE",
  "to": "+46700000000",
  "numberId": "SERVER_DERIVED_NUMBER_ID",
  "anonymous": false
}
```

`POST /dial` retryas aldrig automatiskt. Timeout, nätverksavbrott eller ett borttappat svar efter skickat anrop behandlas som osäkert utfall: samma samtalsförsök ligger kvar i `provider_outcome_unknown`/`reconciliation_required`, klienten behåller idempotenskontexten och ett nytt samtal blockeras tills webhook eller CDR har avstämt. Ett definitivt avslag kan däremot följas av ett nytt manuellt försök med ny nyckel.

En idempotent replay returnerar den verkliga attempt-/providerstatusen. Ett tidigare `failed`, `ended` eller avslutat försök visas aldrig som att Rinkel ringer igen.

## Webhookar

Obligatoriska kärnevent:

- `incomingCall`
- `outgoingCall`
- `callStart`
- `callEnd`

Valfritt event:

- `callInsights`

Insights får vara `unsupported` utan att kärntelefonin degraderas. Webhookens statuslivscykel är `not_configured`, `registering`, `registered`, `test_pending`, `verified`, `degraded`, `failed`, `unsupported` eller `disabled`.

Registrering räcker inte för `verified`. Kundexa läser tillbaka exakt event/HTTPS-URL/aktiv status, begär providertest när det stöds och markerar eventet verifierat först när testleveransen faktiskt har mottagits och processats.

Endpointen:

```text
POST https://app.example.com/api/webhooks/rinkel/{secret}/{event}
```

validerar metod, event, route-secret, content type, body-storlek, JSON/form-data, schema och konfigurerbar IP-allowlist. Den lagrar eventet idempotent innan tung bearbetning, svarar snabbt och låter aldrig payloaden bestämma tenant. Tenant härleds från central nummerallokering, användarmapping, pending attempt eller befintligt provider-call-ID. Tvetydighet blir konflikt och får aldrig gissas.

## Worker, retry och dead letter

`rinkel-platform-worker` körs varje minut via Vercel Cron och anropar Supabase Edge Function server-to-server med `CRON_SECRET`. Jobb claimas atomiskt med `FOR UPDATE SKIP LOCKED`. En fem minuter gammal lease återställs; kontrollerad backoff, maxförsök och dead letter hanteras i databasen. Behörig plattformsadmin kan köra worker, köa CDR-avstämning, återköa failed/dead-letter-jobb och manuellt återbehandla okopplade eller tvetydiga webhookevent. Heartbeat visar senaste start/lyckade körning, hämtade, behandlade, misslyckade och återköade jobb.

Auto-dialer kräver verifierat API, komplett dialkonfiguration, fyra verifierade kärnwebhookar, frisk worker, aktiverad tenantpolicy, mapping, aktiv device och nummeråtkomst. `last_received_at` är endast en övervakningssignal; en ny installation blockeras inte för att den saknar 24 timmars historisk trafik.

## Eventordning och korrelation

Systemet tolererar dubbletter, sena event och `callStart`/`callEnd` före `outgoingCall`. Terminala providerstatusar får inte backas till äldre status. Utgående korrelation använder provider-user, device, destination, caller-ID, pending attempt och ett kort tidsfönster. Flera kandidater blir `conflict`; inga kandidater blir `pending_correlation` och retryas senare.

Providerstatus, provider outcome och CRM-disposition är separata fält. Okända cause-värden bevaras rått och projiceras till `unknown`; de får inte krascha workern eller skriva över säljarens disposition.

## CDR-avstämning

Webhook ger realtid; CDR är reparationskälla. Klienten hanterar cursor- eller sidpagination med säker batchgräns och upptäcker upprepad cursor. Reconciliation reparerar provider-call-ID, tider, duration, cause/outcome, status och inspelningsreferens. Vid flera CDR-kandidater skapas en manuell konflikt.

Varje plattformskörning tar både de äldsta och de nyaste ofullständiga samtalen. Därmed svälter inte äldre poster bakom ny trafik, samtidigt som nya osäkra dialförsök repareras snabbt.

## Inspelning, transkribering och Insights

Frontend anropar aldrig Rinkel direkt. Uppspelning verifierar tenant, roll, samtalsåtkomst, retention och legal hold innan en kortlivad providerstream används, och åtkomsten auditloggas.

Privat Kundexa-kopia exponeras inte i tenant-UI förrän den provideroberoende nedladdnings-, hash-, privat Storage-, retention- och legal-hold-kedjan är verifierad för Rinkel. Policyn tvingas därför till `provider_only`; det finns ingen kosmetisk inställning som lovar en saknad backend.

Transkribering använder jobtypen `rinkel.transcription.fetch`. HTTP 204 behandlas som `pending_provider`, retryas med längre intervall och blir först efter maximalt väntfönster `not_available`. Insights kommer via det valfria eventet och bearbetas separat som `rinkel.insights.process`. AI-resultat lagras separat från säljarens CRM-anteckning och markeras som overifierad AI-output. Note-sync visas inte förrän providerstödet har verifierats.

## Retention och legal hold

Tenantretention omfattar Rinkel-inspelningar, transkript, Insights, råa webhookpayloads och jobbpayload/fel. Aktiv legal hold skyddar berörda samtal. Providerinspelning raderas endast när tenantpolicyn uttryckligen tillåter det. Tenantlösa plattformsevent och plattformsjobb rensas separat av `rinkel.retention_platform` efter ett konservativt 30-dagarsfönster. Öppna korrelationskonflikter skyddas tills de är lösta eller manuellt ignorerade och ska inte blandas med tenantdata.

## Miljövariabler

```env
RINKEL_API_KEY=
RINKEL_API_BASE_URL=https://api.rinkel.com/v1
RINKEL_WEBHOOK_PUBLIC_BASE_URL=https://app.example.com
RINKEL_WEBHOOK_SECRET=
RINKEL_WEBHOOK_ALLOWED_IPS=82.199.77.220,188.122.73.177
RINKEL_REQUEST_TIMEOUT_MS=15000
RINKEL_ENFORCE_WEBHOOK_IP_ALLOWLIST=true
RINKEL_TRUST_X_REAL_IP=false
RINKEL_RECONCILIATION_ENABLED=true
CRON_SECRET=
```

I staging/production måste webhookbasen vara publik HTTPS och får inte vara localhost, loopback eller privat IP. Samma API-nyckel och `CRON_SECRET` ska finnas i de servermiljöer som gör provider-/workeranrop, men aldrig i klientbundle.

## Migration och verifiering

Den framåtriktade produktionskompletteringen är:

```text
supabase/migrations/202608020003_rinkel_production_completion.sql
```

Efter migration:

```bash
npm run db:push
SUPABASE_PROJECT_REF=PROJECT_REF npm run types:generate
npm run types:verify
npm run typecheck:edge
npm run test
npm run build
npm run verify
```

Genererade Supabase-typer får inte handredigeras. `types:verify` förblir rött tills den länkade stagingdatabasen har alla väntande migrationer och typerna har genererats därifrån.

## Liveverifiering

Markera aldrig verklig Rinkel-funktion som verifierad utifrån mockar. Följ `docs/RINKEL_STAGING_PROTOCOL.md` för API, katalog, devices, webhooktest, worker heartbeat, riktigt utgående samtal, caller-ID, eventkedja, CDR, inspelning, transkribering, Insights och tvåtenanttest.
