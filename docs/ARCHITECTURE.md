# Kanonisk arkitektur

Aktuell implementation och öppna avvikelser: docs/reviews/2026-11-16/remediation-status.md. Nedanstående domänbeskrivningar är målkontrakt; de är inte ett driftgodkännande. Aktuell telefoni är Sinch och signering sker i Kundexas native-motor med utvalda portade DocuSeal-delar, inte en extern DocuSeal-server. Bevisade brister och återstående verifiering anges i system-audit.md.

```text
Browser / API client
  -> Next.js BFF/API
     -> Supabase Auth + PostgreSQL/RLS
     -> atomic RPC / transactional outbox
     -> private Storage

Schedulers
  -> process-outbox      -> SMS-porten / Resend / private Storage
  -> automation-runner  -> atomic service queues
  -> data-worker        -> permitted entity refresh
  -> ingestion-worker   -> discovery/crawl/import + checkpoints
  -> maintenance-worker -> segments / dynamic lists / geography / retention
  -> compliance-worker  -> NIX provider + campaign resume
  -> parsehub-worker    -> ParseHub runs / webhook-safe imports
```

## Tenantkontext

1. Session eller hashad API-nyckel identifierar användare och tenant.
2. Servern validerar aktivt medlemskap och scope.
3. Tenant hämtas aldrig från en obetrodd klientparameter som ensam sanningskälla.
4. Tenantägda tabeller har RLS och kanoniskt `tenant_id`.
5. Worker-RPC:er och tenantparametrerade katalogprojektioner är återkallade från `anon` och `authenticated` och körs med service-role.
6. Providerwebhooks härleder tenant från verifierad callbacktoken, mottagarnummer eller signerad integration.

Autentiserad segmentrefresh och kampanjmaterialisering använder wrappers som härleder aktiv tenant och kontrollerar roll. Serviceflöden använder explicita `*_for_tenant`-funktioner som korsvaliderar tenant mot segment och kampanj.

## Datadomäner

### Tenantunik CRM-data

Kunder, anteckningar, aktiviteter, kampanjer, affärer, avtal, samtal, meddelanden, invändningar och interna statusar är strikt tenantunika.

### Central katalog och licensprojektion

`master_entities` håller normaliserade sökfält. Extern information sparas först som råpayload och `source_facts`. Resolvern skapar fältvärden, provenance, history, conflicts och freshness.

Licensmodellen skiljer uttryckligen mellan:

- `may_store`: Kundexa får lagra källvärdet.
- `may_filter`: värdet får användas i lokal segmentering/sökning.
- `may_display`: värdet får visas för den aktuella tenanten.

Sökning kan därför använda ett tillåtet filter utan att API eller UI exponerar ett fält som inte får visas.

### Ingestion och discovery

```text
scheduler/manual request
  -> permission/quota check
  -> ingestion job/run
  -> atomic claim
  -> provider fetch
  -> encrypted raw payload saved before parsing
  -> parser/fingerprint/disappearance checks
  -> normalization + identity matching
  -> source facts + master resolution
  -> checkpoint + report + next_run_at
```

Ingestion kan fortsätta från kontrollpunkt, respekterar providergränser och sätter avvikande parsning i karantän i stället för att radera befintliga värden.

### Segment och kampanj

Alla avancerade filter använder samma databasfunktion. Dynamiska segment materialiseras till snapshots och memberships. Överföring till kampanj skapar tenantkoppling och kör central kontaktpolicy. Privatpersoner som kräver NIX stannar i `pending_nix` tills compliance-workern registrerat ett giltigt resultat.

### Prospektering, listor och dialer

`customers` är det enda kanoniska kund-/prospektkortet. `customer_list_members` anger endast att kunden ska bearbetas i en lista och lagrar köstatus, försök, utfall och tidsbegränsat claim. Samtal ligger alltid i `calls`, återkomster i `activities`, anteckningar i `notes` och order i `sales_orders`/`sales_order_items`.

Ett sparat katalogsegment materialiseras genom `materialize_segment_to_customer_list`. Befintliga `tenant_entities` återanvänds, nya kundkort skapas bara när en katalogpost saknar tenantkoppling och varje kandidat körs genom samma kontakt-/NIX-policy som övriga kanaler. Compliance-workern frisläpper godkända `pending_nix`-kandidater. Maintenance-workern håller aktiva dynamiska listor synkroniserade med nya segmentsnapshots utan att radera redan bearbetad historik.

