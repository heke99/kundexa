# Kundexa – implementering av avtal från samtal, PDF, Resend, acceptans och påminnelser

**Leveransdatum:** 2026-07-27  
**Projekt:** Kundexa  
**Leveranstyp:** Full källkodsleverans ovanpå befintligt repo, inte ett parallellt avtalssystem.

## 1. Sammanfattning

Den befintliga `contracts`-domänen har byggts ut till ett sammanhängande multi-tenant-flöde från genomfört samtal till utkast, fryst snapshot, kanonisk privat PDF, e-post/SMS-outbox, personlig acceptlänk, automatiska och manuella påminnelser, Resend-webhooks, dokumenterad acceptans, evidence-paket och slutlig bekräftelse.

Den centrala affärsregeln är nu gemensam i serverkod och databas: **ett avtal får sparas som utkast utan samtal, men får inte skickas utan ett giltigt tidigare `source_call_id` som tillhör samma tenant och kund och har en avtalsgrundande disposition.** Externa samtal registreras i den befintliga `calls`-domänen med audit i stället för att kringgå regeln.

Implementationen återanvänder befintliga kontraktsversioner, dokumenttabeller, privata Storage-buckets, outbox, tenantintegrationer, kryptering, acceptbegäranden, audit logs, evidence och dialer/after-call work.

## 2. Verifierat nuläge före ändringarna

Före leveransen fanns redan:

- `create_contract_draft_v2` och `prepare_contract_delivery`.
- avtalsversioner, mottagare, leveranser, acceptbegäranden och acceptanser.
- privata kontraktsdokument och hashfält.
- en publik `/accept/[token]`-sida.
- e-post/SMS-outbox och en Resend-koppling i `process-outbox`.
- tenantintegrationer, feature flags, permissions och auditinfrastruktur.
- dialer, calls och after-call work.

Verifierade luckor i ursprungskoden:

- `prepare_contract_delivery` krävde inte ett verifierat `source_call_id`.
- acceptsidan visade snapshottext och hash men var inte bunden till en exakt kanonisk PDF med säker nedladdning.
- Resend-workern skickade `email_messages.attachments` direkt i providerpayloaden utan serverupplösning, tenantkontroll och byte-hashkontroll.
- delivery-modellen saknade full kanaluppdelning, reminder-policy och reminder-livscykel.
- det fanns ingen komplett manuell avtalsguide och ingen granskningsbar registrering av externa tidigare samtal.
- Resend sparades inte som ett komplett pending → test → active-flöde med tenantunik signerad webhook.

## 3. Databasändringar

Fyra nya framåtriktade migrationer har lagts till. Inga gamla migrationer ändrades.

### `202607270000_delivery_status_expansion.sql`

- Utökar leverans- och providerstatusar för verklig e-postlivscykel.
- Förbereder stöd för `sent`, `delivered`, `opened`, `clicked`, `delayed`, `bounced`, `complained`, `suppressed`, `failed` och `dead_letter`.

### `202607270001_contract_delivery_call_resend_reminders.sql`

- Lägger till `contract_eligible` på dispositionsmodellen.
- Lägger till source-call-, timing- och blockeringsfält på avtal.
- Lägger till snapshot-hash, kanoniskt dokument-ID och PDF-hashbindningar.
- Lägger till krypterad accepttoken bredvid tokenhash.
- Gör e-post och SMS till separata delivery-rader.
- Skapar `contract_reminder_policies` och `contract_reminders` med RLS och tenantbundna foreign keys.
- Skapar call-eligibility-, extern-call-, sendability-, delivery-, reminder-, cancellation-, dead-letter- och acceptance-RPC:er.
- Låser skickade avtalsversioner och kanoniska dokument mot retroaktiv ändring.
- Skapar stabila unika idempotensindex för initiala utskick, reminders och bekräftelser.
- Sätter 20 MB-gräns för kontraktsdokument.

### `202607270002_contract_api_execution_context.sql`

- Binder API-körningar till tenant och API-nyckelns faktiska skapande användare.
- Lägger till idempotenta service-RPC:er för create, send, reminder och expiry.
- Säkerställer audit och transaktionskontext för API-flöden.
- Flyttar sista automatiska påminnelsen när svarstiden förlängs.

