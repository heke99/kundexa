# Canonical architecture

```text
Browser -> Kundexa Web (BFF) -> Kundexa API -> PostgreSQL
                                      |       -> transactional outbox
                                      |       -> Redis rate limits
                                      |       -> private S3 storage
                                      -> 46elks / SMTP through adapters
Worker (separate DB role with BYPASSRLS) -> claims outbox jobs -> providers/storage
```

## Tenant context

1. Access token identifies user and selected membership.
2. API validates active membership against PostgreSQL.
3. API starts a transaction and calls `set_config('app.user_id', ...)` and `set_config('app.tenant_id', ...)`.
4. Every tenant-owned table has forced RLS and a single canonical `tenant_id`.
5. Provider webhooks derive tenant from an opaque route token and receiving number, never from a client-submitted tenant id.

## Database ownership

- `kundexa_owner`: migrations only.
- `kundexa_app`: API; cannot bypass RLS.
- `kundexa_worker`: background processing; BYPASSRLS and isolated credentials.

## Data consistency

Provider submission is never performed inside the HTTP request's business transaction. The transaction stores the business entity and an outbox job atomically. A worker claims the job with `FOR UPDATE SKIP LOCKED`, submits to the provider, and records the provider ID and events idempotently.
