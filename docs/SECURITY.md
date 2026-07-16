# Säkerhetsmodell

## Databas

- RLS är aktiverat och tvingat på tenantägda tabeller.
- Tenant härleds från aktivt medlemskap eller från API-nyckelns tenant.
- Sammansatta foreign keys stoppar kopplingar mellan tenants.
- `tenant_id` kan inte ändras efter insert.
- Vanliga sessionbaserade API-anrop använder användarens Supabase-klient och behåller RLS.
- Service-role är begränsad till workers, providerwebhooks och uttryckliga adminflöden.
- Worker-RPC:er är återkallade från anon/authenticated och endast tillåtna för service-role.

## Hemligheter

- Providercredentials krypteras med AES-256-GCM.
- API-nycklar lagras som SHA-256-hash och visas bara vid skapandet.
- Webhookhemligheter och callbacktokens visas en gång och lagras krypterat/hashat.
- Service-role och krypteringsnycklar får aldrig finnas i klientkod eller repository.

## Kommunikation

- SMS, e-post och samtal går via transaktionell outbox.
- Provider-ID och idempotency keys hindrar dubbla utskick vid retry.
- Spärrmotor kontrolleras före manuella och automatiserade kanalåtgärder.
- Caller ID och avsändarnummer väljs från tenantens registrerade nummer.
- Utgående webhooks kräver publik HTTPS, blockerar lokala/private nät och signeras med HMAC-SHA256.

## Dokument och bevis

- Avtalsversioner blir immutable efter låsning.
- Dokument och bevis använder SHA-256.
- Storage är privat och paths är tenantbundna.
- Acceptfraser matchas exakt; AI/fuzzy matching används inte för juridiska beslut.
- Accept, elektronisk signatur och aktivering är separata statusar.

## Återstående säkerhetsarbete före produktion

- Extern penetrationstest och SAST/DAST i CI.
- Malware/antivirus-scanning av PDF, CSV och övriga uppladdningar.
- MFA-enforcement och administrativ återställningsprocess.
- Full backup/restore-övning och dokumenterad RTO/RPO.
- SIEM/export av audit- och security events.
- Regelbunden nyckelrotation.
- DPIA, personuppgiftsbiträdesavtal och juridiskt fastställda retentionperioder.
