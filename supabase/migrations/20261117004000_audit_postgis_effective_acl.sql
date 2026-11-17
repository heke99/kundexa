begin;
-- Must run as the actual object owner (or a provider-authorised administrator).
-- REVOKE warnings do not constitute success: verify effective privileges below.
do $$ declare f record; r text; privilege text;
begin
 if to_regclass('public.spatial_ref_sys') is not null then
  revoke insert,update,delete,truncate,references,trigger on public.spatial_ref_sys from public,anon,authenticated;
  foreach r in array array['anon','authenticated'] loop
   foreach privilege in array array['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] loop
    if has_table_privilege(r,'public.spatial_ref_sys',privilege) then raise exception 'spatial_ref_sys_effective_write_acl_requires_object_owner'; end if;
   end loop;
  end loop;
 end if;
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','extensions') and p.proname='st_estimatedextent' loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  if has_function_privilege('anon',f.signature,'EXECUTE') or has_function_privilege('authenticated',f.signature,'EXECUTE') then raise exception 'postgis_effective_execute_acl_requires_object_owner'; end if;
 end loop;
end $$;
commit;
