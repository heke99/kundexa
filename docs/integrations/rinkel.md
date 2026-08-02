# Central Rinkel-telefoni

## Kanonisk arkitektur

Kundexa använder en central Rinkel API-nyckel och en aktiv `platform_integrations`-rad utan `tenant_id`. Tenants ansluter inte egna Rinkel-konton. Plattformssuperadmin synkroniserar användare, enheter och nummer centralt och allokerar dem till tenants. Tenantadmin mappar endast redan allokerade resurser till egna team och säljare.

```text
RINKEL_API_KEY i servermiljön
→ central Rinkel-klient
→ centralt providerinventarium
→ historiserad tenantallokering
→ tenantgrant och säljar­mappning
→ kanoniskt Kundexa-samtal
```

Det finns ingen exekverbar fallback till tenantcredentials, 46elks voice, SIP eller WebRTC.

## Datamodell och åtkomst

`platform_rinkel_users` och `platform_rinkel_numbers` saknar tenant-ID och är endast service-role-/plattformsadminläsbara. `rinkel_user_allocations` och `rinkel_number_allocations` historiserar tenantägarskapet. `rinkel_number_grants` ger tenant-, team- eller användaråtkomst. `rinkel_user_mappings_v2` kopplar en aktiv tenantmedlem till en allokerad Rinkel-användare, ett serverhärlett `deviceId` och ett tillåtet standardnummer.

Tenantklienter läser säkra DTO:er via tenantfiltrerade RPC:er. Rå providerdata, centrala IDs, andra tenants resurser, API-nyckeln och webhooksecret returneras aldrig.

## Utgående samtal

`POST /api/v1/calls` accepterar endast affärsunderlag som kund, listpost, destination och idempotens. Servern härleder tenant, medlemskap, policy, mapping, device, nummerallokering och grant i den atomiska RPC:n `rinkel_reserve_platform_outbound_call`.

Efter reservation gör servern exakt ett `POST /dial` med:

```json
{
  "deviceId": "SERVER_DERIVED_DEVICE",
  "to": "+46700000000",
  "numberId": "SERVER_DERIVED_NUMBER",
  "anonymous": false
}
```

HTTP 204 betyder accepterad start. Dial-anrop retryas aldrig automatiskt. Timeout eller nätverksavbrott blir `provider_outcome_unknown`, köar reconciliation och blockerar omedelbar automatisk omringning.

Manuell dialer kräver frisk central dial capability, aktiv tenantpolicy, mapping, device och nummergrant. Automatisk dialer kräver dessutom färska centrala webhookar och fungerande reconciliation. Kontrollen sker även databasside.

## Central webhook

Alla fem event använder:

```text
POST https://app.example.com/api/webhooks/rinkel/{secret}/{event}
```

Event:

- `incomingCall`
- `outgoingCall`
- `callStart`
- `callEnd`
- `callInsights`

Endpointen validerar event, JSON/form-urlencoded, storlek, konstanttidsjämförd routehemlighet och dokumenterad proxy/IP-kedja när allowlist är aktiv. Den lagrar payload och säkra headers idempotent, köar workerjobb atomiskt och svarar 200 utan tung bearbetning.

Inkommande samtal routas från `to`-nummer till central nummerpost och den allokering som gällde vid händelsetiden. Saknad eller tvetydig allokering skapar en central konflikt och får aldrig gissas till en tenant. Utgående events korreleras med device, provideranvändare, nummerpar och ett begränsat attemptfönster; flera kandidater blir också konflikt.

## Inspelning, transkript och Insights

Providerreferenser sparas server-side. Klienten får aldrig en permanent provider-URL. Uppspelning verifierar kanonisk samtalsåtkomst och tenantens policy och skriver accesslogg. `provider_only` använder en kortlivad stream; `kundexa_private_copy` använder privat Supabase Storage med tenantprefix, checksumma, storlek och MIME-typ.

Transkript och Insights aktiveras endast när både central capability och tenantpolicy tillåter det. Status skiljer mellan `disabled`, `pending`, `processing`, `available`, `not_available`, `failed` och `deleted`. Tenant- och samtalsbehörighet gäller även dessa data.

## Drift

Servervariabler:

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

