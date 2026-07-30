# Rinkel-telefoni

## Arkitektur

Rinkel äger telefonin och Kundexa är kanoniskt system för CRM, ringlistor, samtal, efterarbete, rapportering och retention. Webbläsaren anropar endast Kundexas API. All trafik till Rinkel går via den gemensamma server-side-klienten i `supabase/functions/_shared/rinkel.ts`.

Ett utgående samtal följer denna kedja:

1. Kundexa autentiserar användaren och löser aktiv tenant från medlemskapet.
2. RPC:n `rinkel_reserve_outbound_call` validerar RBAC, feature flag, ringtid, kund, DNC/NIX, listlås, callback och den aktiva Rinkel-mappningen i en transaktion.
3. RPC:n skapar en kanonisk `calls`-rad och ett lokalt `call_attempts` innan provideranropet.
4. API-routen dekrypterar rätt tenants API-nyckel och gör ett enda `POST /dial`.
5. Rinkels `204` betyder att begäran accepterades men innehåller inget call ID. `outgoingCall` korreleras därför mot det lokala försöket.
6. Webhooken lagras idempotent och kvitteras snabbt. `process-outbox` behandlar händelsen asynkront.
7. `callEnd` frigör enhetslåset, aktiverar efterarbete och köar inspelning/transkribering.

Den gamla SIP/WebRTC-klienten är inte en produktionsväg. Kompatibilitetskomponenterna pekar på Rinkel-dialern.

## Datamodell

Kanoniska befintliga tabeller:

- `calls` – ett samtal, oavsett provider.
- `call_events` – normaliserad och ordnad providerhistorik.
- `call_recordings` – inspelningsmetadata och eventuell privat objektlagring.
- `outbox_jobs` – hållbar kö med retries/dead-letter.
- `provider_webhook_events` – rå, idempotent webhookmottagning.

Rinkel-specifika tabeller:

- `rinkel_users`, `rinkel_numbers` – tenantseparerad katalogspegel.
- `rinkel_user_mappings` – Kundexa-användare till Rinkel-användare, enhet och standardnummer.
- `rinkel_capabilities` – verifierat kontostöd.
- `rinkel_webhook_subscriptions` – status per event.
- `call_attempts` – lokal idempotency, enhetslås och korrelation.
- `call_transcripts`, `call_insights` – separata provider- och Kundexa-resultat.
- `call_correlation_conflicts` – manuellt hanterbara tvetydigheter.
- `telephony_policies` – ringtid, inspelning, åtkomst och retention.

Alla tenanttabeller har RLS. Providercredentials läses endast med service role efter att användarens tenant och behörighet har validerats.

## Miljövariabler

Webb och API:

```env
RINKEL_API_BASE_URL=https://api.rinkel.com/v1
RINKEL_WEBHOOK_PUBLIC_BASE_URL=https://app.example.com
RINKEL_REQUEST_TIMEOUT_MS=15000
RINKEL_ENFORCE_WEBHOOK_IP_ALLOWLIST=true
```

Edge Functions behöver även projektets befintliga:

```env
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
KUNDEXA_ENCRYPTION_KEY=
APP_URL=https://app.example.com
CRON_SECRET=
```

API-nyckeln är tenantägd och sparas krypterad i `tenant_integrations.credentials_ciphertext`; den är inte en global miljövariabel. Nyckeln eller webhooksecret får aldrig loggas.

## Anslut en tenant

1. Aktivera feature flag `outbound_calls` för tenant.
2. Gå till **Inställningar → Integrationer → Rinkel** som owner/admin.
3. Spara tenantens Rinkel API-nyckel.
4. Kör **Testa anslutning**. Kundexa läser användare och nummer och sparar capability-resultatet.
5. Kör **Synkronisera katalog**.
6. Mappa varje säljare till en aktiv Rinkel-användare med `deviceId` och ett aktivt standardnummer.
7. Spara telefonipolicy.
8. Kör **Konfigurera webhookar** och kontrollera att alla fem event är aktiva.

Synk använder provider-ID som stabil nyckel. Poster som inte längre finns hos Rinkel inaktiveras; historik raderas inte. En inaktiv användare, enhet eller nummer kan inte användas för nya samtal.

## Click-to-call och dialer

`POST /api/v1/calls` accepterar CRM-identiteter, måltelefon, `clientRequestId` och `idempotencyKey`. Frontend får inte välja godtyckliga provider-ID:n. Rinkel-användare, `deviceId` och nummer löses från den verifierade mappningen.

Manuell dialer kan användas när API och mappning är friska. Automatisk dialer kräver dessutom aktiva webhookar och pausas annars. Kravet kontrolleras både i UI och i den atomiska databasreservationen. Avstämningen degraderar webhookhälsan om oklara providerutfall eller samtal utan terminalevent förblir olösta; därefter blockeras nya automatiska samtal tills webhookflödet är friskt igen. Ett partiellt unikt index och transaktionslås tillåter endast ett aktivt försök per säljare och Rinkel-enhet.

`POST /dial` skickas aldrig om automatiskt efter timeout eller nätverksfel, eftersom providerutfallet då är okänt. Samtalet får `provider_outcome_unknown` och reconciliation får avgöra utfallet utan risk för dubbelringning.

## Webhooksetup

Kundexa registrerar följande exakta event:

- `incomingCall`
- `outgoingCall`
- `callStart`
- `callEnd`
- `callInsights`

Måladressen har formen:

```text
https://app.example.com/api/webhooks/rinkel/{connection-public-id}/{secret}/{event}
```

Secret sparas endast som hash. Endpointen kräver HTTPS i staging/produktion, dokumenterad Rinkel-IP, rätt secret, känt event, accepterad content type, begränsad storlek och giltig payload. Dubbletter stoppas av databasens unika nycklar.