Säljaren startar en `dialer_session`. `claim_next_list_member` prioriterar förfallna personliga/globala återkomster och använder radlås med `SKIP LOCKED`, claim-expiration och sessionsägarskap. `reserve_outbound_call` skapar samtal och försök atomiskt, väljer företagets A-nummer, prövar ringtider och kontaktpolicy och låser säljarens plats mot samtidiga samtal. Därefter ringer webbläsarens webbtelefon upp; servern kopplar aldrig själv. Leverantörens webhookar är sanningskälla för samtalsförloppet, och ett okänt utfall stängs inte som misslyckat. `complete_dialer_work_v2` kräver en bekräftat avslutad operatörscall och skriver utfall, anteckning, ny återkomst, order, kundlivscykel, liststatus och audit atomiskt innan nästa automatiska samtal får starta.

Den manuella dialern använder samma reservation, kundmatchning och kontaktpolicy. `complete_manual_call_work_v2` ger samma serverkontrollerade efterarbete för enstaka samtal. Globala fristående återkomster tas med ett atomiskt claim; listbundna återkomster tas i listkön. Äldre leverantörsspecifika RPC:er är borttagna ur schemat och historiska jobb dead-letteras utan provideranrop.

### Geografi

Ett versionsstyrt referensregister normaliserar kommun, län, postort/postnummer och koordinater. Radiesökning använder PostGIS när extensionen finns, annars en Haversine-fallback.

### Retention och DSAR

Retentionworker tar hänsyn till leverantörens lagringsrätt, tenantpolicy och legal hold. DSAR-flödet stödjer registrering, identitetsverifiering, export, restriction och kontrollerad radering/anonymisering. Minimal suppression-information kan behållas för att förhindra återimport och ny direktmarknadsföring.

## Datakonsistens

- Affärstransaktionen skapar affärsobjekt och outboxjobb atomiskt.
- Workers claimar jobb med lås och atomiska RPC:er.
- Idempotensnycklar hindrar dubbla utskick, samtal, automationer, NIX- och berikningsjobb.
- Kontaktpolicy och usage-reservation ligger i databasen så UI, API och workers använder samma regler.
- Automatiskt nästa samtal är spärrat tills providerhangup och efterarbete är sparade; paus/avslut släpper både prospekt- och återkomstlås.
- Supabase Realtime publicerar kanoniska samtals-, återkomst-, list- och ordertabeller; UI uppdaterar berörda vyer och badges utan att duplicera tillståndet.
- Godkända avtals-, produkt-, pris- och juridikversioner snapshotas; accepterade versioner är immutable.

## 2026-11-16 – implementerade granskningsgränser, ej driftsatta

Kunduppdatering och fältnamnsbaserad audit är atomiska via DB-trigger. Plattformsimport bevarar hela kontaktmängden och ursprungsrader; en tenantbunden tilldelning materialiserar kontakterna till kanoniska contact_people. Ommappning har CAS, validating-status, försökstoken och fullständig radräkning före publicering. SMS har en service-only submissionsgrind för aktuell worker/lease/försök; osäker effekt får endast avstämmas. Retention får inte märka en fysisk blob som raderad genom att glömma dess locator.

Öppna arkitekturgränser: DNS/egress för utgående webhooks, end-to-end generationsfäktning av ingestion samt beständig bucketbunden fysisk råfilsgallring. Se docs/reviews/2026-11-16/remaining32-and-architecture.md. Inga nya parallella kundlager införs.

## Paket5 – kommandogränser och nätverksgräns, ej driftsatt

Detta ersätter föregående pakets öppna kodgränser19/25/44/46/52. Ingestion och ParseHub utför sina DB-effekter genom service-only kommandon som låser och verifierar aktuell worker/försök/generation/lease i samma transaktion. Återtag efter krasch kräver ny generation och återstående budget. Äldre oskyddade worker-RPC:er är återkallade; gamla arbetare ska tömmas före installation.

Fysisk råfilsgallring använder privat, tenantbundet bucketkontrakt, beständig avsikt, Storage-radering och därefter DB-kvittens. En okänd locator rensas inte bort. Bevarandespärrar och deletionens beslut om extern effekt serialiseras; osäkra effekter behöver avstämning.

Admin-MFA finns i app, sessions-API, restriktiv RLS och centrala behörighetshjälpare. Worker-/maskinkontext är separat. Webhooks ansluter till validerad publik IP med certifikatkontroll för originalvärden; Edge använder native Deno TCP/startTls och verifierar handshake före payload. Node-kompatibla transportantaganden räckte inte i äldre runtimeprov. Se docs/reviews/2026-11-16/batch5-14-findings.md för bevis och återstående produktionsgrindar.