### `202607270003_contract_draft_commercial_assignment.sql`

- Lägger till `create_contract_draft_v3` utan att bryta v2-signaturen.
- Binder ansvarig säljare, team, datum, bindningstid, uppsägningstid, betalningsvillkor, värde, valuta, särskilda villkor och föreslagen giltighet atomiskt till utkast/snapshot.
- Validerar tenantmedlemskap, team och rolltilldelning.

## 4. Backend och affärsregler

- Gemensam serverfunktion för call eligibility i `src/lib/contracts/call-eligibility.ts`.
- Gemensamma SQL-funktioner för samma regel; UI eller API kan inte kringgå spärren.
- `sendContract` skapar eller återanvänder exakt kanonisk PDF innan den atomiska delivery-RPC:n körs.
- PDF genereras med `pdf-lib` från samma frysta snapshot som avtalsversionen.
- Snapshot- och PDF-bytes får separata SHA-256-värden.
- Uppladdade PDF:er valideras som PDF, storlek, tenant, avtal, version och hash.
- Publik och autentiserad dokumentnedladdning verifierar faktiska bytes mot lagrad SHA-256 innan svar.
- Externa samtal registreras som riktiga `calls` med `source=external_manual`, full tidsdata, disposition, bekräftelse och audit.
- Accept bindas till avtal, version, dokument, PDF-hash, mottagare, begäran, source call, namn, IP, user-agent, metod och exakt accepttext.
- Accepterad kopia och evidence-manifest skapas privat och oföränderligt; confirmation läggs i outbox.

## 5. UI och after-call work

### Avtalsguide

Ny sida: `/app/contracts/new`.

Guiden stödjer:

- val eller skapande av privat-/företagskund.
- normalisering och synlig dubblettkontroll.
- befintliga giltiga samtal.
- registrering av tidigare externt samtal med audit.
- juridiskt bolag, godkänd mall, produkt och aktiv prisversion.
- datum, bindning, uppsägning, betalningsvillkor, värde, valuta, särskilda villkor, språk, ansvarig och team.
- spara utkast utan samtal, men blockerar utskick tills ett giltigt samtal är länkat.
- granskning av mottagare, kanal, PDF och svarstid före låsning/utskick.

### After-call

- Listdialern, WebRTC-dialern och samtalssidan visar **Skapa avtal** efter avtalsgrundande disposition.
- Kund och `source_call_id` följer med till guiden.
- Submit-knappens faktiska värde läses direkt för att undvika race mellan React-state och formulärsubmit.

### Avtalslista och detalj

- Nytt avtal, sökning och filter för status, säljare, team, produkt, datum, saknat samtal, väntar på kund, leveransfel och förfallen påminnelse.
- Kolumner för säljare, team, källsamtal, senaste leverans, påminnelser och aktivitet.
- Detaljsida med avtal, samtal, PDF/hash, leveranser, reminders, acceptans, evidence och händelsetidslinje.
- Svenska användarstatusar och konkreta konfigurations-/leveransfel.

## 6. Resend-integration

- Tenant kan välja plattformshanterat eller tenantägt konto.
- API-nyckel, webhook secret och rå path-token krypteras; sparade hemligheter visas aldrig igen.
- Ändring av icke-hemliga fält bevarar befintliga credentials.
- Sparande sätter integrationen till `pending`.
- `testResendIntegration` skickar ett verkligt testmeddelande, använder stabil idempotens, sparar provider-ID och sätter `active` endast vid lyckat svar.
- Tenantens integration prioriteras före global fallback.
- E-post stoppas före versionslåsning när varken aktiv tenantintegration eller global fallback finns.
- `outbound_email` och `contract_delivery_email` kontrolleras i både app/RPC/workerflöden.
- Tenantunik webhookroute läser raw body, verifierar Svix-signaturen, deduplicerar `svix-id` och litar aldrig på tenant-ID i payloaden.
- Providerstatus mappas till rätt `email_messages`, delivery, events och reminder-cancellation.
- Bounce, complaint och suppression stoppar framtida e-postpåminnelser och köade reminder-outboxjobb.

## 7. Outbox, bilagor och påminnelser

