begin;

-- KX-011: `consume_rate_limit` upserts one row per (tenant, bucket, fixed window) on every
-- authenticated API request, and nothing has ever deleted those rows. A tenant with 50
-- active sellers produces ~50 rows per minute, so the table grows by tens of millions of
-- rows per year. That table is on the hot path of *every* authenticated request, so the
-- bloat degrades the exact upsert that gates the whole API.
--
-- Counters are only ever read for the current window, so anything older than a couple of
-- windows is dead weight. The delete is bounded by `p_limit` so a maintenance run can never
-- take a long lock or a runaway transaction on a table that request handlers are writing to.

create index if not exists rate_limit_counters_window_idx
  on public.rate_limit_counters(window_started_at);

create or replace function public.prune_rate_limit_counters(
  p_older_than interval default interval '1 hour',
  p_limit integer default 10000
) returns integer
language plpgsql
security definer
set search_path=public
as $$
declare
  v_deleted integer;
  v_cutoff timestamptz:=now()-greatest(p_older_than,interval '5 minutes');
begin
  with doomed as (
    select tenant_id,bucket_key,window_started_at
    from public.rate_limit_counters
    where window_started_at<v_cutoff
    order by window_started_at
    limit greatest(1,least(coalesce(p_limit,10000),100000))
    for update skip locked
  )
  delete from public.rate_limit_counters c
  using doomed d
  where c.tenant_id=d.tenant_id
    and c.bucket_key=d.bucket_key
    and c.window_started_at=d.window_started_at;
  get diagnostics v_deleted=row_count;
  return v_deleted;
end $$;

revoke all on function public.prune_rate_limit_counters(interval,integer) from public,anon,authenticated;
grant execute on function public.prune_rate_limit_counters(interval,integer) to service_role;

commit;
