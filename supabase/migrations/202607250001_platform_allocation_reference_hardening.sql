begin;

-- PostgreSQL applies ON DELETE SET NULL to every column in a composite foreign
-- key unless a column list is provided. tenant_id is intentionally NOT NULL,
-- so deleting a referenced list/member/customer previously made otherwise
-- valid allocation and team-split operations fail with SQLSTATE 23502.
alter table public.platform_list_allocations
  drop constraint if exists platform_list_allocations_tenant_id_target_list_id_fkey;
alter table public.platform_list_allocations
  add constraint platform_list_allocations_tenant_id_target_list_id_fkey
  foreign key(tenant_id,target_list_id)
  references public.customer_lists(tenant_id,id)
  on delete set null (target_list_id);

alter table public.platform_list_allocation_entries
  drop constraint if exists platform_list_allocation_entries_tenant_id_customer_id_fkey;
alter table public.platform_list_allocation_entries
  add constraint platform_list_allocation_entries_tenant_id_customer_id_fkey
  foreign key(tenant_id,customer_id)
  references public.customers(tenant_id,id)
  on delete set null (customer_id);

alter table public.platform_list_allocation_entries
  drop constraint if exists platform_list_allocation_entries_tenant_id_list_member_id_fkey;
alter table public.platform_list_allocation_entries
  add constraint platform_list_allocation_entries_tenant_id_list_member_id_fkey
  foreign key(tenant_id,list_member_id)
  references public.customer_list_members(tenant_id,id)
  on delete set null (list_member_id);

-- Keep the platform allocation trail linked to the canonical operational list
-- member when an untouched lead is moved from the tenant-level source list to a
-- team list. The constrained fallback above still preserves tenant_id if that
-- team member is later removed.
create or replace function public.split_customer_list_to_team(
  p_source_list_id uuid,
  p_team_id uuid,
  p_name text,
  p_count integer,
  p_distribution_strategy text default 'shared_queue'
)
returns uuid
language plpgsql
security definer
set search_path=public
as $$
declare
  v_tenant uuid:=public.current_tenant_id();
  v_actor uuid:=auth.uid();
  v_source public.customer_lists%rowtype;
  v_child uuid;
  v_moved integer;
begin
  if not public.is_tenant_admin(v_tenant) then raise exception 'tenant_admin_required'; end if;
  if nullif(trim(coalesce(p_name,'')),'') is null then raise exception 'team_list_name_required'; end if;
  if p_count<1 or p_count>1000000 then raise exception 'invalid_split_count'; end if;
  if p_distribution_strategy not in ('shared_queue','round_robin','fixed_owner','manual') then raise exception 'invalid_distribution_strategy'; end if;
  if not exists(select 1 from public.teams where tenant_id=v_tenant and id=p_team_id and status='active') then raise exception 'active_team_required'; end if;
  select * into v_source from public.customer_lists where tenant_id=v_tenant and id=p_source_list_id for update;
  if not found then raise exception 'source_list_not_found'; end if;
  insert into public.customer_lists(
    tenant_id,name,description,list_type,filter_definition,owner_user_id,team_id,status,dialing_mode,distribution_strategy,priority,
    timezone,allowed_days,allowed_start_time,allowed_end_time,max_attempts,retry_delay_minutes,auto_next_delay_seconds,allow_skip,
    allow_browse,lock_to_seller,callback_policy,required_disposition,outbound_phone_number_id,script,questionnaire,settings,starts_at,ends_at,
    source_kind,source_platform_list_id,source_platform_allocation_id,parent_list_id,allocation_level
  ) values(
    v_tenant,trim(p_name),v_source.description,v_source.list_type,v_source.filter_definition,v_actor,p_team_id,'draft',v_source.dialing_mode,p_distribution_strategy,v_source.priority,
    v_source.timezone,v_source.allowed_days,v_source.allowed_start_time,v_source.allowed_end_time,v_source.max_attempts,v_source.retry_delay_minutes,
    v_source.auto_next_delay_seconds,v_source.allow_skip,v_source.allow_browse,v_source.lock_to_seller,v_source.callback_policy,v_source.required_disposition,
    v_source.outbound_phone_number_id,v_source.script,v_source.questionnaire,v_source.settings,v_source.starts_at,v_source.ends_at,
    v_source.source_kind,v_source.source_platform_list_id,v_source.source_platform_allocation_id,v_source.id,'team'
  ) returning id into v_child;
  perform public.seed_list_dispositions(v_tenant,v_child);
  with selected as (
    select lm.id,lm.customer_id
    from public.customer_list_members lm
    where lm.tenant_id=v_tenant and lm.list_id=p_source_list_id
      and lm.state in ('pending','retry','skipped') and lm.claimed_by is null
    order by lm.priority desc,lm.created_at,lm.id
    for update skip locked
    limit p_count
  ), inserted as (
    insert into public.customer_list_members(
      tenant_id,list_id,customer_id,added_by,source_segment_id,assigned_user_id,state,priority,attempts,next_attempt_at,outcome,last_contacted_at
    )
    select v_tenant,v_child,lm.customer_id,v_actor,lm.source_segment_id,null,'pending',lm.priority,lm.attempts,lm.next_attempt_at,lm.outcome,lm.last_contacted_at
    from public.customer_list_members lm
    join selected s on s.id=lm.id
    on conflict(list_id,customer_id) do nothing
    returning id,customer_id
  ), relinked as (
    update public.platform_list_allocation_entries ae
    set list_member_id=i.id
    from selected s
    join inserted i on i.customer_id=s.customer_id
    where ae.tenant_id=v_tenant and ae.list_member_id=s.id
    returning ae.platform_entry_id
  )
  delete from public.customer_list_members lm
  using inserted i, selected s
  where s.customer_id=i.customer_id
    and lm.tenant_id=v_tenant
    and lm.id=s.id;
  get diagnostics v_moved=row_count;
  if v_moved=0 then
    delete from public.customer_lists where id=v_child;
    raise exception 'no_open_list_members_available';
  end if;
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
  values(v_tenant,v_actor,'customer_list.split_to_team','customer_list',v_child::text,
    jsonb_build_object('source_list_id',p_source_list_id,'team_id',p_team_id,'requested',p_count,'moved',v_moved));
  return v_child;
end $$;

commit;