- `email_messages.attachments` innehåller dokumentreferenser, inte klientstyrda stora base64-strängar.
- Workern verifierar tenant/avtal/version/dokument, laddar från privat Storage, kontrollerar 20 MB och SHA-256 och kodar sedan bytes till Resend.
- Resend får stabil `Idempotency-Key` per affärshändelse.
- Separata leveranser skapas för e-post och SMS; ett fel i ena kanalen påverkar inte den andra.
- Exponentiell backoff används för tillfälliga fel; permanenta providerfel dead-letter-hanteras.
- Automatiska reminders schemaläggs per tenantpolicy, tidszon och quiet hours.
- Samma aktiva krypterade accepttoken återanvänds.
- Manuella reminders får egen delivery, event, audit och idempotens.
- Pending reminders och tillhörande outboxjobb avbryts vid accept, decline, expiry, cancellation och supersede.
- Vercel cron anropar `/api/cron/process-outbox` varje minut med `CRON_SECRET`.

## 8. API

Implementerat eller utbyggt:

- `POST /api/v1/contracts`
- `GET /api/v1/contracts`
- `GET /api/v1/contracts/:id`
- `POST /api/v1/contracts/:id/send`
- `POST /api/v1/contracts/:id/reminders`
- `POST /api/v1/contracts/:id/extend-expiry`
- `GET /api/v1/contracts/:id/deliveries`
- `GET /api/v1/contracts/:id/events`
- `GET /api/v1/contracts/:id/documents/:documentId`
- `POST /api/v1/integrations/resend/test`
- `POST /api/webhooks/resend/:token`

API:t använder Zod, tenantkontroll, permissions, affärsidempotens, audit och `x-correlation-id`. API-nyckeln begränsas både av sina scopes och den skapande användarens aktuella aktiva tenantroll.

## 9. Behörigheter och säkerhet

Tillagt eller separerat:

- `contracts.send`
- `contracts.remind`
- `contracts.manage_expiry`
- `contracts.activate`
- `contracts.manage_templates`
- `integrations.manage`
- `integrations.test`

Säkerhetsförbättringar:

- RLS och tenantbundna foreign keys på nya tabeller.
- cross-tenant- och wrong-customer-call blockeras i databasen.
- krypterade tenanthemligheter och separat tokenhash.
- privat Storage och byte-hashverifiering.
- signerad/idempotent webhook.
- versions- och dokumentimmutabilitet efter utskick.
- audit för externa samtal, integrationer, utskick, reminders, expiry och acceptans.
- inga e-postutskick från klientkomponenter.

## 10. Tester och verifiering

### Genomförda kontroller som passerade

```text
node scripts/contract-delivery-unit-tests.mjs
→ exit 0
→ stable snapshot/PDF hashes, reminder quiet hours, Resend mapping och escaped email templates passerade.

Statisk TypeScript/TSX-transpilering av src + Supabase Functions
→ 189 filer
→ 0 syntaxdiagnostik
→ exit 0

node scripts/verify.mjs
→ 36 migrationer verifierade
→ source-call-gating, canonical PDFs, Resend, webhooks, reminders, evidence, tenantgränser och worker deployment verifierade
→ exit 0

Strukturell SQL-kontroll av fyra nya migrationer
→ balanserade parenteser och dollar-quoted blocks
→ exit 0
```

Full logg finns i:

- `KUNDEXA_VERIFY_LOG_2026-07-27_CONTRACT_DELIVERY.txt`

### Verklig extern blockerare i denna körmiljö

```text
npm ci --offline --ignore-scripts --no-audit --no-fund
→ exit 1
→ ENOTCACHED: tslib saknas i lokal npm-cache och registrygatewayen är inte tillgänglig.
```

Därför kunde följande inte bevisas i just denna sandbox:

- full `npm ci`
- full projekt-`npm run typecheck`
- `deno check`/`npm run typecheck:edge`
- full `npm test` inklusive PGlite
- `next build`
- lokal Supabase `db reset`
- länkad `db push`
- verkligt Resend-test/webhook mot externa tjänster

Det är en miljöblockering, inte ett dolt godkänt resultat. Kommandona nedan måste köras i den lokala/nätverksanslutna miljön.