För test:

1. Säkerställ att stagingadressen är publik via HTTPS.
2. Klicka **Konfigurera webhookar**.
3. Kontrollera att Rinkel accepterar registreringen och att `rinkel_webhook_subscriptions` visar alla fem event.
4. Verifiera med ett riktigt testsamtal att `provider_webhook_events`, outbox och det kanoniska samtalet uppdateras utan fördröjning.
5. Genomför därefter ett riktigt inkommande och utgående samtal; exempelpayload verifierar transport men inte kontots fulla samtalsflöde.

Om Rinkel har stängt av en webhook efter upprepade fel: åtgärda endpoint/secret/IP-regel, kör **Konfigurera webhookar** igen och verifiera alla event med ett kontrollerat testsamtal. Automatisk dialer förblir pausad tills `webhook_status=active`.

Lokal utveckling kan sätta `RINKEL_ENFORCE_WEBHOOK_IP_ALLOWLIST=false`, men staging och produktion ska använda `true`.

## Händelser och status

Händelser kan komma dubbelt eller i fel ordning. Terminal status skrivs inte tillbaka till en tidigare status. `callEnd.cause` mappas till Kundexas status men ursprunglig cause sparas. Okända inkommande nummer skapar ett samtal utan kundkoppling; Kundexa skapar aldrig en kontakt automatiskt.

## Inspelningar

Telefonipolicyn måste vara aktiv och det synkroniserade Rinkel-numret måste rapportera inspelningsstöd innan Kundexa beskriver funktionen som aktiv. Aktivering av nummerinspelning görs i Rinkel när kontots aktuella API/plan inte exponerar en dokumenterad skrivbar nummerinställning.

Standardläget `provider_only` sparar endast providerreferensen. Vid uppspelning kontrolleras tenant, roll, team och policy, åtkomsten loggas och en ny tillfällig `GET /call-recordings/{id}/stream`-URL hämtas server-side.

`kundexa_private_copy` laddar ned ljudet server-side, avvisar redirects/fel content type/orimlig storlek och lagrar det i den privata bucketen `call-recordings` med tenantprefix och hash. Bucketen får aldrig vara publik.

Providerinspelning raderas endast om `delete_provider_recording_on_retention=true`. Då används Rinkels `DELETE /call-recordings/{id}`; operationen är idempotent.

## Transkribering och AI

Efter `callEnd` hämtas CDR och, när policyn tillåter, `GET /call-detail-records/by-call-id/{callId}/transcription`. HTTP 204 betyder väntande och använder exponentiell backoff. Användaren kan köa ett nytt försök från samtalsdetaljen.

Rinkel Insights lagras med `source=rinkel`. Framtida Kundexa-analys ska använda `source=kundexa`; providerdata skrivs aldrig över.

## Retention och reconciliation

Maintenance worker köar:

- `rinkel.reconcile_calls` per aktiv anslutning varje timme.
- `rinkel.retention` per tenant varje dag.

Reconciliation jämför pågående/oklara samtal med CDR, fyller duration och försöker korrelera 204-/timeoutförsök med exakt nummerpar och ett snävt tidsfönster. Flera träffar blir en konflikt och kopplas aldrig godtyckligt.

Retention tar bort privata storage-objekt före databasreferensen, rensar transkript/insights och minimerar gamla webhookpayloads. Providerdata raderas endast med den uttryckliga policyn ovan. Jobben har tidsbucket-baserade idempotency-nycklar.

## Planberoenden

API-åtkomst, webhookar, inspelning, transkribering och AI Insights kan bero på Rinkel-plan och nummerkonfiguration. Kundexa capability-detekterar dessa och visar inte ett ej verifierat stöd som aktivt. Webhooks kräver enligt Rinkels dokumentation en plan med integrationsstöd.

## Felsökning

- `authentication_failed`: rotera API-nyckeln i Rinkel och spara den på nytt.
- `plan_unsupported`: uppgradera Rinkel-planen eller stäng av den berörda funktionen.
- `rinkel_seller_mapping_missing`: synka katalog och spara säljarens mappning.
- `rinkel_device_missing`: välj en Rinkel-användare som har `deviceId`.
- `active_call_already_exists`: avsluta eller reconcilea säljarens tidigare samtal.
- `provider_outcome_unknown`: klicka inte igen; låt reconciliation matcha CDR.
- webhook `degraded`: kontrollera publik HTTPS, source IP, secret och outbox/dead-letter.
- transkript `pending`: Rinkel har CDR men inget transkript ännu; använd retry.

## Staging och produktion

Staging måste använda ett separat Supabase-projekt och ett separat/test-Rinkel-konto eller säkra testnummer. Kör migration, generera typer, deploya Functions, konfigurera publika webhookar och verifiera acceptansscenarierna med faktiska samtal.

Produktion kräver privat `call-recordings`-bucket, schemalagda `maintenance-worker` och `process-outbox`, larm på dead-letter/webhook degradation, korrekt `APP_URL`/webhookbas, IP-allowlist samt verifierad juridisk grund och information om inspelning.

## Referenser

- <https://developers.rinkel.com/docs/api/rinkel-api>
- <https://developers.rinkel.com/docs/api/start-an-outgoing-call>
- <https://developers.rinkel.com/docs/tutorials/webhooks>
- <https://developers.rinkel.com/docs/api/get-the-transcription-of-a-call-detail-record>
- <https://developers.rinkel.com/docs/api/get-a-temporary-url-to-stream-or-download-a-call-recording>
- <https://developers.rinkel.com/docs/api/delete-a-call-recording>
