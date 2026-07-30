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
RINKEL_REQUEST_TIMEOUT_MS=15000
RINKEL_ENFORCE_WEBHOOK_IP_ALLOWLIST=true
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
