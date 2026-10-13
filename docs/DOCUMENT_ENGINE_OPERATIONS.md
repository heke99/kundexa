# Kundexa dokumenttjänst och produktionsaktivering

## Genomfört i implementationen 2026-10-13

DocuSeals PDF-byggare, dokumentrendering och signeringsmotor är portade till
`services/documents/vendor/docuseal-source.tar.gz` från upstream-commit
`3c65b0e4ba872fe71d5566c0d09c3ace59a7fb8a`. Kundexas tillägg finns som läsbar Rails-kod
i `services/documents/overlay`. Ingen DocuSeal Cloud- eller Pro-aktivering används.

Administratörens resa: skapa PDF-utkast för produkt och avsändarbolag → placera fält
i PDF-byggaren → koppla fälten till kundkort/produkt → lås fältkonfiguration → godkänn
mallversion. En ny version används för ändringar efter låsning. En obligatorisk kundsignatur
måste finnas. Ett utkast utan konfigurerad PDF kan inte godkännas.

Säljarens resa: spara kunduppgifter och samtalsutfall → välj produkt → granska ifylld
PDF → skicka via e-post → följ signeringsstatus → hämta signerad kopia.
Kunden får en Kundexa-länk till granskning och signering. Den signerade originalfilen
och leverantörens bevis hämtas till privat lagring. Kunden får slutfilen via e-post
och på sin länk; säljaren ser den på avtalet. Länken till slutfilen är tillgänglig
i 90 dagar efter signeringsfristens slut. Signering gör inte avtalet automatiskt aktivt.

Alla provideranrop går från servern. Byggaren får en tidsbegränsad token för en mall;
API-nyckeln exponeras inte i webbläsaren. Fält, käll-PDF, mallfingeravtryck,
avtalsversion och signeringsgeneration binds tillsammans. Omskick och avbrott spärrar
tidigare kundlänkar. Köläggning sker atomiskt efter kontroll av aktuell generation.

## Verifierat och kvarstående

| Kontroll | Status |
|---|---|
| Webbens typkontroll och produktionsbuild | PASS |
| Edge-typkontroll | PASS |
| Samtliga SQL-migrationer från tomt lokalt schema | PASS i PGlite med Supabase-stubbar |
| 21 riktade databaskontroller, två tenants, säljare/läsroll, idempotens, generation och lease | PASS lokalt |
| Tre nya migrationer och lästa RPC-rättigheter i länkat Kundexa-projekt | APPLIED / PASS |
| Supabase-typer regenererade från länkat projekt | DONE |
| Docker/Rails build | PASS i GitHub Actions, run 38402406691 |
| Docker/Rails boot och syntetiskt PDF-flöde | PENDING i separat GitHub-jobb |
| Två riktiga JWT-sessioner, privat Storage och säljarens UI | NOT RUN |
| Verkligt Sinch-samtal, Resend-utskick, kundsignatur och signerad bilaga | NOT RUN |
| Produktionsrelease av webb och process-outbox | NOT DONE |
| BankID | FUTURE, inte inkopplat |

Inga applikationstestsviter kördes lokalt enligt användarens prioritering. De riktade
databaskontrollerna är inte ett bevis för leverantörsdrift eller kryptografisk signering.
PGlite saknar hosted Supabase och pgcrypto; dess kryptofunktioner är stubbar.

Oktoberfynden kvarstår som historisk granskning. Kodrättningar i denna gren:
KX26 06–13, 15–23, 25–26 och 28 samt UI 01–02 och delar av UI 04–05/12.
De är inte produktionsgodkända före release och kontrollerad faktisk resa.
KX26 01–05 kräver riktig produkt/mall/pris/kanalkonfiguration. KX26 14 återstår
för äldre API-flöden; DocuSeal-flödet har resurs- och payloadbunden idempotens.
KX26 27 och UI 03/06–11 är inte fullständigt rättade. Listdialern använder ännu
en separat avtalsflik. Menystädningen ersätter inte en visuell säljarkontroll.

KX26 24 är fortfarande OPEN: `spatial_ref_sys` ägs av `supabase_admin`, och tillgänglig
DB-roll kan inte ändra dess behörigheter. Ett tidigare REVOKE gav inte avsedd effekt;
det har lästs tillbaka och är inte markerat löst. Supabase Advisor rapporterar fortfarande
felet samt äldre extension-varningar. Signeringstoken-tabellen har avsiktligt RLS utan
klientpolicyer och saknar SELECT för anon/authenticated.
[Advisor: publik tabell utan RLS](https://supabase.com/docs/guides/database/database-linter?lint=0013_rls_disabled_in_public).

## Kör dokumenttjänsten

Välj en containerhost med HTTPS och beständig lagring. Vercels vanliga webbdeployment
startar inte denna Rails-/Postgres-tjänst. Driftmål och credentials saknas i detta pass.

1. Kopiera `services/documents/.env.example` till `services/documents/.env` på hosten.
   Sätt unika slumpmässiga hemligheter, administratörsadress och dedikerad API-nyckel.
   `APP_URL` ska vara dokumenttjänstens offentliga HTTPS-origin, utan avslutande snedstreck.
   `KUNDEXA_APP_ORIGIN` ska vara Kundexas origin.
2. Kör `sh services/documents/build.sh` och
   `docker compose --env-file services/documents/.env -f services/documents/compose.yaml up -d`.
   Kontrollera först Docker-jobbet i PR. Pinna därefter även databasimage till digest.
3. Kör `docker compose --env-file services/documents/.env -f services/documents/compose.yaml exec -T documents /app/bin/rails runner "Kundexa::Bootstrap.call"`.
   Kommandot skapar en dedikerad konto/användare och sätter API-nyckeln utan att skriva ut den.
4. Sätt HTTPS-proxy till loopback-port 3100. Konfigurera `X-Forwarded-Proto` korrekt
   eftersom `FORCE_SSL=true`. Säkerhetskopiera båda volymerna och verifiera återläsning.
5. Sätt webbmiljöns `KUNDEXA_DOCUMENTS_URL`, `KUNDEXA_DOCUMENTS_API_KEY` och
   `KUNDEXA_DOCUMENTS_SECRET` till motsvarande värden. Callback går till
   `/api/webhooks/docuseal`. Edge-workern använder Kundexas interna dokument-jobbrutt
   med `CRON_SECRET`; den behöver samma giltiga app-origin och secret som webben.
6. Publicera kompatibel webb och process-outbox efter granskning. Nya migrationer är
   redan applicerade i länkat projekt; lokal versionshistorik använder samma versionsnummer.

## Första riktiga kundflödet

Ladda upp verksamhetens slutliga PDF, koppla en produkt och en komplett prisversion,
placera kundfält samt obligatoriskt signaturfält och godkänn versionen. Ersätt inte
ofärdiga juridiska villkor med gissningar. Kontrollera Resends verifierade avsändare,
webhook och båda miljöernas e-postkonfiguration. SMS kräver separat nummer/konfiguration.

Med kontrollerad testkund och mottagare: genomför ett samtal, spara kundkort och utfall,
granska PDF och skicka. Signera i kundens länk. Läs tillbaka contract/signing/envelope,
bevispaket, leveransstatus och den slutliga PDF:ens hash. Hämta samma slutfil som
säljare och kund. Prova även omskick, gammal länk, nekad/utgången signering och workeravbrott.
Aktivera först med ägare/admin/contract_manager efter fullständig signering och bevis.
Godkänn produktionsstatus först när denna kedja är verifierad.