Samma logiska API-nyckel ska finnas i Vercel och Supabase Edge Secrets när båda gör direkta provideranrop. Den får aldrig ha prefixet `NEXT_PUBLIC_`, lagras i databasen eller visas i plattforms-/tenant-UI.

`rinkel-platform-worker` behandlar centrala event och reconciliation. `maintenance-worker` schemalägger central reconciliation och tenantretention. Jobb är idempotenta, låsta, retrybara per säker jobtyp och kan dead-letteras. Legacy tenant-Rinkel-jobb dead-letteras utan provideranrop.

## Administration

Plattformssuperadmin använder `/app/platform/telephony` för anslutningstest, katalogsynk, central webhookkonfiguration, allokering/flytt/återkallning, konflikter och nödstopp. API-nyckelns värde kan aldrig matas in eller visas där.

Tenant owner/admin använder `/app/integrations` för att se egna allokeringar, skapa säljar­mappning, standardnummer och policy. Säljarstatus kommer från `GET /api/v1/telephony/status` och skiljer plattformsfel från saknad tenantallokering, mapping, device eller nummeråtkomst.

## Liveverifiering

Kör i separat staging: central anslutning, verklig katalogsynk, riktig device och dial, alla fem event, obesvarat samtal, webhookretry/inaktivering, reconciliation, inspelning, transkript och Insights. Dessa punkter är `NOT RUN` tills riktiga credentials och samtal används.

## Betrodd proxy och webhookskydd

I Vercel läses käll-IP endast från `x-vercel-forwarded-for`. Utanför Vercel ignoreras `x-real-ip` om inte infrastrukturen uttryckligen är en betrodd reverse proxy och `RINKEL_TRUST_X_REAL_IP=true` har satts. Standardvärdet är `false` för att en direkt klient inte ska kunna injicera ett tillåtet IP-värde.

Rinkels publicerade webhookguide dokumenterar HTTPS och käll-IP-allowlist men ingen payloadsignatur. Endpointen använder därför ett roterbart, högentropiskt path-secret, IP-allowlist, payloadhash, unik provider-eventnyckel och idempotent eventlagring. Om Rinkel senare publicerar HMAC/signatur ska rå body verifieras innan parsing och lagring.

## Livscykel och CDR-härdning 2026-08-02

Rinkels tekniska livscykel lagras separat från säljarens CRM-disposition:

- `provider_status`: `requesting`, `requested`, `initiated`, `connected`, `ended`, `failed` eller `unknown`.
- `provider_outcome`: `answered`, `no_answer`, `blocked`, `voicemail`, `answering_service`, `outside_business_hours`, `provider_error` eller `unknown`.
- `disposition`: Kundexas affärsmässiga efterarbete och får inte skrivas över av providern.

Okända, välformaterade Rinkel-orsaker accepteras, bevaras rått i `provider_cause` och projiceras defensivt till `provider_outcome=unknown`. Därmed blockerar ett nytt provider-värde inte webhookmottagningen.

`callEnd` skapar eller uppdaterar den enda aktiva Rinkel-inspelningsreferensen för samtalet och köar både CDR-avstämning och tillåten enrichment. CDR-arbetaren hämtar den specifika posten när call-ID är känt. När call-ID saknas söker den i ett begränsat tidsfönster och kräver en entydig match på nummer, användare och tid; flera kandidater blir en konflikt och får aldrig väljas godtyckligt. Den atomiska RPC:n `reconcile_rinkel_call_from_cdr` reparerar status, tider, duration, rå cause, provider outcome, call-ID, attempt och inspelningsreferens.

För inkommande samtal löses tenant endast från den aktiva centrala nummerallokeringen. Kund-/kontaktmatchning görs därefter endast inom denna tenant. Automatisk koppling sker bara när exakt en kund och, i förekommande fall, exakt en kontakt är entydig; dubletter lämnas omatchade för manuell hantering.

Den framåtriktade migrationen är:

```text
supabase/migrations/202608020001_rinkel_lifecycle_reconciliation_hardening.sql
```

Efter migrationen måste Supabase-typerna genereras om. `npm run types:verify` ska avsiktligt vara rött tills stagingdatabasen innehåller `calls.provider_outcome` och `reconcile_rinkel_call_from_cdr`.
