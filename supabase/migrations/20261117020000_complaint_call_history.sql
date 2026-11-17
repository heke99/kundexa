begin;
create index calls_history_time_idx on public.calls(tenant_id,(coalesce(started_at,initiated_at,created_at)),id);
create index calls_platform_history_time_idx on public.calls((coalesce(started_at,initiated_at,created_at)),id);
create function public.search_call_history(p_query text default '',p_from timestamptz default null,p_to timestamptz default null,p_limit integer default 50,p_offset integer default 0,p_platform boolean default false)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare tenant uuid:=public.current_tenant_id(); actor uuid:=auth.uid(); q text:=btrim(coalesce(p_query,'')); digits text;
 since timestamptz:=coalesce(p_from,now()-interval '30 days'); until_at timestamptz:=coalesce(p_to,now()+interval '1 minute'); result jsonb; total bigint;
begin
 if actor is null then raise exception 'authentication_required'; end if;
 if p_platform is null then raise exception 'call_search_scope_required'; end if;
 if p_platform then
  if not exists(select 1 from public.platform_memberships where user_id=actor and status='active' and role in ('platform_owner','platform_admin'))
   or coalesce(auth.jwt()->>'aal','')<>'aal2' then raise exception 'platform_call_search_permission_required'; end if;
 elsif tenant is null or not public.has_current_role(array['owner','admin','team_lead','sales','quality','viewer']) then raise exception 'call_search_permission_required'; end if;
 if length(q)>120 or (q<>'' and length(q)<2) or p_limit is null or p_limit not between 1 and 100 or p_offset is null or p_offset not between 0 and 100000
  or not isfinite(since) or not isfinite(until_at) or since>=until_at or until_at-since>interval '366 days' then raise exception 'call_search_filters_invalid'; end if;
 if q ~ '^[+0-9 ()-]+$' then
  digits:=regexp_replace(q,'[^0-9]','','g');
  if digits like '00%' then digits:=substr(digits,3); elsif digits like '0%' then digits:='46'||substr(digits,2); end if;
  if length(digits)<3 then digits:=null; end if;
 end if;
 with matched as (
  select c.id,c.tenant_id,t.name as tenant_name,c.customer_id,cu.display_name as customer_name,cp.full_name as contact_name,
   c.user_id as seller_id,p.full_name as seller_name,c.team_id,team.name as team_name,c.from_number,c.to_number,c.direction,c.status,c.disposition,
   coalesce(c.started_at,c.initiated_at,c.created_at) as started_at,c.answered_at,c.ended_at,c.duration_seconds
  from public.calls c join public.tenants t on t.id=c.tenant_id
  left join public.customers cu on cu.tenant_id=c.tenant_id and cu.id=c.customer_id
  left join public.contact_people cp on cp.tenant_id=c.tenant_id and cp.id=c.contact_person_id
  left join public.profiles p on p.id=c.user_id
  left join public.teams team on team.tenant_id=c.tenant_id and team.id=c.team_id
  where (p_platform or (c.tenant_id=tenant and (public.has_current_role(array['owner','admin','quality']) or c.user_id=actor or (public.has_current_role(array['team_lead']) and public.can_operate_in_team(c.team_id,actor)))))
   and coalesce(c.started_at,c.initiated_at,c.created_at)>=since and coalesce(c.started_at,c.initiated_at,c.created_at)<until_at
   and (q='' or position(lower(q) in lower(coalesce(cu.display_name,'')))>0 or position(lower(q) in lower(coalesce(cp.full_name,'')))>0
    or position(lower(q) in lower(coalesce(p.full_name,'')))>0
    or (digits is not null and (position(digits in regexp_replace(c.from_number,'[^0-9]','','g'))>0 or position(digits in regexp_replace(c.to_number,'[^0-9]','','g'))>0)))
 ), page as (
  select * from matched order by started_at desc,id desc limit p_limit offset p_offset
 ) select coalesce(jsonb_agg(to_jsonb(page) order by started_at desc,id desc),'[]'::jsonb),(select count(*) from matched) into result,total from page;
 insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,after_data)
 values(case when p_platform then null else tenant end,actor,'calls.history_searched','call_search',jsonb_build_object('platform',p_platform,'has_query',q<>'','from',since,'to',until_at,'returned',jsonb_array_length(result),'offset',p_offset));
 return jsonb_build_object('data',result,'total',total,'limit',p_limit,'offset',p_offset);
end $$;
revoke all on function public.search_call_history(text,timestamptz,timestamptz,integer,integer,boolean) from public,anon,service_role;
grant execute on function public.search_call_history(text,timestamptz,timestamptz,integer,integer,boolean) to authenticated;
commit;
