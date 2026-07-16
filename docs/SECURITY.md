# Säkerhetsmodell

## Databas och tenantisolering

- RLS är aktiverat på tenantägda tabeller.
- Tenant härleds från aktiv session/API-nyckel och verifierat medlemskap.
- Vanliga sessionanrop använder användarens Supabase-klient och behåller RLS.
- Service-role är begränsad till workers, providerwebhooks och uttryckliga adminflöden.
- Worker-RPC:er är återkallade från `anon`/`authenticated`.
- `SECURITY DEFINER`-funktioner använder explicit `search_path`.

## Kommunikation och compliance

- SMS, e-post och samtal skapas genom atomiska databasfunktioner.
- Central kontaktpolicy kontrollerar tenantfunktion, intern spärr, kanalspärr, rättslig grund, tillåtna tider och NIX-freshness precis före köläggning.
- Usage reserveras i samma transaktion som meddelandet/samtalet, vilket förhindrar race conditions och dubbel debitering.
- Idempotensnycklar hindrar dubbla utskick vid retry.
- Automationer och avtalsbekräftelser använder samma serviceköer som manuella/API-startade åtgärder.

## Dataleverantörer

- Providercredentials och tillåten råpayload krypteras med AES-GCM.
- Tillstånd styr entity types, ändamål, fält, domäner, paths, lagring, cache, export, attribution, giltighet och kvot.
- Data-workern kräver HTTPS, blockerar lokala/private nät, credentials i URL och automatiska redirects.
- Atomic claim reserverar concurrency, kvot och refresh-lås innan externt anrop.
- Parseravvikelse kan sätta jobb i karantän i stället för att radera befintliga mastervärden.

## Hemligheter och integrationer

- API-nycklar lagras hashade och visas bara vid skapandet.
- Webhookhemligheter och callbacktokens lagras krypterat/hashat.
- Service-role och krypteringsnycklar får aldrig finnas i klientkod eller repository.
- Utgående webhooks kräver publik HTTPS, blockerar privata nät och signeras med HMAC-SHA256.

## Dokument och bevis

- Endast godkända avtalsmallversioner får skapa skarpa avtalsutkast.
- Juridisk avsändare, produkt, pris, villkor och mall snapshotas atomiskt.
- Låsta/signerade versioner är immutable.
- Dokument och bevis använder SHA-256; acceptfraser matchas exakt.
- Accept, elektronisk signatur och aktivering är separata statusar.

## Återstående arbete före produktion

- Tvåtenant-penetrationstest och extern SAST/DAST.
- Malware scanning av PDF, CSV och övriga uppladdningar.
- MFA-enforcement och administrativ recoveryprocess.
- Full backup/restore-övning med RTO/RPO.
- SIEM/larm och regelbunden nyckelrotation.
- DPIA, biträdesavtal, juridiskt fastställd retention och liveverifiering av leverantörscallbacks.
