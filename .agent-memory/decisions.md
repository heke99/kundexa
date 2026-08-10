# Decisions

## ADR-0001 — Ett kanoniskt CRM

`customers` är kund-/prospektkortet. Listmedlemskap, samtal, återkomster, anteckningar och order hålls i separata kanoniska tabeller; inga parallella kundkopior.

## ADR-0002 — Plattformens lista är supply/revisionsspår

`platform_lists` och allokeringar levererar data till tenantens operativa `customer_lists`. Allokeringsposten bevarar tenant och lineage även om operativ referens senare kopplas loss.

## ADR-0003 — RLS plus atomiska RPC:er

RLS är grundskydd. Flertabellsmutationer och concurrencykritiska flöden genomförs i serverkontrollerade, atomiska RPC:er.

## ADR-0004 — Kataloglicens är fältspecifik

Lagring, filtrering och visning är separata rättigheter. Ett filtrerbart fält behöver inte vara synligt.

## ADR-0005 — Tenantparametrerade definer-RPC:er är service-only

Autentiserade användarflöden härleder aktiv tenant. Serviceflöden använder `*_for_tenant` och validerar tenant mot varje resurs.

## ADR-0006 — Providerarbete går via adapters/outbox

Rinkel, 46elks SMS, Resend, ParseHub och NIX isoleras bakom adapters/workers. Domänmutation och köläggning sker atomiskt och idempotent.

## ADR-0007 — Node 22 är kanonisk runtime

`package.json` styr Node 22.x och npm 10.9.2. Verifiering under annan Node-version är informativ men ersätter inte CI/staging på Node 22.

## ADR-0008 — Rinkel är enda voice-provider

Kundexa äger CRM-, list-, policy- och samtalsmodellen; Rinkel äger telefonin. `/dial` anropas exakt en gång efter atomisk lokal reservation och får inte återförsökas efter ett oklart nätverksutfall. Webhookar och avstämning är sanningskälla för providerstatus. Äldre 46elks/WebRTC-voiceflöden är permanent avstängda.

## ADR-0009 — Providerartefakter ärver samtalsåtkomst

Samtalsförsök, transkript och Insights får endast läsas av användare som kan läsa det kanoniska samtalet. Rå providerdata exponeras inte för autentiserade klienter; konfigurations- och konfliktdata kräver administrativ roll.

## ADR-0010 — Telefonistatus härleds server-side

Dialerns statusendpoint autentiserar användaren med `getAppContext` och använder `get_rinkel_telephony_status`, som kombinerar central plattformsstatus med den aktiva tenantens policy, allokeringar, grants och aktuell säljar­mappning. Inga credentials, centrala katalogposter eller andra tenants data returneras.

## ADR-0011 — Rinkel är en central plattformsintegration

Rinkel har exakt en logisk `RINKEL_API_KEY` i servermiljön och en aktiv `platform_integrations`-rad utan `tenant_id`. Centrala användare och nummer allokeras historiserat till tenants och filtreras genom serververifierade RPC:er. Tenantcredentials, connection-ID-baserade webhookar och fallback till den gamla modellen är permanent avvecklade.

## 2026-08-07 — Idempotensnyckeln för import sätts i RPC:n, inte hos anroparen

Alternativen var att låta varje anropare förboka `execution_idempotency_key` innan
`process_import_run`, eller att låta RPC:n själv garantera invarianten. Vi valde RPC:n:
triggern från `202608010001` är en databasinvariant, och en invariant som kräver att varje
anropare minns ett förberedande steg är inte en invariant. ParseHub-vägen visade precis den
felmoden. Serveraktionens förbokning behålls eftersom den ger ett vänligt
"redan verkställd"-meddelande i stället för ett rått unique-violation.

Funktionskroppen patchas textuellt från `pg_get_functiondef` i stället för att skrivas om,
av samma skäl som `202608010001` gjorde det: annars tappas tidigare levererade ändringar i
samma funktion.

## 2026-08-07 — Driftkontroll mot faktiskt schema ersätter inte namnlistan, den kompletterar den

`types:verify` kontrollerar att en handunderhållen lista av namn finns. Den fångar inte en
tabell eller kolumn som lagts till och aldrig regenererats. Eftersom `verify-sql.mjs` redan
har hela det migrerade schemat i minnet är jämförelsen mot `database.types.ts` nästan gratis
där. Båda behålls: namnlistan uttrycker avsikt ("dessa kontrakt måste finnas"), driftkontrollen
uttrycker fakta ("typerna motsvarar schemat").

## 2026-08-07 — Cache-policy sätts i proxyn, inte per route

Autentiserade ytor svarade utan `Cache-Control` överhuvudtaget. Att sätta headern i varje
route hade krävt ändring i ~60 filer och hade gått sönder vid nästa nya route. Proxyn ser
alla requests, så policyn sätts där för `/app`, `/api` och `/onboarding`, med uttryckliga
undantag för `/api/openapi.json` och `/api/public` som har egen medveten policy.

## ADR-0012 — Runtime readiness måste innehålla faktisk secret-availability

Databasen får beskriva katalog/allokering/capabilities men kan inte bevisa att den serverprocess som ska ringa
har providernyckeln. Därför kombineras DB-status med server-side `RINKEL_API_KEY`-availability före dial och i
status-API:t. Secretvärdet exponeras aldrig.

## ADR-0013 — Konsistensfixar får inte skapa onödig public schema-drift

Där en befintlig publik RPC-signatur räcker ersätts dess kropp forward-only. Nya transaktionshooks för product
initial price och compliance projection ligger i `private` schema. Det håller den publika API/typeytan stabil
samtidigt som flertabellsinvarianter flyttas till databastransktionen.

## ADR-0014 — Extension-owned lint is separated from application-owned lint

Kundexa does not rewrite functions owned by PostGIS solely to satisfy `plpgsql_check`. Application-owned
functions must lint clean; extension-owned diagnostics are tracked separately. For pgcrypto portability,
affected SECURITY DEFINER functions keep an explicit fixed search path of `public, extensions` so both
local replay and hosted Supabase resolve the extension functions.

## ADR-0015 — Platform identity is independent from tenant workspace identity

`platform_memberships` is the sole authorization source for Kundexa control-plane access. `getPlatformContext()` must not call `getAppContext()`, inspect `active_tenant_id`, or require tenant lifecycle/membership. Tenant authorization remains exclusively in `getAppContext()`.

The shared `/app` layout distinguishes `/app/platform/*` before resolving context. The proxy overwrites the internal route hint so clients cannot spoof the context mode. Platform pages use a platform-only shell and do not subscribe to tenant realtime or tenant counters.

A user may possess both identities. Entering the control-plane does not grant tenant data; switching into a tenant still goes through the canonical `switch_active_tenant` RPC, which validates active membership.

## ADR-0016 — Incomplete Rinkel user payloads may not delete device inventory

Rinkel exposes both a user catalog endpoint and a user detail endpoint. Kundexa therefore does not assume that
`GET /users` is an authoritative device inventory. Directory sync attempts `GET /users/:id` for each user and
only deactivates stored device rows when the provider response is explicitly authoritative for devices. Missing
or incomplete device information is preserved as a diagnostic state, never converted into a guessed provider id.
Platform allocation fails closed when no synchronized active device exists.
