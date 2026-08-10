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
4. kundens tilldelade teams standard,
5. säljarens mapping-standard,
6. säljarens teamstandard,
7. tenantens standard,
8. plattformens reservstandard,
9. därefter endast en explicit tillgänglig grant-fallback om ingen standard gav en giltig kandidat.

Varje kandidat måste vara aktiv, tillhöra rätt tenant/allokering och ha en aktiv `dial`/`manage`-grant som omfattar säljaren. Ett explicit men otillåtet val ger fel och får inte tyst falla vidare. Samtalet sparar resolverns källa och allokerings-ID för audit.

Ett aktivt Rinkel-nummer får bara ha **en aktiv tenantägare**. Det kan delas av flera team inom samma tenant. Detta är nödvändigt eftersom `incomingCall` identifierar mottagaren med det ringda numret; flera aktiva tenantallokeringar skulle göra inbound tenant-korrelation tvetydig.

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

Valfritt event: `callInsights`. Insights får vara `unsupported` utan att kärntelefonin degraderas.

Webhookregistrering och webhookverifiering är två olika bevis:

1. **Registrerad**: Kundexa skapar/uppdaterar webhooken hos Rinkel och läser tillbaka exakt event, publik HTTPS-URL, `application/json` och `active=true`.
2. **Verified**: ett verkligt provider-event har mottagits av Kundexas publika endpoint och därefter processats framgångsrikt av `rinkel-platform-worker`.

Ett syntetiskt `/webhooks/:event/test` är inte en production-readiness-gate. Den publika Rinkel-referensen dokumenterar testendpointen men den ska inte vara nödvändig för att bevisa den verkliga samtalskedjan. Live readiness byggs därför på riktiga provider-event.

Endpointen:

```text
POST https://app.example.com/api/webhooks/rinkel/{secret}/{event}
```

validerar route-secret, event, content type, maxstorlek, payloadschema och provider-IP. Därefter gör den **en atomisk service-role RPC** som lagrar det idempotenta råeventet, köar workerjobbet, uppdaterar receipt-health och audit innan endpointen svarar HTTP 200. Tung korrelation/CDR/recordingbearbetning sker asynkront.

Tenant härleds aldrig från godtycklig payloaddata. Inbound tenant kommer från numrets enda aktiva tenantallokering. Outbound tenant kommer från en server-reserverad pending attempt. Tvetydighet blir `platform_rinkel_conflicts` och får aldrig gissas.

4/4 readiness uppnås genom ett besvarat verkligt utgående testsamtal (`outgoingCall`, `callStart`, `callEnd`) plus ett verkligt inkommande test (`incomingCall`). Auto-dialer förblir stängd tills alla fyra event har processats och workern är frisk.

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

De relevanta framåtriktade produktionsmigrationerna är:

```text
supabase/migrations/202608020003_rinkel_production_completion.sql
supabase/migrations/202608100001_rinkel_webhook_live_verification_and_ingest.sql
supabase/migrations/202608100002_rinkel_device_inventory_mapping_hardening.sql
supabase/migrations/202608100003_rinkel_webhook_live_verification_repair.sql
supabase/migrations/202608100006_rinkel_runtime_authorization_and_failure_recovery.sql
supabase/migrations/202608100008_security_resource_projection_and_rls.sql
```

`202608100001` stänger livekedjan genom atomisk webhook-ingest, verklig-event-baserad 4/4-verifiering, korrigerad provider-tidslinje efter `/dial` och skydd mot cross-tenant nummerägarskap. `202608100002` gör device inventory/mapping explicit och `202608100003` reparerar live-verifieringskedjan. `202608100006` gör exact-target policy, server-derived purpose, objektåtkomst, pausad teamåtkomst, caller-ID och definitiv provider-rejection till en del av den kanoniska reservation/finalisering-kedjan. `202608100008` begränsar Rinkel-resursprojektioner och känslig RLS efter roll och aktuellt team-scope.

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

Markera aldrig verklig Rinkel-funktion som verifierad utifrån mockar. Följ `docs/RINKEL_STAGING_PROTOCOL.md` exakt: central API/katalog → webhook read-back → tenant/team/user/device/nummermapping → besvarat verkligt outbound-test → verkligt inbound-test → 4/4 → CDR/recording/recovery/tvåtenanttest → först därefter auto-dial.
