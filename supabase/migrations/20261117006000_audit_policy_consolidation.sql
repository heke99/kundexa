begin;
create table if not exists private.rls_policy_consolidation (
 table_oid oid primary key,table_name text not null,original_policies jsonb not null,recorded_at timestamptz not null default now()
);
revoke all on private.rls_policy_consolidation from public,anon,authenticated,service_role;
-- Preserve PostgreSQL's OR semantics and the original TO roles. Never move
-- authenticated-only predicates into PUBLIC policies: permissions can fail
-- during expression preparation even when a role guard would be false.
-- Restrictive AND policies (notably MFA) are deliberately retained unchanged.
do $$ declare t record; p record; op text; role_list text; role_set jsonb; using_parts text[]; check_parts text[]; source jsonb; using_sql text; check_sql text;
begin
 for t in select tablename from pg_policies where schemaname='public' and permissive='PERMISSIVE' group by tablename having count(*)>1 loop
  select jsonb_agg(jsonb_build_object('name',policyname,'roles',roles,'cmd',cmd,'qual',qual,'check',with_check)) into source
   from pg_policies where schemaname='public' and tablename=t.tablename and permissive='PERMISSIVE';
  insert into private.rls_policy_consolidation(table_oid,table_name,original_policies)
   values(format('public.%I',t.tablename)::regclass,t.tablename,source) on conflict(table_oid) do nothing;
  for p in select value from jsonb_array_elements(source) loop execute format('drop policy %I on public.%I',p.value->>'name',t.tablename); end loop;
  for role_set in select distinct value->'roles' from jsonb_array_elements(source) loop
   select string_agg(case when value='public' then 'PUBLIC' else quote_ident(value) end,',') into role_list from jsonb_array_elements_text(role_set);
  foreach op in array array['SELECT','INSERT','UPDATE','DELETE'] loop
   using_parts:='{}';check_parts:='{}';
   for p in select value from jsonb_array_elements(source) where value->>'cmd' in ('ALL',op) and value->'roles'=role_set loop
    using_parts:=array_append(using_parts,format('(%s)',coalesce(p.value->>'qual','true')));
    check_parts:=array_append(check_parts,format('(%s)',coalesce(p.value->>'check',p.value->>'qual','true')));
   end loop;
   if cardinality(using_parts)>0 then
    using_sql:=case when op='INSERT' then '' else ' USING ('||array_to_string(using_parts,' OR ')||')' end;
    check_sql:=case when op in ('INSERT','UPDATE') then ' WITH CHECK ('||array_to_string(check_parts,' OR ')||')' else '' end;
    execute format('create policy %I on public.%I as permissive for %s to %s%s%s','access_'||lower(op)||'_'||substr(md5(role_set::text),1,8),t.tablename,op,role_list,using_sql,check_sql);
   end if;
  end loop;
  end loop;
 end loop;
end $$;
commit;