## 11. Ändrade filer

- `.env.example`
- `package-lock.json`
- `package.json`
- `scripts/verify-sql.mjs`
- `scripts/verify.mjs`
- `src/app/(dashboard)/app/calls/page.tsx`
- `src/app/(dashboard)/app/contracts/[id]/page.tsx`
- `src/app/(dashboard)/app/contracts/page.tsx`
- `src/app/(dashboard)/app/dialer/lists/[id]/page.tsx`
- `src/app/(dashboard)/app/integrations/page.tsx`
- `src/app/(dashboard)/app/products/page.tsx`
- `src/app/accept/[token]/page.tsx`
- `src/app/actions/admin.ts`
- `src/app/actions/contracts.ts`
- `src/app/actions/products.ts`
- `src/app/actions/public-contract.ts`
- `src/app/api/v1/api-keys/route.ts`
- `src/app/api/v1/contracts/route.ts`
- `src/components/list-dialer-workspace.tsx`
- `src/components/webrtc-dialer.tsx`
- `src/lib/api-auth.ts`
- `src/lib/env.ts`
- `src/lib/permissions.ts`
- `supabase/functions/process-outbox/index.ts`
- `vercel.json`

## 12. Nya filer

- `KUNDEXA_VERIFY_LOG_2026-07-27_CONTRACT_DELIVERY.txt`
- `docs/CONTRACT_DELIVERY_IMPLEMENTATION_2026-07-27.md`
- `docs/RESEND_CONTRACT_DELIVERY.md`
- `scripts/contract-delivery-unit-tests.mjs`
- `src/app/(dashboard)/app/contracts/new/page.tsx`
- `src/app/api/cron/process-outbox/route.ts`
- `src/app/api/public/contracts/[token]/document/route.ts`
- `src/app/api/v1/contracts/[id]/deliveries/route.ts`
- `src/app/api/v1/contracts/[id]/documents/[documentId]/route.ts`
- `src/app/api/v1/contracts/[id]/events/route.ts`
- `src/app/api/v1/contracts/[id]/extend-expiry/route.ts`
- `src/app/api/v1/contracts/[id]/reminders/route.ts`
- `src/app/api/v1/contracts/[id]/route.ts`
- `src/app/api/v1/contracts/[id]/send/route.ts`
- `src/app/api/v1/integrations/resend/test/route.ts`
- `src/app/api/webhooks/resend/[token]/route.ts`
- `src/lib/api-correlation.ts`
- `src/lib/contracts/api-service.ts`
- `src/lib/contracts/call-eligibility.ts`
- `src/lib/contracts/canonical-contract-snapshot.ts`
- `src/lib/contracts/canonical-document.ts`
- `src/lib/contracts/document-hash.ts`
- `src/lib/contracts/generate-contract-pdf.ts`
- `src/lib/contracts/price-terms.ts`
- `src/lib/contracts/resend-status.ts`
- `src/lib/email/render-email-layout.ts`
- `src/lib/email/templates/contract-accepted.ts`
- `src/lib/email/templates/contract-delivery-failed.ts`
- `src/lib/email/templates/contract-delivery.ts`
- `src/lib/email/templates/contract-expired.ts`
- `src/lib/email/templates/contract-reminder.ts`
- `supabase/functions/_shared/reminder-time.ts`
- `supabase/migrations/202607270000_delivery_status_expansion.sql`
- `supabase/migrations/202607270001_contract_delivery_call_resend_reminders.sql`
- `supabase/migrations/202607270002_contract_api_execution_context.sql`
- `supabase/migrations/202607270003_contract_draft_commercial_assignment.sql`

## 13. Borttagna filer

- Inga.

## 14. Lokal synkning

Zip-filen innehåller en komplett projektkatalog.

```bash
cd ~/Downloads
rm -rf /tmp/kundexa-contract-delivery-2026-07-27
mkdir -p /tmp/kundexa-contract-delivery-2026-07-27

unzip -q kundexa-contract-delivery-complete-2026-07-27.zip   -d /tmp/kundexa-contract-delivery-2026-07-27

rsync -av --checksum --itemize-changes --dry-run   /tmp/kundexa-contract-delivery-2026-07-27/kundexa-contract-delivery-complete-2026-07-27/   /Users/hekmath/Desktop/Projects/kundexa/

rsync -av --checksum --itemize-changes   /tmp/kundexa-contract-delivery-2026-07-27/kundexa-contract-delivery-complete-2026-07-27/   /Users/hekmath/Desktop/Projects/kundexa/
```

