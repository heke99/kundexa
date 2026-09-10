# Next actions

Uppdaterad 2026-08-07. De lokala stegen 1–5 i förra listan är klara; det som återstår kräver riktig
infrastruktur.

1. Länka en separat Kundexa Supabase staging och kör `npm run db:push` för de tre nya
   migrationerna (`202608070001`–`202608070003`).
2. Kör `npm run types:generate` mot staging och checka in resultatet. Driftkontrollen i
   `verify-sql.mjs` säger exakt vilka namn som skiljer sig om något ändrats.
3. Verifiera FAILURE-0012 mot staging: kör en ParseHub-import med `automatic_commit` och
   bekräfta att den committar i stället för att avbryta på `execution_idempotency_key_required`.
4. Bekräfta att maintenance-workern anropar `prune_rate_limit_counters` i den deployade
   miljön och att `rate_limit_counters` slutar växa.
5. Mät planerna för de nya `updated_at`-indexen mot produktionslik datavolym (`EXPLAIN ANALYZE`
   på kundlistan och avtalstavlan) och bekräfta att sorteringen använder index.
6. Sätt centrala Rinkel-secrets i Vercel och Supabase Edge Secrets; deploya samtliga Edge
   Functions.
7. Synka/allokera Rinkel user/device/number och registrera de fem webhookarna.
8. Kör stagingprotokollet för dial, inkommande, webhookordning/dublett, CDR, recording,
   transcript och Insights.
9. Kör tvåtenant-RLS/recording access med riktiga JWT-sessioner.
10. Godkänn juridik, retention, backup/restore, last och extern säkerhet före produktion.

## 2026-08-08 — deployordning för remediation

1. Applicera forward-only migration `202608080001_cross_surface_consistency_remediation.sql` på staging.
2. Kör `npm ci`, `npm run types:verify` och därefter hela `npm run verify` på Node 22 med Deno installerat.
3. Kör tvåtenant JWT/RLS-proven särskilt för `/app/platform` och `/app/platform/lists` med
   owner/admin/support/auditor.
4. Sätt/verifiera `RINKEL_API_KEY` i webbruntime och worker-runtime, synka katalogen och kontrollera
   `GET /api/v1/telephony/status` tills `runtimeConfigured=true` och inga blockers återstår.
5. Genomför ett verkligt utgående Rinkel-samtal och verifiera call attempt -> webhook -> CDR -> recording.
6. Genomför Resend bounce/complaint replay och 46elks SMS delivery/reconciliation på staging.
7. Välj och implementera konkret BankID/e-sign-provider om högre assurance än simple acceptance krävs.

## 2026-08-08 — immediate database follow-up

1. Sync `202608080002_database_lint_runtime_hardening.sql` into the repo and dry-run `db push`.
2. Confirm dry-run lists only `202608080002`, then push it.
3. Run `npm run types:generate && npm run verify`.
4. Run hosted DB lint again and confirm no Kundexa-owned function errors remain.
5. Treat PostGIS extension-owned diagnostics separately from the application lint gate.

## 2026-08-08 — platform auth deployment

1. Overlay the platform-auth patch on the current repo and run `npm ci && npm run verify` in the normal Node 22/Deno environment.
2. No database migration is required for this patch; existing platform RLS/RPC contracts are reused.
3. Deploy the web app, sign out/in as `platform_owner`, and test `/app/platform` plus `/app/platform/telephony` with no active tenant requirement.
4. Test switching from the platform shell into an existing active tenant and back to the platform control-plane.
5. Run owner/admin/auditor/support negative authorization checks before live Rinkel provider testing.

## 2026-08-10 — Rinkel device mapping rollout

1. Dry-run the linked Supabase push and confirm only the new forward-only device hardening migration is pending.
2. Apply the migration, run `npm run types:generate`, then run the complete `npm run verify` in the normal project environment.
3. Deploy the web code, open `/app/platform/telephony`, and run `Synkronisera katalog`.
4. Confirm the intended Rinkel user shows one or more active devices before allocating that user to a tenant.
5. Open the tenant `/app/integrations`; map Kundexa seller -> allocated Rinkel user -> active device -> allocated number.
6. Make one real manual `/dial` call. If provider responds `Device or number not found`, inspect the synchronized provider ids rather than changing ids manually.

## 2026-09-07 — aktivera utringning

1. Logga in i Rinkels webbtelefon eller mobilapp som `hekmat.h@gridex.se`. Det är det enda som
   skapar ett `deviceId` på leverantörens användarobjekt.
2. Öppna `/app/platform/telephony` och kör `Synkronisera katalog`. Användaren ska gå från
   "väntar på enhet" till "ringklar".
