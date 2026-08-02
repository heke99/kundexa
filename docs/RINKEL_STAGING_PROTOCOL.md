# Rinkel stagingprotokoll

Fyll i datum, utförare, correlation ID/provider-call-ID och evidens för varje rad. Använd endast statusarna `VERIFIED_MOCK`, `VERIFIED_LOCAL_DB`, `VERIFIED_SUPABASE_STAGING`, `VERIFIED_REAL_RINKEL` eller `NOT_RUN`.

| Kontroll | Krav | Status |
|---|---|---|
| Central integrationsrad | Exakt en aktiv kanonisk Rinkel-rad | NOT_RUN |
| API-nyckel | `GET /users` och `GET /numbers` lyckas | NOT_RUN |
| Devicekatalog | Flera devices synkas utan dubbletter; inaktiva syns | NOT_RUN |
| Nummerkatalog | Provider `numberId` och E.164 sparas separat | NOT_RUN |
| Kärnwebhookar | Fyra event registrerade, återlästa och aktiva | NOT_RUN |
| Webhooktest | Test mottaget, HTTP 200 och workerprocessat per event | NOT_RUN |
| Insights | Verifierat eller tydligt `unsupported` utan kärnblockering | NOT_RUN |
| Worker | Heartbeat yngre än tre minuter; atomisk claim | NOT_RUN |
| Lease recovery | Fastnat processing-jobb återställs efter timeout | NOT_RUN |
| Manuell dial | Rätt säljar-device ringer | NOT_RUN |
| Kundsamtal | Rätt destination rings exakt en gång | NOT_RUN |
| Caller-ID | Rätt internt `numberId` och synligt nummer används | NOT_RUN |
| Eventkedja | outgoingCall, callStart, callEnd korreleras till samma samtal | NOT_RUN |
| Timeoutfall | Inget blind-retry; attempt blir osäkert och blockeras | NOT_RUN |
| Definitivt fel | Nytt manuellt försök kan använda ny idempotensnyckel | NOT_RUN |
| Dubblett/fel ordning | Dubbletter och sena event är idempotenta/monotona | NOT_RUN |
| CDR | Call-ID, tider, duration, cause och recording repareras | NOT_RUN |
| CDR-konflikt | Flera kandidater blir öppen konflikt, inte godtycklig match | NOT_RUN |
| Inspelning | Behörig får kortlivad stream; obehörig och tenant B nekas | NOT_RUN |
| Transkribering 204 | `pending_provider`, retry, därefter `not_available` | NOT_RUN |
| Insights utan transkript | Fungerar separat när kontot stöder eventet | NOT_RUN |
| Auto-dialer | Kräver readiness men inte 24 timmars tidigare trafik | NOT_RUN |
| Leadreservation | Två samtidiga säljare kan inte få samma lead | NOT_RUN |
| RLS/två tenants | Tenant A kan inte läsa/ändra tenant B | NOT_RUN |
| Retention/legal hold | Data rensas enligt policy; legal hold skyddar | NOT_RUN |

## Verkligt testsamtal

Spara minst:

- intern `call_id` och `attempt_id`,
- correlation ID från API-svaret,
- Rinkel provider-call-ID,
- vald device och caller-allokering,
- tider för `outgoingCall`, `callStart`, `callEnd`,
- CDR-evidens,
- worker-jobb och heartbeat,
- behörighetsresultat för tenant A och tenant B.

Hemligheter, fullständiga headers och temporära inspelnings-URL:er får inte klistras in i protokollet.
