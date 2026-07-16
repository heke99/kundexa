# Kanonisk arkitektur

```text
Browser
  -> Next.js BFF/API
     -> Supabase Auth + PostgreSQL/RLS
     -> transactional outbox / atomic RPC
     -> private Storage

Schedulers
  -> process-outbox      -> 46elks / Resend / Storage
  -> automation-runner  -> atomic service queues
  -> data-worker        -> permitted provider APIs
```

## Tenantkontext

1. Session eller hashad API-nyckel identifierar användare och tenant.
2. Servern validerar aktivt medlemskap och scope.
3. Tenant hämtas aldrig från en obetrodd klientparameter som ensam sanningskälla.
4. Tenantägda tabeller har RLS och kanoniskt `tenant_id`.
5. Worker-RPC:er är spärrade för `anon` och `authenticated` och körs endast med service-role.
6. Providerwebhooks härleder tenant från opaque callbacktoken och registrerat mottagarnummer.

## Datadomäner

### Tenantunik CRM-data

Kunder, anteckningar, aktiviteter, kampanjer, affärer, avtal, samtal, meddelanden och interna statusar är strikt tenantunika.

### Central katalog och provenance

`master_entities` håller sökbara mastervärden. Extern data går först till råpayload och `source_facts`; resolvern uppdaterar därefter fältvärden och historik. Freshness och licens-/cacheomfattning avgör om data får återanvändas eller behöver uppdateras.

### Provider- och berikningsflöde

```text
Local search -> freshness check -> enrichment job -> atomic claim/lock/quota
-> provider adapter -> encrypted raw payload -> normalized facts
-> field history/master update -> usage/audit
```

Providerkonfigurationen innehåller tillåtna domäner, paths, fält, ändamål, cacheomfattning, lagringsrätt, kostnad och kvoter. Den generiska adaptern accepterar bara HTTPS och blockerar privata nät, credentials i URL och otillåtna redirects.

## Datakonsistens

- Affärstransaktionen skapar affärsobjekt och outboxjobb atomiskt.
- Workers claimar jobb med databaslås/atomiska RPC:er.
- Idempotensnycklar hindrar dubbla SMS, e-post, samtal, automationer och berikningar.
- Kontaktpolicy och usage-reservation ligger i databasen så UI, API och workers använder samma regler.
- Godkända avtals-, produkt-, pris- och juridikversioner snapshotas; accepterade versioner är immutable.