Ingen `--delete` används; lokala filer som inte finns i leveransen raderas därför inte automatiskt.

## 15. Lokal verifiering efter synkning

```bash
cd /Users/hekmath/Desktop/Projects/kundexa

node -v
npm -v
npm ci
npm run typecheck
npm run typecheck:edge
npm test
npm run build
npm run verify
```

Vid ett fel ska det faktiska första felet rättas och samma kommando köras om. Hoppa inte över röda steg.

## 16. Supabase-migrationer och typer

Mot lokal Supabase:

```bash
cd /Users/hekmath/Desktop/Projects/kundexa
npx supabase@2.109.1 db reset
npm run types:generate
npm run typecheck
npm run typecheck:edge
npm test
npm run build
```

Mot länkad staging/produktion, efter backup och verifierad project ref:

```bash
cd /Users/hekmath/Desktop/Projects/kundexa
npx supabase@2.109.1 login
npx supabase@2.109.1 link --project-ref "<SUPABASE_PROJECT_REF>"
npx supabase@2.109.1 db push
npm run types:generate
```

Kör aldrig `db reset` mot produktion.

## 17. Edge Function-deploy

```bash
cd /Users/hekmath/Desktop/Projects/kundexa

npx supabase@2.109.1 secrets set   APP_URL="https://app.kundexa.se"   KUNDEXA_ENCRYPTION_KEY="<SAMMA_32-BYTE_BASE64_NYCKEL_SOM_WEBBAPPEN>"   CRON_SECRET="<LÅNG_SLUMPMÄSSIG_HEMLIGHET>"   RESEND_API_KEY="<PLATFORMSNYCKEL_OM_GLOBAL_FALLBACK_ANVÄNDS>"   DEFAULT_EMAIL_FROM_NAME="Kundexa"   DEFAULT_EMAIL_FROM_ADDRESS="avtal@utskick.kundexa.se"   --project-ref "<SUPABASE_PROJECT_REF>"

npm run functions:deploy -- --project-ref "<SUPABASE_PROJECT_REF>"
```

## 18. Miljövariabler

Webb/Vercel:

```env
NEXT_PUBLIC_APP_URL=https://app.kundexa.se
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
KUNDEXA_ENCRYPTION_KEY=
KUNDEXA_WEBHOOK_PEPPER=
CRON_SECRET=
RESEND_API_KEY=
DEFAULT_EMAIL_FROM_NAME="Kundexa"   DEFAULT_EMAIL_FROM_ADDRESS="avtal@utskick.kundexa.se"
RESEND_WEBHOOK_SECRET=
SUPABASE_PROJECT_REF=
```

Edge Functions:

```env
APP_URL=https://app.kundexa.se
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
KUNDEXA_ENCRYPTION_KEY=
CRON_SECRET=
RESEND_API_KEY=
DEFAULT_EMAIL_FROM_NAME="Kundexa"   DEFAULT_EMAIL_FROM_ADDRESS="avtal@utskick.kundexa.se"
```

`KUNDEXA_ENCRYPTION_KEY` måste vara samma i webblagret och Edge Functions. Tenantägda Resend-hemligheter lagras krypterat i databasen, aldrig som klientvariabler.

## 19. Manuella steg i Resend Dashboard

1. Lägg till en dedikerad domän/subdomän, exempelvis `utskick.foretag.se`.
2. Lägg in DNS-posterna Resend visar och vänta på verifierad status.
3. Skapa en API-nyckel.
4. Använd en avsändaradress på verifierad domän, exempelvis `avtal@utskick.foretag.se`.
5. I Kundexa: `/app/integrations` → Resend → välj kontoform → fyll i API-nyckel, namn, from, reply-to och testmottagare → spara.
6. Kör **Testa anslutning**; status ska först därefter bli aktiv.
7. Aktivera `outbound_email` och `contract_delivery_email`.
8. Generera tenantens webhookadress i Kundexa.
9. Lägg webhookadressen i Resend och välj event: sent, delivered, opened, clicked, delivery delayed, bounced, complained, failed och suppressed.
10. Kopiera Resends signing secret till Kundexa och spara krypterat.
11. Skicka ett testavtal och kontrollera provider-ID, deliverystatus, webhookhändelser och PDF-bilaga.

