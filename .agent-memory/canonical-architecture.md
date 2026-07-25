# Canonical architecture

```text
Browser/API
  -> Next.js BFF och v1-API
  -> Supabase Auth + PostgreSQL/RLS
  -> atomiska RPC:er + transactional outbox
  -> privat Supabase Storage

Schemaläggare
  -> process-outbox
  -> automation-runner
  -> data-worker
  -> ingestion-worker
  -> maintenance-worker
  -> compliance-worker
  -> parsehub-worker
```

Kanoniska principer:

- Session eller hashad API-nyckel identifierar aktör och tenant.
- Klientens tenant-ID är aldrig ensam sanningskälla.
- Vanlig sessionklient behåller RLS; service-role används bara i workers, verifierade callbacks och uttryckliga serverflöden.
- Extern råpayload sparas före parsing; normaliserade fakta får provenance, historik, freshness och konfliktstatus.
- CRM, kommunikation och avtal är tenantunika. Katalogen är central men exponeras genom licens- och tenantprojektion.
- Affärshändelser och outboxjobb skapas atomiskt; workers claimar idempotent.

Utförlig kanonisk beskrivning finns i `docs/ARCHITECTURE.md`.
