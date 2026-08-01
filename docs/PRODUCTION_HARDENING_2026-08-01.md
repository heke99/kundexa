# Kundexa produktionshärdning 2026-08-01

Detta dokument beskriver den canonical implementation som lagts ovanpå befintlig Kundexa-arkitektur. Ingen parallell telefoni-, import-, leverans- eller signeringsmotor har införts.

## Implementerat i denna patch

### KX-004, KX-005 och KX-011 – Rinkel och dialer

- Råa Rinkel-webhookar lagras och korreleras innan current projection uppdateras.
- Okorrelerade event får `pending_correlation`, exponentiell retry och reconciliation i stället för permanent konflikt.
- Inkommande och utgående korrelation sker genom atomiska RPC:er.
- `apply_rinkel_call_event` reducerar events idempotent och sparar providerstatus/cause separat.
- Databastriggern blockerar äldre events, statusregression och terminal-till-icke-terminal övergång.
- Dialerklienten kombinerar Realtime, initial statusläsning, polling, reconnect och visibility recovery.
- Legacy tenantbaserade Rinkel-jobb dead-letteras och den gamla parallella processorn är borttagen.

### KX-006 – Resend

- `email_delivery_events` är en immutable event ledger.
- `apply_resend_delivery_event` reducerar status atomiskt.
- Äldre event och event med lägre rang kan inte skriva tillbaka en nyare/högre projection.
- Replay är idempotent på provider-event-ID.
- Reminder- och suppression-side effects körs endast när eventet faktiskt applicerats.

### KX-007, KX-008 och KX-009 – Import

- Parsern rapporterar source, parsed, accepted och rejected row count.
- Filer över 10 000 rader markeras `truncated` och blockeras före commit; poster kan inte längre tappas tyst.
- Preview använder `validation_fingerprint` medan commit använder separat `execution_idempotency_key`.
- Samma fil kan därför previewas flera gånger och därefter committas exakt en gång.
- Importprofiler kan fastställa, mappa eller härleda `customer_type`; alla poster blir inte längre automatiskt företag.
- Databastrigger blockerar en trunkerad eller icke-idempotent import från att gå till `processing`.

### KX-002, KX-003, KX-013 och KX-014 – Signering

- Provideroberoende `SigningProvider`-kontrakt finns för envelope, signer session, webhookverifiering och slutdokument.
- Signeringspolicy skiljer tydligt mellan `simple_click`, e-post-OTP, SMS-OTP, BankID och extern e-signering.
- Enkel webbacceptans är uttryckligen låg assurance och visas inte som BankID eller verifierad elektronisk signatur.
- Recipienter har required, role/order, status, provider-ID, assurance och terminala timestamps.
- Ett avtal kan inte bli `signed` förrän alla obligatoriska recipienter är signerade, providerhändelserna är verifierade och slutdokument med SHA-256 finns.
- `mark_acceptance_opened` registrerar första öppning och domänevent atomiskt exakt en gång.
- `finalize_signing_envelope` låser versionen, färdigställer dokumentet och startar post-sign-processen exakt en gång.
- Äldre acceptansflöde får inte längre märka ett avtal som färdigt efter endast första obligatoriska signeraren.

### KX-010 – Databastyper

- Browser-, server-, admin- och proxyklient använder `RuntimeDatabase`-generic.
- `npm run types:verify` stoppar release när den genererade Supabase-typen inte motsvarar migrationerna.
- Efter stagingmigrering ska `npm run types:generate` skriva den verkliga canonical `database.types.ts`.
- Runtime-overlayn är endast en migrationskompatibilitet under utveckling och ersätts automatiskt av exakta genererade typer när snapshoten uppdaterats.

### KX-012, KX-015, KX-016 och KX-018 – Webhookskydd, konfiguration och säkerhet

- Rinkel-käll-IP läses från `x-vercel-forwarded-for` endast när applikationen faktiskt körs i Vercel.
- Utanför Vercel ignoreras `x-real-ip` om inte den egna infrastrukturen uttryckligen markerats som betrodd genom `RINKEL_TRUST_X_REAL_IP=true`; standard är `false`.
- Rinkels dokumenterade käll-IP-adresser finns kvar i allowlisten, samtidigt som endpoint-secret, payloadhash och provider-eventdedupe ger replay-skydd.
- Global avsändare är separerad i `DEFAULT_EMAIL_FROM_NAME` och `DEFAULT_EMAIL_FROM_ADDRESS` och valideras vid startup.
- Noncebaserad CSP och HSTS är införda.
- Det icke-fungerande globala sökfältet är borttaget tills en tenantfiltrerad sökfunktion finns.
- Publik produkttext beskriver central Kundexa-hanterad Rinkel och korrekt signeringsnivå.

### KX-017 – Testgrindar

- Statiska verifieringar täcker migrationer, canonical workers, statusreducerare, signeringsguard, CSP och deploylista.
- SQL-integrationssviten har testfall för trunkerad import, monotona call- och delivery-statusar, Rinkel-event i fel ordning, flera signerare och exakt-en-gång post-sign.
- Importtester täcker radmätning, person/företag och gränsen över 10 000 rader.

## Externa releasegrindar som fortfarande måste köras

Patchen gör kod- och databaskontrakten redo, men systemet ska fortfarande inte klassificeras som produktionsklart förrän dessa miljöberoende bevis är gröna:

1. Kör alla migrationer mot en ren stagingdatabas och mot en produktionslik uppgraderingskopia.
2. Generera om `database.types.ts` från just den stagingdatabasen och kör hela `npm run verify`.
3. Välj faktisk BankID/e-sign-provider, implementera adaptern mot `SigningProvider` och kör providersandbox med dubbla/replayade webhookar.
4. Begär skriftlig bekräftelse från Rinkel om de erbjuder en icke-publicerad HMAC/signatur. Den publicerade guiden beskriver i nuläget IP-allowlist men ingen payloadsignatur; om en signatur finns ska rå body verifieras före parsing.
5. Kör Playwright med riktiga JWT-sessioner, två tenants, RLS, Realtime och privata Storage-buckets.
6. Kör live-Rinkel med riktiga användare, devices och nummer samt event i varierande ordning.
7. Verifiera Resend-domän, bounce, complaint, delayed events och replay.
8. Kör backup/restore, webhook burst, stor import, parallella dialersessioner, lasttest, penetrationstest och rollbackövning.

## Obligatorisk stagingordning

```bash
npm ci
npx supabase@2.109.1 link --project-ref "$SUPABASE_PROJECT_REF"
npm run db:push
SUPABASE_PROJECT_REF="$SUPABASE_PROJECT_REF" npm run types:generate
npm run types:verify
npm run verify
npm run functions:deploy -- --project-ref "$SUPABASE_PROJECT_REF"
```

`npm run types:verify` ska vara röd före type generation om staging ännu inte innehåller migrationen. Den grinden får inte kringgås.

## Releasebeslut

Release till produktion är tillåten först när ovanstående kommandokedja och samtliga externa grindar är dokumenterat gröna. En lyckad statisk kontroll eller lokal build ersätter inte staging-, provider-, RLS-, backup- eller säkerhetsbevis.
