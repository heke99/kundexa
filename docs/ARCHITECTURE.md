# Kanonisk arkitektur

```text
Browser / API client
  -> Next.js BFF/API
     -> Supabase Auth + PostgreSQL/RLS
     -> atomic RPC / transactional outbox
     -> private Storage

Schedulers
  -> process-outbox      -> 46elks / Resend / Storage
  -> automation-runner  -> atomic service queues
  -> data-worker        -> permitted entity refresh
  -> ingestion-worker   -> discovery/crawl/import + checkpoints
  -> maintenance-worker -> segments / dynamic lists / geography / retention
  -> compliance-worker  -> NIX provider + campaign resume
```

## Tenantkontext

1. Session eller hashad API-nyckel identifierar användare och tenant.
2. Servern validerar aktivt medlemskap och scope.
3. Tenant hämtas aldrig från en obetrodd klientparameter som ensam sanningskälla.
4. Tenantägda tabeller har RLS och kanoniskt `tenant_id`.
5. Worker-RPC:er är återkallade från `anon` och `authenticated` och körs med service-role.
6. Providerwebhooks härleder tenant från verifierad callbacktoken, mottagarnummer eller signerad integration.

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

Säljaren startar en `dialer_session`. `claim_next_list_member` prioriterar förfallna personliga/globala återkomster och använder radlås med `SKIP LOCKED`, claim-expiration och sessionsägarskap. `queue_list_outbound_call` återanvänder den kanoniska samtalskön och applicerar listans caller-ID och inspelningspolicy. `complete_dialer_work` kräver en bekräftat avslutad operatörscall och skriver utfall, anteckning, ny återkomst, order, kundlivscykel, liststatus och audit atomiskt innan nästa automatiska samtal får starta.

Den manuella dialern använder samma kundmatchning, kontaktpolicy och outbox. `complete_manual_call_work` ger samma serverkontrollerade efterarbete för enstaka samtal. Globala fristående återkomster tas med ett atomiskt claim; listbundna återkomster tas i listkön.

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