3. Tilldela numret i kortet **Tilldela telefonnummer**: välj nummer, välj bolag/team/säljare,
   klicka `Tilldela och aktivera`. Kvittensen säger hur många säljare som blev ringklara och vad
   som ev. saknas.
4. Om säljarens Kundexa-adress skiljer sig från adressen hos Rinkel (som i dag:
   `hekmat.h@div3rsa.com` mot `hekmat.h@gridex.se`), välj säljarscope och peka ut telefoni-
   användaren explicit i formuläret.
5. Ring ett riktigt samtal och verifiera kedjan call attempt → `outgoingCall` → `callStart` →
   `callEnd` → CDR → recording.
6. Undersök varför `callStart` och `callInsights` aldrig kvitterats medan de tre andra
   webhookarna svarar 200.

## Uppdatering 2026-09-10 (efter edge-deployen)

Verifierat läge i produktion (`lhvifuxcqghtbiulzkrf`), mätt direkt mot databasen:
0 dead-letter-jobb, 0 öppna outbox-jobb, 0 fastnade dial-försök, alla sju workers
med livstecken `healthy`.

Kvar innan systemet kan användas skarpt, i den ordning som låser upp mest:

1. **Deploya `process-outbox`** — `npm run functions:deploy -- --project-ref lhvifuxcqghtbiulzkrf`.
   Den kör fortfarande kod från 2026-08-08: FAILURE-0044 (bevispaket rapporterar
   noll e-post), bevismanifest v2 utan generationsbindning och generationslösa
   signeringsbekräftelser. Skriptet deployar alla åtta funktionerna; de sju andra
   är redan i fas, så det blir en no-op för dem.
2. **Deploya webbappen från grenen.** Det aktiverar `testWebhook(event, url)`,
   som är förutsättningen för att verifiera `outgoingCall` och `callStart` — de
   är fortfarande bara `registered`, och utan dem fungerar inte automatisk
   uppringning. Samma deploy tar med dialer-loopen, kundkortets kontaktpersoner,
   importens innehållstyp och knappen för omutskick av utgånget avtal.
3. **Verifiera `outgoingCall` och `callStart`** i integrationsvyn när (2) är ute.
   `callEnd` och `incomingCall` är redan `verified`.
4. **Koppla och aktivera Resend.** 0 aktiva tenantintegrationer och `outbound_email`
   är av för samtliga tenants — inget avtal kan mejlas ut som läget är.
5. **Publicera en avtalsmall.** Enda versionen är `draft`, och
   `assert_contract_sendable_v2` kräver en publicerad mall — inget avtal kan skapas.
6. **Sätt NIX-läge** (`nix_screening_mode` → `provider_check`) innan B2C-uppringning.
7. **Lägg upp säljare, listor och produkter.** 1 aktiv medlem, 0 listor, 0 produkter.
8. **Slå på Leaked Password Protection** i Supabase Auth — enda kvarvarande
   säkerhetsvarningen som inte är en PostGIS-artefakt.

Övriga rådgivarvarningar är genomgångna och avfärdade som förväntade:
`spatial_ref_sys` och `st_estimatedextent` ägs av PostGIS, `citext`/`pg_trgm`/`postgis`
ligger i `public` sedan Supabase installerade dem, de 115 SECURITY DEFINER-RPC:erna
mot `authenticated` är arkitekturen (tenant härleds inne i funktionen), och
`platform_*`-tabellerna har RLS på utan policies med flit — det betyder noll åtkomst
för alla utom `service_role`.

Observerad lucka utan åtgärd ännu: **`process-outbox` skriver inget livstecken.**
Den är den enda kritiska workern utan rad i `platform_worker_heartbeats`, så en
tyst död där syns inte i övervakningen.

## Uppdatering 2026-09-10 (NIX på kundkortet, teamledarens mallar)

Rättelse mot punkt 6 ovan: **NIX-läget behöver inte sättas.** Gridex, den tenant
som används, har redan `nix_screening_mode = 'pre_screened_source'` och en
dokumenterad rättslig grund. Trustcall har noll medlemmar och noll kunder och står
kvar på det strikta standardläget, vilket är rätt för en oanvänd tenant. Stryk den
punkten.

Kvarstår i oförändrad ordning: deploya `process-outbox` (numera enklast genom att
lägga in `SUPABASE_ACCESS_TOKEN` och `SUPABASE_PROJECT_REF` som repository-secrets,
så sköter `deploy-edge-functions.yml` det vid varje push), verifiera `outgoingCall`
och `callStart` i integrationsvyn, koppla Resend, publicera en avtalsmall, lägga upp
säljare/listor/produkter och slå på Leaked Password Protection.

Att publicera en avtalsmall är nu lättare: en teamledare kan ladda upp avtalet från
Word och markera var kunduppgifterna ska in, och en ägare godkänner versionen.