Full driftdokumentation finns i `docs/RESEND_CONTRACT_DELIVERY.md`.

## 20. Acceptanskriterier – verifierad status

| Område | Status | Kommentar |
|---|---|---|
| Avtal från after-call | Implementerat | Dialer, WebRTC och calls länkar kund + call till guiden. |
| Manuellt avtal | Implementerat | Ny sammanhängande guide. |
| Utskick utan samtal blockeras | Implementerat i server + SQL | Runtime-DB-test måste köras lokalt/staging. |
| Externt tidigare samtal | Implementerat | Riktig call-rad + metadata + audit. |
| Cross-tenant/wrong customer | Implementerat i SQL | Runtime-DB-test måste köras. |
| Snapshot och versionslås | Implementerat | Statiskt verifierat. |
| Kanonisk privat PDF | Implementerat | `pdf-lib`, snapshot-hash och PDF-hash. |
| Exakt PDF på acceptbegäran | Implementerat | Dokument-ID + hash binds och verifieras. |
| Tenantägd/plattformshanterad Resend | Implementerat | Externt test kräver riktiga credentials. |
| Resend pending → test → active | Implementerat | Riktigt provideranrop krävs i staging. |
| Säker PDF-bilaga via outbox | Implementerat | Privat fetch + storlek + byte-hash. |
| Resend idempotens | Implementerat | Stabil affärsnyckel. |
| Signerad webhook + dedupe | Implementerat | Verkliga Svix-events måste provas externt. |
| Full providerstatus | Implementerat | Sent ≠ delivered. |
| Reminder-policy | Implementerat | Tenant, tidszon, quiet hours och maxantal. |
| Automatiska reminders | Implementerat | Cron/outbox; produktionscron måste verifieras. |
| Manuella reminders | Implementerat | Permission, event, audit och separat delivery. |
| Samma acceptlänk | Implementerat | Krypterad token återanvänds. |
| Stoppa reminders vid slutstatus | Implementerat | Reminder- och köade outboxjobb avbryts. |
| Bounce/complaint/suppression | Implementerat | Stoppar e-postreminders. |
| Publik läsning/nedladdning | Implementerat | Token/status/expiry och byte-hash. |
| Accept/avstå | Implementerat | Dubbel, utgången och superseded länk blockeras. |
| Acceptbevis | Implementerat | IP, UA, namn, text, tid, call och hash. |
| Evidence och accepterad kopia | Implementerat | Privat manifest/PDF + confirmation outbox. |
| RLS/tenanthemligheter/audit | Implementerat | SQL måste köras i verklig Postgres för slutbevis. |
| TypeScript syntax | Godkänd | 189 filer, 0 syntaxdiagnostik. |
| Projektverifierare | Godkänd | 36 migrationer. |
| Full npm/typecheck/build | Externt blockerad här | `tslib` saknas i cache och registry är otillgängligt. |
| Supabase runtime/integration | Kräver lokal/staging | Ingen lokal Postgres/Supabase/Deno i sandbox. |
| Resend end-to-end | Kräver stagingcredentials | Ingen extern credential eller verifierad domän i sandbox. |

## 21. Verkliga återstående externa steg

Källkoden och migrationsytan är implementerad. Följande måste göras utanför denna sandbox innan produktionsgodkännande:

1. Kör `npm ci`, full typecheck, Edge typecheck, test, build och verify i en nätverksansluten miljö.
2. Kör migrationerna mot lokal Supabase först och därefter staging.
3. Regenerera Supabase TypeScript-typer och rätta eventuella schema-specifika typavvikelser.
4. Sätt verkliga Vercel/Supabase-hemligheter.
5. Verifiera Resend-domän, testutskick och Svix-webhookevents.
6. Kör end-to-end-flödet med riktig privat Storage och mock-/stagingmottagare innan produktion.
