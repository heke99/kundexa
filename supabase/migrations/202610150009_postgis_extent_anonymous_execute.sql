begin;
-- Live advisor confirmed these three PostGIS C SECURITY DEFINER overloads are
-- anonymously executable. Kundexa has no public extent/statistics endpoint.
-- Restrict that anonymous surface without rewriting extension functions, moving
-- PostGIS, changing ownership/search paths, or broadening any application RPC.
do $$
declare target record; had_authenticated boolean; had_service_role boolean;
begin
  for target in
    select p.oid,p.oid::regprocedure as signature
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.prosecdef and p.oid=any(array[
      to_regprocedure('public.st_estimatedextent(text,text)'),
      to_regprocedure('public.st_estimatedextent(text,text,text)'),
      to_regprocedure('public.st_estimatedextent(text,text,text,boolean)')
    ])
    and exists(select 1 from pg_depend d join pg_extension e on e.oid=d.refobjid
      where d.classid='pg_proc'::regclass and d.objid=p.oid and d.refclassid='pg_extension'::regclass
        and d.deptype='e' and e.extname='postgis')
  loop
    had_authenticated:=has_function_privilege('authenticated',target.oid,'execute');
    had_service_role:=has_function_privilege('service_role',target.oid,'execute');
    execute format('revoke execute on function %s from public,anon',target.signature);
    -- PUBLIC previously supplies inherited access too. Preserve precisely those
    -- existing authenticated/service capabilities; do not blanket-grant them.
    if had_authenticated then execute format('grant execute on function %s to authenticated',target.signature); end if;
    if had_service_role then execute format('grant execute on function %s to service_role',target.signature); end if;
  end loop;
end $$;
commit;
