-- Least privilege for SECURITY DEFINER functions in the public schema.
--
-- Postgres grants EXECUTE to PUBLIC by default, and `anon` inherits PUBLIC.
-- Every SECURITY DEFINER function that a previous migration forgot to revoke was
-- therefore reachable unauthenticated through PostgREST (`/rest/v1/rpc/<name>`),
-- running with the definer's privileges and bypassing RLS.
--
-- This migration establishes the invariant: no SECURITY DEFINER function in the
-- public schema is executable by `anon` or by PUBLIC. Effective access for
-- `authenticated` and `service_role` is captured before the revoke and restored
-- afterwards, so no working call path is removed. Trigger functions keep no
-- EXECUTE grant at all -- they are invoked by the trigger machinery, never by a
-- role directly.
--
-- Extension-owned functions (PostGIS, citext, pg_trgm) are left untouched;
-- Kundexa does not patch privileges on objects it does not own.
--
-- This migration is idempotent: on a database where the invariant already holds
-- it performs no effective change.

do $$
declare
  target record;
  had_authenticated boolean;
  had_service_role boolean;
begin
  for target in
    select
      p.oid as function_oid,
      p.oid::regprocedure as signature,
      (p.prorettype = 'trigger'::regtype) as is_trigger_function
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
      and not exists (
        select 1 from pg_depend d
        where d.objid = p.oid and d.deptype = 'e'
      )
    order by 1
  loop
    had_authenticated := has_function_privilege('authenticated', target.function_oid, 'execute');
    had_service_role := has_function_privilege('service_role', target.function_oid, 'execute');

    execute format('revoke all on function %s from public, anon', target.signature);

    if not target.is_trigger_function then
      if had_authenticated then
        execute format('grant execute on function %s to authenticated', target.signature);
      end if;
      -- service_role access is restored exactly as it was, never widened: several
      -- migrations deliberately deny service_role the unscoped variant of a
      -- tenant-scoped RPC (refresh_segment_materialization,
      -- materialize_segment_to_campaign) so the server is forced through the
      -- _for_tenant entry point. A blanket grant here would silently reopen those.
      if had_service_role then
        execute format('grant execute on function %s to service_role', target.signature);
      end if;
    end if;
  end loop;
end
$$;
