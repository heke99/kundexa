# DocuSeal till Kundexa

Detta är en källkodspinnad bygg- och anslutningsgrund. Ingen installation eller produktionssignering har körts. Compose bygger DocuSeal från commit `3c65b0e4ba872fe71d5566c0d09c3ace59a7fb8a` i [docusealco/docuseal](https://github.com/docusealco/docuseal/tree/3c65b0e4ba872fe71d5566c0d09c3ace59a7fb8a). Repo-klonen och källinventeringen gjordes 15 oktober 2026. Byggmiljön behöver Docker BuildKit, nätverk och upstreams byggberoenden. Upstreams Dockerfile innehåller externa paket och hämtningar; commitpinnen är ingen garanti för bitidentisk container. Inget färdigbyggt image-digest har verifierats.

Compose använder en separat Postgresanslutning och beständiga hemligheter via miljövariabler. Kör inte DocuSeals tabeller i Kundexas publika Supabase-schema. Lägg TLS-proxy framför loopbackport 3001 och konfigurera betrodd publik signeringsdomän. Säkerhetskopiera Postgres, volym och krypteringshemligheter tillsammans och återställningstesta dem. Rails standarduppstart och databasförberedelse kommer från upstream; en full containerbyggnad och uppstart är **NOT RUN**.

## Verifierad källinventering

Alla sökvägar nedan gäller den pinnade upstreamcommiten:

| Källa | Vad adaptern använder |
| --- | --- |
| `config/routes.rb` | Självhostad API-root `/api`; submissions index/show/create/update/destroy |
| `app/controllers/api/submissions_controller.rb` | `template_id`, `submitters`, explicit avstängd e-post/SMS, `values`, `readonly_fields`, `external_id`, bevarad signeringsordning |
| `app/controllers/api/api_base_controller.rb` | Paginering med `limit` och `after` |
| `lib/submissions/filter.rb` | Filter på `template_id`; inget submissionfilter för `external_id` |
| `lib/submissions/serialize_for_api.rb` | Serverberäknad status, signatärer och `combined_document_url` efter completion |
| `lib/submitters/serialize_for_api.rb` | Submitter-id, roll, slug och external_id |
| `lib/send_webhook_request.rb` | `event_type`, `timestamp`, `data`; konfigurerade webhookheaders från `webhook_url.secret` |
| `app/jobs/send_submission_completed_webhook_request_job.rb` | Completion använder serialiserad submissiondata |
| `Dockerfile`, `docker-compose.yml`, `config/database.yml`, `config/environments/production.rb` | Uppströms byggväg, port 3000, datavolym, Postgres-URL, SSL och krypteringsmiljö |

Inga upstreamfiler har kopierats eller modifierats i Kundexa. Kundexas adapter använder det verifierade API-kontraktet. Behåll upstreams `LICENSE` och `LICENSE_ADDITIONAL_TERMS` vid en framtida koddistribution; användarens uppgivna återanvändningstillstånd ändrar inte denna inventerings avgränsning.

## Anslutning

Skapa `DocuSealSigningProvider` server-side med API-nyckel, API-root (`https://sign.example/api/` vid självhostning), separat `signingBaseUrl`, exakt `webhookUrl`, hemlig egen webhookheader och explicit lista över tillåtna dokumentorigins. Webhookheaderns hemlighet ska vara minst 32 tecken och samma header ska konfigureras på DocuSeal-webhooken. DocuSeal stöder headers i webhookens Secret-konfiguration. Kundexa hittar inte på ett HMAC-kontrakt; aktuell upstream har dessutom en separat HMAC-mekanism som denna adapter inte använder.

Kundexa äger inbjudningar och påminnelser. Adaptern sätter `send_email=false` och `send_sms=false` på både submission och signatärer. Template-id, roller och fält ska komma från en godkänd mallbindning. Pris, bolag och övriga kanoniska fält ska skickas i `fieldValues` och låsas med `readonlyFields`. Lås motsvarande mallversion mot Kundexas dokument/version innan en submission skapas. Adaptern ger bara låg identitetsnivå för `external_esign`; BankID och högre nivåer avvisas.

Spara ett lokalt create-attempt **före** `createEnvelope({...input, createMode: "initial"})`. Vid timeout, oläsbart svar eller lokal lagringsförlust efter POST ska samma identitet återhämtas med `createMode: "reconcile_only"`. Adaptern paginerar mallens submissions och matchar exakt samtliga stabila signatärsexternal_id, e-post och roll. Den skickar aldrig en ny POST i reconcile-läget. Noll träffar innebär fortsatt okänt utfall; fler än en träff är konflikt. Upstream garanterar inte create-idempotens. Orchestreringen måste därför låsa initialförsöket atomiskt; parallella initialförsök är inte tillåtna.

`createSignerSession` läser serverns envelope och kontrollerar recipient innan en slug-länk ges. Den returnerar `expiresAt: null`: någon bevisad providerexpiry för länken finns inte. Kundexas egna publika tokengränser måste fortfarande tillämpas före utlämning.

`verifyWebhook` autentiserar headern och normaliserar händelsen. Det är en signal för ny serveravläsning, aldrig ensam bevisning för completion. `fetchFinalDocument` kräver serverbekräftad completion och färdiga signatärer, en betrodd HTTPS-origin, inga redirects, PDF-typ och PDF-magic. Hämta och lagra bytes, hash, envelope-id, kontraktsversion och acceptansgeneration atomiskt innan slutligt avtalsstatus tillåts. PDF-filer får vara högst 30 MiB. Aktivering kräver separat verifierad import och evidens enligt Kundexas databasregler.

## Lokal verifiering

`node scripts/docuseal-unit-tests.mjs` kör verklig adapterlogik mot kontrollerad HTTP-transport: skapa/återhämta utan ny POST, låsta fält, inga providerinbjudningar, webhookautentisering, serverbekräftad completion samt avvisning av obetrodda dokumentadresser. Detta verifierar kodkontraktet. Extern DocuSeal-installation, verklig signering, mailleverans, PDF-visning och callbacks är **NOT RUN**.

## Kundexas självhostade tillägg

Den öppna upstreamversionen har **ingen** `POST /api/templates/pdf`. Kundexa använder därför ett eget smalt overlay i `overlay/`, inte en påhittad Pro-route. Tillägget återanvänder `ApiBaseController`, konto/rollkontrollen, `Templates::CreateAttachments.call` och upstreams PDF-behandling. `POST /api/kundexa/templates` tar ett kanoniskt PDF-dokument samt enbart signaturfält, binder dem till en stabil lokal envelope-nyckel och hash, serialiserar skapandet med kontots databasradlås och fryser mallen. Samma nyckel med ändrat dokument eller schema avvisas. `reconcile_only` skapar aldrig en mall. Ett databasanrop som rullar tillbaka kan lämna ett oanvänt storage-blob; driftens retention ska hantera sådana blobs.

Overlayns callbacks skyddar frysta mallars fält, schema och dokument mot normala builder/API-ändringar. Adaptern återläser ändå schema, roller och dokumentbytes och jämför dokumenthash före användning. Detta kräver den återanvända självhostade tjänsten; en standardinstallation eller molntjänst utan tillägget avvisar provisioneringen och Kundexa ska då blockera utskick.

Bygg först upstreambasen och sedan overlay med `sh services/docuseal/build.sh`; starta därefter den färdigbyggda tjänsten bakom TLS. Den lokala bastaggen härleds från exakt Git-commit. Registrera och lås det verkliga image-digestet i vald registry efter en godkänd byggning. Båda overlayfilerna har syntaxkontrollerats i `ruby:4.0.5-alpine` med resultat **PASS**. `sh -n build.sh` och `docker compose config --quiet` passerar. Dockerbyggning försöktes: första försöket stoppades av byggcontainerns DNS/proxy; ett nytt försök med sessionens proxy och betrodda CA stoppades därefter av HTTP 403 från APK-paketkällan. Källbyggningen är **BLOCKED** tills byggmiljön har åtkomst till upstreams paketkällor. Full Rails-boot, återställning, callback och verklig signering är ännu **NOT RUN**. Adaptertesterna verifierar HTTP-kontraktet, inte Rails-körningen.

## Kundexas externa avtalskedja

`src/lib/signing/orchestration.ts` använder den frysta, redan ifyllda kanoniska PDF:en och endast dess obligatoriska signaturfält. Initiering sker via den separata säljaråtgärden eller avtals-API:ts e-postkanal. Namn och e-post måste överensstämma med dokumentets frysta motpart; ändrade CRM-uppgifter skriver aldrig över ett skickat dokument. Den första leveransen stöder en obligatorisk signatär och låg identitetsnivå. BankID eller flera mottagare erbjuds inte av denna adapterresa.

Migration `202610150004` reserverar generation, parter, källa/hash och create-försök innan ett externt anrop görs. En separat atomisk submission-claim ger endast ett anrop rätt till den första POST:en. Återuppta läser samma identitet och använder därefter avstämning; ett okänt utfall leder aldrig till en automatisk ny submission. Kundexas transactional outbox köar exakt en inbjudan när provideridentiteten är sparad. DocuSeals egna e-post-/SMS-inbjudningar är avstängda.

Kundlänken `/sign/:token` validerar tokenhash, aktiv tenant, generation, version, lokal svarstid och mottagare före en serverhämtad signeringssession. Submission får `expire_at`, vilket den pinnade upstreamversionens formulärkontroller använder för att förhindra signering efter tidsgränsen. Avbryt arkiverar hos leverantören och bekräftar serverstatus innan det lokala försöket stängs. En gammal generations länk kan inte färdigställa det aktuella avtalet.

`/api/webhooks/docuseal` kräver konfigurerad hemlig header och hämtar därefter verklig submissionstatus server-side. Mottagar-ID och e-post korskontrolleras. Slut-PDF sparas privat med egen hash; databasfunktionen binder dokument, generation, signatär och verifierad händelse och anropar befintlig finalisering i samma transaktion. Slutförd signering är separat från aktivering. Säljaren kan också begära samma serveravstämning manuellt när en webhook uteblir.

Serverkonfiguration: `DOCUSEAL_API_URL`, `DOCUSEAL_SIGNING_URL`, `DOCUSEAL_API_KEY`, `DOCUSEAL_WEBHOOK_HEADER_NAME`, `DOCUSEAL_WEBHOOK_SECRET` (minst 32 tecken), `DOCUSEAL_DOCUMENT_ORIGINS` (kommaseparerade betrodda HTTPS-origins). Registrera webhooken på `${NEXT_PUBLIC_APP_URL}/api/webhooks/docuseal` med exakt samma header och hemlighet. Hemligheter går endast till servern.

Lokala kontroller omfattar adaptertransport, orchestrationens ordning och SQL-runtime med två tenants, resurskonflikter, exklusiv submission-claim, en inbjudan samt slutdokumentets hash-/lagringsbindning. Verklig distribution, leverans till mottagare, visuell PDF-kontroll och full signering mot driftmiljö är fortfarande **NOT RUN**.

## Leverantörens officiella audit-PDF

`fetchAuditDocument(envelopeId)` hämtar `audit_log_url` från samma serveravlästa, färdiga submission. I den pinnade koden skapar `Api::SubmissionsController#show` saknad audit med `Submissions::EnsureAuditGenerated`; `lib/submissions/serialize_for_api.rb` exponerar URL:en endast efter completion. `Submission#audit_log_url` är alias till `audit_trail_url`, som pekar på submissionens `audit_trail.blob`. Detta är leverantörens audit-PDF och ett annat dokument än `combined_document_url`.

Adaptern kräver färdiga signatärer, tillåten HTTPS-origin, PDF-content-type/magic och högst 30 MiB även för auditfilen. Orchestreringen ska lagra auditfilen privat med egen hash och bindning till envelope, kontraktsversion och signeringsgeneration, med metadata `provider_audit`. Den får inte registreras som Kundexas genererade `evidence_pdf`. Adaptertestet kontrollerar separat audit-URL samt avvisning av ofärdig submission, saknad audit, obetrodd origin, fel filtyp/magic och för stor fil. Verklig generering och import från driftsatt DocuSeal är **NOT RUN**.

## Förberedd installation när server finns

En Linuxserver med Docker Engine/Compose och en publik HTTPS-domän räcker som utgångspunkt; dimensionering måste följas upp med verkliga PDF-filer och samtidig belastning. Inget installeras på säljarens dator. Kundexa behåller CRM-databasen; DocuSeal har egen databas och filvolym.

1. Kopiera denna katalog till servern. Kopiera `.env.example` till `.env` och fyll i beständiga, nygenererade hemligheter. Använd ett genererat hexvärde för databaslösenordet så URL-kodning inte blir fel. Lägg aldrig den ifyllda filen i Git. Förvara backup av krypteringshemligheterna tillsammans med återställningsrutinen.
2. Kör `sh build.sh`. Byggservern måste nå upstreams Git- och paketkällor, inklusive Alpine APK, RubyGems och npm. Paketkällan för Alpine var blockerad i denna utvecklingsmiljö; en godkänd byggning och Rails-boot återstår.
3. Välj extern Postgres och kör `docker compose --env-file .env up -d`, eller använd den medföljande privata databasen med `docker compose --env-file .env -f compose.yaml -f compose.with-postgres.yaml up -d`. Databasen exponeras inte på en publik port. PostgreSQL-imagens indexdigest verifierades mot Docker Registry 15 oktober 2026 (version 17.11-alpine3.24); följ upp säkerhetsuppdateringar och uppdatera låsningen kontrollerat.
4. Sätt en TLS-proxy framför `127.0.0.1:3001` och registrera DNS för den valda signeringsdomänen. Konfigurera upstreams administratörskonto, API-nyckel och webhook till Kundexa. Webhookens hemliga header måste matcha Kundexas `DOCUSEAL_WEBHOOK_HEADER_NAME`/`DOCUSEAL_WEBHOOK_SECRET`.
5. Sätt Kundexas `DOCUSEAL_API_URL=https://<signeringsdomän>/api/`, `DOCUSEAL_SIGNING_URL=https://<signeringsdomän>` och `DOCUSEAL_DOCUMENT_ORIGINS=https://<signeringsdomän>` (lägg bara till en faktisk separat lagringsorigin om installationen använder den). Lägg API-nyckel och webhookhemlighet i serverns hemlighetshantering, aldrig i `NEXT_PUBLIC_*`.
6. Applicera Kundexas framåtmigrationer på staging, regenerera typer från staging och deploya webb/ändrade Edge Functions. Verifiera Resend-signaturen och kanalberedskapen. Godkänn en PDF-mall med verkliga avtalstexter och en kundsignaturplats; använd en egen kontrollerad mottagare.
7. Kör hela resan: förhandsgranskning → en inbjudan → signering → signerat slutdokument och separat audit-PDF → bevis/bekräftelse → aktiveringskontroll. Prova dessutom tappat svar, upprepad webhook, avbrytande, utgången länk och två tenants. Ta och återställ backup innan tjänsten godkänns för produktion.

Detta är installationsunderlag. Ingen server har beställts, ingen betald tjänst har skapats och ingen produktionsinstallation har genomförts.
