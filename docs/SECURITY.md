# Säkerhetsmodell

## Databas och tenantisolering

- RLS är aktiverat på tenantägda tabeller.
- Tenant härleds från session/API-nyckel och verifierat medlemskap.
- Vanliga sessionanrop använder användarens Supabase-klient och behåller RLS.
- Service-role begränsas till workers, providerwebhooks och uttryckliga adminflöden.
- Worker-RPC:er är återkallade från `anon` och `authenticated`.
- `SECURITY DEFINER`-funktioner använder explicit `search_path`.

## Kommunikation och compliance

- SMS, e-post och samtal skapas genom atomiska databasfunktioner.
- Central kontaktpolicy kontrollerar feature, intern spärr, kanalspärr, rättslig grund, ringtid och NIX precis före köläggning.
- Usage reserveras i samma transaktion, vilket förhindrar race conditions och dubbel debitering.
- Idempotens hindrar dubbla utskick och dubbla NIX-/providerjobb.
- NIX-resultat har separat TTL; kampanjmedlemskap återupptas endast efter godkänt giltigt resultat.

## Dataleverantörer och katalog

- Providercredentials och tillåten råpayload krypteras med AES-GCM.
- Tillstånd styr entity types, ändamål, fält, domäner, paths, lagring, filtrering, visning, cache, export, attribution, giltighet och kvot.
- Råpayload sparas före parsern så även parserfel kan granskas.
- Workers kräver HTTPS, blockerar privata nät, credentials i URL och otillåtna redirects.
- Atomic claim reserverar concurrency, kvot, idempotens och refresh-lås före externt anrop.
- Fingerprint-/fältbortfallsavvikelse kan sätta körning och parser i karantän.
- API/UI får endast licensprojekterade `may_display`-fält; `may_filter` kan användas lokalt utan exponering.

## Importer

- Importformat valideras och filstorlek begränsas.
- Produktionsimport kräver lyckad extern malware-scan när `REQUIRE_IMPORT_MALWARE_SCAN=true`.
- Import commit synkroniserar CRM och tenantisolerad katalog genom databasfunktion i stället för fristående skrivningar.

## Personuppgifter, retention och DSAR

- Retention tar hänsyn till providerpermission, tenantpolicy och legal hold.
- DSAR export/radering kräver verifierad begäran och audit event.
- Kontrollerad anonymisering tar bort CRM-identitet och tenantunik katalogdata men kan behålla minimal suppression-post för att förhindra ny direktmarknadsföring.
- Compliance-exporter lagras i privat bucket.

## Hemligheter och integrationer

- API-nycklar lagras hashade och visas endast vid skapandet.
- Webhookhemligheter och callbacktokens lagras krypterat eller hashat.
- Service-role och krypteringsnycklar får aldrig finnas i klientkod eller repository.
- Utgående webhooks kräver publik HTTPS, blockerar privata nät och signeras med HMAC-SHA256.

## Dokument och bevis

- Endast godkända avtalsmallversioner får skapa skarpa utkast.
- Juridisk avsändare, produkt, pris, villkor och mall snapshotas atomiskt.
- Låsta/signerade versioner är immutable.
- Dokument och bevis använder SHA-256; acceptfraser matchas exakt.

## Återstående produktionskontroller

- Tvåtenant-penetrationstest och extern SAST/DAST.
- Skarp scanner, NIX- och dataprovider verifierade i staging.
- MFA-enforcement och administrativ recoveryprocess.
- Backup/restore med RTO/RPO.
- SIEM/larm, nyckelrotation, DPIA, biträdesavtal och livecallbackverifiering.
