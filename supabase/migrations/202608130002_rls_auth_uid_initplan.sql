-- Evaluate `auth.uid()` once per statement instead of once per row in RLS.
--
-- 37 policies call `auth.uid()` directly inside their USING/WITH CHECK
-- expressions. Postgres cannot hoist that call out of the per-row filter, so
-- every scanned row re-enters the auth function. Wrapping the call in a scalar
-- subquery, `(select auth.uid())`, turns it into an InitPlan that is evaluated
-- once per statement. This is the remediation the hosted performance advisor
-- asks for under `auth_rls_initplan`.
--
-- The rewrite is mechanical and semantics-preserving: `auth.uid()` is STABLE,
-- so a scalar subquery returns exactly the same value for the whole statement.
-- Policy name, permissiveness, command and role list are taken from the
-- catalog and re-applied unchanged; only the expression text differs. Policies
-- that already use the wrapped form are skipped, which makes the migration
-- idempotent and safe to replay.

do $$
declare
  policy_record record;
  new_qual text;
  new_check text;
  statement text;
begin
  for policy_record in
    select
      n.nspname as schema_name,
      c.relname as table_name,
      pol.polname as policy_name,
      pol.polpermissive as permissive,
      case pol.polcmd
        when 'r' then 'select'
        when 'a' then 'insert'
        when 'w' then 'update'
        when 'd' then 'delete'
        else 'all'
      end as command,
      (
        select string_agg(quote_ident(r.rolname), ', ')
        from unnest(pol.polroles) role_oid
        join pg_roles r on r.oid = role_oid
      ) as role_list,
      pg_get_expr(pol.polqual, pol.polrelid) as qual,
      pg_get_expr(pol.polwithcheck, pol.polrelid) as with_check
    from pg_policy pol
    join pg_class c on c.oid = pol.polrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and (
        coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') like '%auth.uid()%'
        or coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '') like '%auth.uid()%'
      )
      and coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') not like '%( SELECT auth.uid()%'
      and coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '') not like '%( SELECT auth.uid()%'
    order by c.relname, pol.polname
  loop
    new_qual := replace(policy_record.qual, 'auth.uid()', '(select auth.uid())');
    new_check := replace(policy_record.with_check, 'auth.uid()', '(select auth.uid())');

    execute format(
      'drop policy %I on %I.%I',
      policy_record.policy_name, policy_record.schema_name, policy_record.table_name
    );

    statement := format(
      'create policy %I on %I.%I as %s for %s to %s',
      policy_record.policy_name,
      policy_record.schema_name,
      policy_record.table_name,
      case when policy_record.permissive then 'permissive' else 'restrictive' end,
      policy_record.command,
      coalesce(policy_record.role_list, 'public')
    );
    if new_qual is not null then
      statement := statement || format(' using (%s)', new_qual);
    end if;
    if new_check is not null then
      statement := statement || format(' with check (%s)', new_check);
    end if;

    execute statement;
  end loop;
end
$$;

-- The identical `(tenant_id, id)` unique indexes are leftovers: the `_key`
-- index backs the composite unique constraint that tenant-scoped foreign keys
-- reference, while the `_uidx` copy backs nothing and only costs write time.
drop index if exists public.contract_versions_tenant_id_id_uidx;
drop index if exists public.contracts_tenant_id_id_uidx;
drop index if exists public.customers_tenant_id_id_uidx;
drop index if exists public.deals_tenant_id_id_uidx;
drop index if exists public.phone_numbers_tenant_id_id_uidx;
