-- Stabilise auth.uid() inside RLS policy expressions.
--
-- `auth.uid()` is STABLE, not IMMUTABLE, so Postgres re-evaluates a bare call
-- once per candidate row inside an RLS qual. Wrapping it as `(select auth.uid())`
-- turns it into an InitPlan that is evaluated once per statement. On the large
-- tenant-scoped tables (customers, calls, notes, activities, dialer_sessions,
-- customer_list_members) that is the difference between one call and one call
-- per scanned row.
--
-- The rewrite is purely mechanical and preserves policy semantics: same command,
-- same roles, same predicate, only the evaluation point of auth.uid() changes.
--
-- Idempotent: policies whose expressions already contain `select auth.uid()`
-- are skipped, so re-running this migration cannot double-wrap them.

do $$
declare
  target record;
  rewritten_qual text;
  rewritten_check text;
  statement text;
begin
  for target in
    select
      pol.schemaname,
      pol.tablename,
      pol.policyname,
      pol.qual,
      pol.with_check
    from pg_policies pol
    where pol.schemaname = 'public'
      and (coalesce(pol.qual, '') ~ 'auth\.uid\(\)' or coalesce(pol.with_check, '') ~ 'auth\.uid\(\)')
      -- Skip anything already expressed as an InitPlan.
      and (coalesce(pol.qual, '') || coalesce(pol.with_check, '')) !~* 'select\s+auth\.uid\(\)'
    order by pol.tablename, pol.policyname
  loop
    rewritten_qual := regexp_replace(target.qual, 'auth\.uid\(\)', '( select auth.uid() )', 'g');
    rewritten_check := regexp_replace(target.with_check, 'auth\.uid\(\)', '( select auth.uid() )', 'g');

    statement := format(
      'alter policy %I on %I.%I',
      target.policyname, target.schemaname, target.tablename
    );
    if rewritten_qual is not null then
      statement := statement || format(' using (%s)', rewritten_qual);
    end if;
    if rewritten_check is not null then
      statement := statement || format(' with check (%s)', rewritten_check);
    end if;

    execute statement;
  end loop;
end
$$;
