# Kundexa — Rinkel hardening 2026-08-02

## Levererad förändring

Den befintliga centrala Rinkel-arkitekturen har behållits som enda kanoniska voice-flöde. Patchen härdar de delar som saknades för robust produktion:

- providerstatus, providerutfall och CRM-disposition är separata,
- nya/okända Rinkel-cause-värden stoppar inte webhookflödet,
- inkommande samtal matchas endast inom tenant som äger mottagande nummer och endast vid entydig träff,
- `callEnd` skapar idempotent inspelningsreferens,
- CDR-jobbet reparerar faktiskt samtal, attempts, tider, duration, cause, utfall och recording,
- flera CDR-kandidater blir konflikt i stället för godtycklig korrelation,
- dokumenterade Rinkel-IP:n finns som servervaliderad miljövariabel,
- generated-schema-verifieringen kräver den nya kolumnen och RPC:n.

## Databasmigration

```text
supabase/migrations/202608020001_rinkel_lifecycle_reconciliation_hardening.sql
```

Migrationen är framåtriktad och ändrar inte tidigare körda migrationer. Den:

1. lägger till `calls.provider_outcome`, backfillar Rinkel-data och sätter constraints/index,
2. bevarar monotona terminalstatusar även med den nya providerprojektionen,
3. deduplicerar aktiva recordingrader och inför ett partiellt unikt index,
4. ersätter Rinkel-korrelations-/eventfunktionerna med tenant- och idempotenshärdade versioner,
5. lägger till service-role-RPC:n `reconcile_rinkel_call_from_cdr`,
6. uppdaterar dialfinalisering för `requested`, `failed` och osäkert `unknown` utfall,
7. återkallar `EXECUTE` från `PUBLIC`, `anon` och `authenticated` på privilegierade RPC:er.

## Obligatorisk synkordning

Kör från projektroten mot en separat länkad stagingdatabas:

```bash
node --version
npm --version
npm ci
npm run supabase:login
npm run supabase:link -- --project-ref <STAGING_PROJECT_REF>
npm run db:push
npm run types:generate
npm run types:verify
npm run lint
npm run typecheck:edge
npm run test
npm run build
npm run verify
npm run functions:deploy
```

Sätt därefter samma logiska centrala Rinkel-nyckel i Vercel och Supabase Edge Secrets, men aldrig i en `NEXT_PUBLIC_*`-variabel.

## Miljö

```dotenv
RINKEL_API_KEY=<CENTRAL_SECRET>
RINKEL_API_BASE_URL=https://api.rinkel.com/v1
RINKEL_WEBHOOK_PUBLIC_BASE_URL=https://app.kundexa.se
RINKEL_WEBHOOK_SECRET=<MINST_40_SLUMPMASSIGA_TECKEN>
RINKEL_WEBHOOK_ALLOWED_IPS=82.199.77.220,188.122.73.177
RINKEL_REQUEST_TIMEOUT_MS=15000
RINKEL_ENFORCE_WEBHOOK_IP_ALLOWLIST=true
RINKEL_TRUST_X_REAL_IP=false
RINKEL_RECONCILIATION_ENABLED=true
CRON_SECRET=<SECRET>
```

## Stagingprotokoll

1. Synka centrala användare och nummer som plattformssuperadmin.
2. Allokera en användare/device och ett nummer till testtenant.
3. Skapa säljarens tenantmappning och aktivera telephony policy.
4. Registrera/testa `incomingCall`, `outgoingCall`, `callStart`, `callEnd` och vid stöd `callInsights`.
5. Kör ett besvarat samtal, ett obesvarat samtal och ett timeout/osäkert dialutfall.
6. Verifiera samma provider-call-ID i webhook, Kundexa och CDR.
7. Verifiera recordingstream, senare transcript och CDR-reparation.
8. Skapa samma inkommande telefonnummer på två kunder i samma tenant och verifiera att automatisk kundkoppling uteblir.
9. Skapa samma nummer i en annan tenant och verifiera att det aldrig påverkar den ägande tenantens matchning.
10. Kör tvåtenant-RLS/recording-access med riktiga JWT-sessioner.

Punkter som kräver riktiga credentials, länkad Supabase staging eller riktiga samtal är fortfarande externa gates och får inte markeras som godkända av den lokala patchen.
