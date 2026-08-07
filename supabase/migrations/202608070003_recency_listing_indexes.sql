begin;

-- KX-012: several tenant-scoped listings order by `updated_at desc` (recency of change)
-- while every existing covering index is on `created_at desc`. Postgres can use neither for
-- the sort, so each of these listings degrades into a full tenant scan plus an external
-- sort, on exactly the screens a seller loads most often:
--
--   * `GET /api/v1/customers` and the list-detail picker order customers by `updated_at`;
--   * the contracts board orders 500 contracts by `updated_at`;
--   * the compliance board orders campaign candidates by `updated_at`.
--
-- Each index mirrors the query's filter predicate so it stays usable for the sort, including
-- the soft-delete predicate where the table has one.

create index if not exists customers_tenant_updated_idx
  on public.customers(tenant_id,updated_at desc)
  where deleted_at is null;

create index if not exists contracts_tenant_updated_idx
  on public.contracts(tenant_id,updated_at desc);

create index if not exists campaign_contact_candidates_tenant_updated_idx
  on public.campaign_contact_candidates(tenant_id,updated_at desc);

commit;
