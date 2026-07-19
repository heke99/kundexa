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
  -> maintenance-worker -> segments / geography / retention
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

### Geografi

Ett versionsstyrt referensregister normaliserar kommun, län, postort/postnummer och koordinater. Radiesökning använder PostGIS när extensionen finns, annars en Haversine-fallback.

### Retention och DSAR

Retentionworker tar hänsyn till leverantörens lagringsrätt, tenantpolicy och legal hold. DSAR-flödet stödjer registrering, identitetsverifiering, export, restriction och kontrollerad radering/anonymisering. Minimal suppression-information kan behållas för att förhindra återimport och ny direktmarknadsföring.

## Datakonsistens

- Affärstransaktionen skapar affärsobjekt och outboxjobb atomiskt.
- Workers claimar jobb med lås och atomiska RPC:er.
- Idempotensnycklar hindrar dubbla utskick, samtal, automationer, NIX- och berikningsjobb.
- Kontaktpolicy och usage-reservation ligger i databasen så UI, API och workers använder samma regler.
- Godkända avtals-, produkt-, pris- och juridikversioner snapshotas; accepterade versioner är immutable.
