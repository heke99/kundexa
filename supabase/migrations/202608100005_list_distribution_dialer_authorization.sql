begin;

-- Runtime distribution pointer. It is intentionally separate from membership
-- assignment rows so retries/claims do not mutate list configuration.
create table if not exists public.customer_list_distribution_state (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  list_id uuid primary key,
  last_user_id uuid,
  sequence bigint not null default 0,
  updated_at timestamptz not null default now(),
  foreign key(tenant_id,list_id) references public.customer_lists(tenant_id,id) on delete cascade,
  foreign key(tenant_id,last_user_id) references public.tenant_memberships(tenant_id,user_id) on delete set null
);
create index if not exists customer_list_distribution_state_tenant_idx on public.customer_list_distribution_state(tenant_id,updated_at desc);

alter table public.customer_list_distribution_state enable row level security;
create policy customer_list_distribution_state_manager_read on public.customer_list_distribution_state for select to authenticated using(
  tenant_id=public.current_tenant_id() and public.can_manage_customer_list(list_id)
);

create or replace function public.can_manage_customer_list(p_list_id uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select exists(
    select 1 from public.customer_lists l
    where l.id=p_list_id and l.tenant_id=public.current_tenant_id()
      and (
        public.is_tenant_admin(l.tenant_id)
        or (
          public.has_current_role(array['team_lead']) and l.team_id is not null
          and public.can_manage_team(l.team_id)
        )
        or (
          l.owner_user_id=auth.uid()
          and public.has_current_role(array['owner','admin','team_lead'])
          and (l.team_id is null or public.can_manage_team(l.team_id))
        )
      )
  )
$$;

create or replace function public.can_work_customer_list(p_list_id uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select exists(
    select 1 from public.customer_lists l
    where l.id=p_list_id and l.tenant_id=public.current_tenant_id() and l.status='active'
      and (l.starts_at is null or l.starts_at<=now()) and (l.ends_at is null or l.ends_at>now())
      and (l.team_id is null or public.can_operate_in_team(l.team_id,auth.uid()) or public.is_tenant_admin(l.tenant_id))
      and (
        public.can_manage_customer_list(l.id)
        or exists(
          select 1 from public.customer_list_seller_assignments a
          where a.tenant_id=l.tenant_id and a.list_id=l.id and a.user_id=auth.uid() and a.status='active'
            and (a.starts_at is null or a.starts_at<=now()) and (a.ends_at is null or a.ends_at>now())
            and exists(select 1 from public.tenant_memberships m where m.tenant_id=l.tenant_id and m.user_id=a.user_id and m.status='active')
            and (l.team_id is null or public.can_operate_in_team(l.team_id,a.user_id))
            and (
              a.daily_capacity is null or (
                select count(*) from public.calls c where c.tenant_id=l.tenant_id and c.list_id=l.id and c.user_id=a.user_id
                  and (c.created_at at time zone l.timezone)::date=(now() at time zone l.timezone)::date
              ) < a.daily_capacity
            )
        )
      )
  )
$$;


create or replace function public.can_access_customer(p_customer_id uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select exists(
    select 1 from public.customers c
    join public.tenant_memberships m on m.tenant_id=c.tenant_id and m.user_id=auth.uid() and m.status='active'
    where c.id=p_customer_id and c.tenant_id=public.current_tenant_id() and (
      m.role in ('owner','admin','backoffice','quality','contract_manager','finance','viewer')
      or c.assigned_user_id=auth.uid() or c.created_by=auth.uid()
      or (c.assigned_team_id is not null and public.can_operate_in_team(c.assigned_team_id,auth.uid()))
      or exists(
        select 1 from public.customer_list_members lm
        where lm.tenant_id=c.tenant_id and lm.customer_id=c.id and public.can_work_customer_list(lm.list_id)
      )
    )
  )
$$;

create or replace function public.release_list_member_claim(p_session_id uuid,p_reason text default 'paused')
returns void language plpgsql security definer set search_path=public as $$
declare v_tenant uuid:=public.current_tenant_id(); v_user uuid:=auth.uid(); v_member uuid; v_callback uuid; v_list uuid; v_allow_skip boolean;
begin
  select current_list_member_id,current_callback_activity_id,list_id into v_member,v_callback,v_list
    from public.dialer_sessions where tenant_id=v_tenant and id=p_session_id and user_id=v_user and state<>'ended' for update;
  if not found then raise exception 'dialer_session_not_found'; end if;
  select allow_skip into v_allow_skip from public.customer_lists where tenant_id=v_tenant and id=v_list;
  if p_reason='skip' and not coalesce(v_allow_skip,false) then raise exception 'list_skip_disabled'; end if;
  update public.customer_list_members set state=case when p_reason='skip' then 'skipped' else 'pending' end,claimed_by=null,claim_expires_at=null,updated_at=now()
    where tenant_id=v_tenant and id=v_member and claimed_by=v_user;
  update public.activities set status='open',claimed_by=null,claim_expires_at=null,updated_at=now()
    where tenant_id=v_tenant and id=v_callback and claimed_by=v_user and status='in_progress';
  update public.dialer_sessions set state=case when p_reason='end' then 'ended' else 'paused' end,
    current_list_member_id=null,current_callback_activity_id=null,current_call_id=null,
    paused_at=case when p_reason<>'end' then now() else paused_at end,ended_at=case when p_reason='end' then now() else ended_at end,last_seen_at=now()
    where id=p_session_id;
end $$;

create or replace function public.claim_customer_callback(p_activity_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_tenant uuid:=public.current_tenant_id(); v_user uuid:=auth.uid(); v_activity public.activities%rowtype;
begin
  if v_tenant is null or v_user is null then raise exception 'active_tenant_membership_required'; end if;
  select * into v_activity from public.activities where tenant_id=v_tenant and id=p_activity_id and type='callback' for update;
  if not found then raise exception 'callback_not_found'; end if;
  if coalesce(v_activity.snoozed_until,v_activity.due_at)>now() then raise exception 'callback_not_due'; end if;
  if v_activity.status='in_progress' and v_activity.claimed_by<>v_user and v_activity.claim_expires_at>now() then raise exception 'callback_already_claimed'; end if;
  if v_activity.callback_scope='personal' and v_activity.assigned_user_id<>v_user then raise exception 'personal_callback_owner_required'; end if;
  if v_activity.callback_scope='global' and v_activity.assigned_team_id is not null and not public.can_operate_in_team(v_activity.assigned_team_id,v_user) then
    raise exception 'callback_team_permission_required';
  end if;
  if v_activity.list_id is not null and not public.can_work_customer_list(v_activity.list_id) then raise exception 'callback_list_permission_required'; end if;
  if v_activity.status not in ('open','in_progress') then raise exception 'callback_not_open'; end if;
  update public.activities set status='in_progress',claimed_by=v_user,claim_expires_at=now()+interval '10 minutes',updated_at=now() where tenant_id=v_tenant and id=p_activity_id;
  return jsonb_build_object('callbackId',v_activity.id,'customerId',v_activity.customer_id,'listId',v_activity.list_id);
end $$;

create or replace function public.split_customer_list_to_team(
  p_source_list_id uuid,p_team_id uuid,p_name text,p_count integer,p_distribution_strategy text default 'shared_queue'
) returns uuid language plpgsql security definer set search_path=public as $$
declare v_tenant uuid:=public.current_tenant_id(); v_actor uuid:=auth.uid(); v_source public.customer_lists%rowtype; v_child uuid; v_moved integer;
begin
  if not public.can_manage_customer_list(p_source_list_id) then raise exception 'source_list_manage_permission_required'; end if;
  if not public.can_manage_team(p_team_id) then raise exception 'team_manage_permission_required'; end if;
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
    select lm.id,lm.customer_id from public.customer_list_members lm
    where lm.tenant_id=v_tenant and lm.list_id=p_source_list_id and lm.state in ('pending','retry','skipped') and lm.claimed_by is null
    order by lm.priority desc,lm.created_at,lm.id for update skip locked limit p_count
  ), inserted as (
    insert into public.customer_list_members(tenant_id,list_id,customer_id,added_by,source_segment_id,assigned_user_id,state,priority,attempts,next_attempt_at,outcome,last_contacted_at)
    select v_tenant,v_child,lm.customer_id,v_actor,lm.source_segment_id,null,'pending',lm.priority,lm.attempts,lm.next_attempt_at,lm.outcome,lm.last_contacted_at
    from public.customer_list_members lm join selected s on s.id=lm.id on conflict(list_id,customer_id) do nothing returning id,customer_id
  ), relinked as (
    update public.platform_list_allocation_entries ae set list_member_id=i.id from selected s join inserted i on i.customer_id=s.customer_id
    where ae.tenant_id=v_tenant and ae.list_member_id=s.id returning ae.platform_entry_id
  )
  delete from public.customer_list_members lm using inserted i,selected s
    where s.customer_id=i.customer_id and lm.tenant_id=v_tenant and lm.id=s.id;
  get diagnostics v_moved=row_count;
  if v_moved=0 then delete from public.customer_lists where id=v_child; raise exception 'no_open_list_members_available'; end if;
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
    values(v_tenant,v_actor,'customer_list.split_to_team','customer_list',v_child::text,jsonb_build_object('source_list_id',p_source_list_id,'team_id',p_team_id,'requested',p_count,'moved',v_moved,'distribution_strategy',p_distribution_strategy));
  return v_child;
end $$;

create or replace function public.claim_next_list_member(p_list_id uuid,p_session_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_tenant uuid:=public.current_tenant_id(); v_user uuid:=auth.uid(); v_list public.customer_lists%rowtype;
  v_session public.dialer_sessions%rowtype; v_member public.customer_list_members%rowtype; v_customer public.customers%rowtype;
  v_callback public.activities%rowtype; v_local timestamp; v_time time; v_callback_id uuid; v_notes jsonb;
  v_pointer public.customer_list_distribution_state%rowtype; v_round_robin_user uuid;
begin
  if not public.can_work_customer_list(p_list_id) then raise exception 'list_work_permission_required'; end if;
  select * into v_list from public.customer_lists where tenant_id=v_tenant and id=p_list_id and status='active';
  if not found then raise exception 'list_not_active'; end if;
  select * into v_session from public.dialer_sessions where tenant_id=v_tenant and id=p_session_id and list_id=p_list_id and user_id=v_user and state<>'ended' for update;
  if not found then raise exception 'dialer_session_not_found'; end if;
  v_local:=now() at time zone v_list.timezone; v_time:=v_local::time;
  if not extract(isodow from v_local)::integer=any(v_list.allowed_days)
    or (v_list.allowed_start_time<=v_list.allowed_end_time and (v_time<v_list.allowed_start_time or v_time>v_list.allowed_end_time))
    or (v_list.allowed_start_time>v_list.allowed_end_time and (v_time<v_list.allowed_start_time and v_time>v_list.allowed_end_time))
  then raise exception 'outside_list_calling_hours'; end if;
  if v_list.starts_at is not null and v_list.starts_at>now() then raise exception 'list_not_started'; end if;
  if v_list.ends_at is not null and v_list.ends_at<=now() then raise exception 'list_ended'; end if;

  if exists(select 1 from public.customer_list_seller_assignments a where a.tenant_id=v_tenant and a.list_id=p_list_id and a.user_id=v_user and a.daily_capacity is not null and (
    select count(*) from public.calls c where c.tenant_id=v_tenant and c.list_id=p_list_id and c.user_id=v_user and (c.created_at at time zone v_list.timezone)::date=v_local::date
  )>=a.daily_capacity) then raise exception 'seller_daily_capacity_reached'; end if;

  -- Reclaim abandoned leases before selecting new work.
  update public.customer_list_members set state=case when attempts>=v_list.max_attempts then 'completed' else 'retry' end,claimed_by=null,claim_expires_at=null,updated_at=now()
    where tenant_id=v_tenant and list_id=p_list_id and state in ('claimed','dialing') and claim_expires_at<now();
  update public.activities set status='open',claimed_by=null,claim_expires_at=null,updated_at=now()
    where tenant_id=v_tenant and list_id=p_list_id and type='callback' and status='in_progress' and claim_expires_at<now();

  if v_session.current_list_member_id is not null then
    select * into v_member from public.customer_list_members where tenant_id=v_tenant and id=v_session.current_list_member_id and claimed_by=v_user and claim_expires_at>now();
    v_callback_id:=v_session.current_callback_activity_id;
  end if;

  if v_member.id is null then
    select a.* into v_callback from public.activities a
    where a.tenant_id=v_tenant and a.list_id=p_list_id and a.type='callback' and a.status='open' and coalesce(a.snoozed_until,a.due_at)<=now()
      and (a.assigned_user_id=v_user or (a.callback_scope='global' and (a.assigned_team_id is null or public.can_operate_in_team(a.assigned_team_id,v_user))))
    order by coalesce(a.snoozed_until,a.due_at),a.created_at for update skip locked limit 1;
    if v_callback.id is not null then
      update public.activities set status='in_progress',claimed_by=v_user,claim_expires_at=now()+interval '10 minutes',updated_at=now() where id=v_callback.id;
      select * into v_member from public.customer_list_members where tenant_id=v_tenant and list_id=p_list_id and customer_id=v_callback.customer_id for update;
      v_callback_id:=v_callback.id;
    end if;
  end if;

  if v_member.id is null and v_list.distribution_strategy='round_robin' then
    insert into public.customer_list_distribution_state(tenant_id,list_id) values(v_tenant,p_list_id)
      on conflict(list_id) do nothing;
    select * into v_pointer from public.customer_list_distribution_state where tenant_id=v_tenant and list_id=p_list_id for update;
    select eligible.user_id into v_round_robin_user
    from (
      select a.user_id,a.created_at
      from public.customer_list_seller_assignments a
      join public.tenant_memberships m on m.tenant_id=a.tenant_id and m.user_id=a.user_id and m.status='active'
      where a.tenant_id=v_tenant and a.list_id=p_list_id and a.status='active'
        and (a.starts_at is null or a.starts_at<=now()) and (a.ends_at is null or a.ends_at>now())
        and (v_list.team_id is null or public.can_operate_in_team(v_list.team_id,a.user_id))
        and (a.daily_capacity is null or (select count(*) from public.calls c where c.tenant_id=v_tenant and c.list_id=p_list_id and c.user_id=a.user_id and (c.created_at at time zone v_list.timezone)::date=v_local::date)<a.daily_capacity)
    ) eligible
    order by case when v_pointer.last_user_id is null then 0 when eligible.user_id::text>v_pointer.last_user_id::text then 0 else 1 end,eligible.user_id::text
    limit 1;
    if v_round_robin_user is null then raise exception 'round_robin_has_no_eligible_sellers'; end if;
    if v_round_robin_user<>v_user then raise exception 'round_robin_turn_owned_by_another_seller'; end if;
  end if;

  if v_member.id is null then
    select lm.* into v_member from public.customer_list_members lm
    join public.customers c on c.tenant_id=lm.tenant_id and c.id=lm.customer_id
    where lm.tenant_id=v_tenant and lm.list_id=p_list_id and lm.state in ('pending','retry','callback','skipped')
      and (lm.next_attempt_at is null or lm.next_attempt_at<=now()) and lm.attempts<v_list.max_attempts
      and c.deleted_at is null and not c.do_not_call and c.lifecycle<>'blocked'
      and (c.phone_e164 is not null or c.alternate_phone_e164 is not null or exists(
        select 1 from public.contact_people cp where cp.tenant_id=c.tenant_id and cp.customer_id=c.id and coalesce(cp.phone_e164,cp.alternate_phone_e164) is not null
          and exists(select 1 from public.nix_checks nx where nx.tenant_id=c.tenant_id and nx.phone_e164 in (cp.phone_e164,cp.alternate_phone_e164) and nx.valid_until>now() and nx.result='not_listed')
      ))
      and public.evaluate_contact_policy_for_tenant(v_tenant,c.id,'call','direct_marketing')->>'allowed'='true'
      and (lm.claimed_by is null or lm.claim_expires_at<now())
      and (
        v_list.distribution_strategy in ('shared_queue','round_robin')
        or (v_list.distribution_strategy in ('fixed_owner','manual') and lm.assigned_user_id=v_user)
      )
      and (not v_list.lock_to_seller or lm.assigned_user_id is null or lm.assigned_user_id=v_user)
    order by case when lm.state='callback' then 0 else 1 end,lm.priority desc,lm.next_attempt_at nulls first,lm.created_at
    for update of lm skip locked limit 1;
  end if;

  if v_member.id is null then
    update public.dialer_sessions set current_list_member_id=null,current_callback_activity_id=null,current_call_id=null,last_seen_at=now() where id=p_session_id;
    return jsonb_build_object('empty',true,'sessionId',p_session_id,'distributionStrategy',v_list.distribution_strategy);
  end if;
  update public.customer_list_members set state='claimed',claimed_by=v_user,claim_expires_at=now()+interval '10 minutes',
    assigned_user_id=case when v_list.distribution_strategy in ('round_robin','fixed_owner','manual') or v_list.lock_to_seller then coalesce(assigned_user_id,v_user) else assigned_user_id end,
    updated_at=now() where id=v_member.id returning * into v_member;
  if v_list.distribution_strategy='round_robin' then
    update public.customer_list_distribution_state set last_user_id=v_user,sequence=sequence+1,updated_at=now() where tenant_id=v_tenant and list_id=p_list_id;
  end if;
  update public.dialer_sessions set state='active',current_list_member_id=v_member.id,current_callback_activity_id=v_callback_id,current_call_id=null,last_seen_at=now() where id=p_session_id;
  select * into v_customer from public.customers where tenant_id=v_tenant and id=v_member.customer_id;
  select coalesce(jsonb_agg(jsonb_build_object('id',n.id,'body',n.body,'isPinned',n.is_pinned,'createdAt',n.created_at) order by n.is_pinned desc,n.created_at desc),'[]'::jsonb)
    into v_notes from (select id,body,is_pinned,created_at from public.notes where tenant_id=v_tenant and customer_id=v_member.customer_id and archived_at is null order by is_pinned desc,created_at desc limit 8) n;
  return jsonb_build_object(
    'empty',false,'sessionId',p_session_id,'memberId',v_member.id,'callbackActivityId',v_callback_id,'mode',v_list.dialing_mode,
    'distributionStrategy',v_list.distribution_strategy,'autoNextDelaySeconds',v_list.auto_next_delay_seconds,'allowSkip',v_list.allow_skip,'allowBrowse',v_list.allow_browse,
    'script',v_list.script,'questionnaire',v_list.questionnaire,
    'customer',jsonb_build_object('id',v_customer.id,'displayName',v_customer.display_name,'customerType',v_customer.customer_type,'companyName',v_customer.company_name,
      'organizationNumber',v_customer.organization_number,'phone',v_customer.phone_e164,'email',v_customer.email,'address',concat_ws(', ',v_customer.address_line1,v_customer.postal_code,v_customer.city),
      'industry',v_customer.industry,'sniCode',v_customer.sni_code,'callAttempts',v_member.attempts,'lastContactAt',v_customer.last_contact_at,'customFields',v_customer.custom_fields,'notes',v_notes)
  );
end $$;

-- allow_browse is now enforced at the data boundary; list workers do not get an
-- implicit full-list read simply because they can claim work.
drop policy if exists customer_list_members_list_select on public.customer_list_members;
create policy customer_list_members_runtime_select on public.customer_list_members for select to authenticated using(
  tenant_id=public.current_tenant_id() and (
    public.can_manage_customer_list(list_id)
    or (
      public.can_work_customer_list(list_id)
      and exists(select 1 from public.customer_lists l where l.tenant_id=customer_list_members.tenant_id and l.id=customer_list_members.list_id
        and (l.allow_browse or customer_list_members.claimed_by=auth.uid() or customer_list_members.assigned_user_id=auth.uid()))
    )
  )
);

revoke all on function public.can_manage_customer_list(uuid) from public,anon;
revoke all on function public.can_work_customer_list(uuid) from public,anon;
revoke all on function public.release_list_member_claim(uuid,text) from public,anon;
revoke all on function public.claim_customer_callback(uuid) from public,anon;
revoke all on function public.split_customer_list_to_team(uuid,uuid,text,integer,text) from public,anon;
revoke all on function public.claim_next_list_member(uuid,uuid) from public,anon;
grant execute on function public.can_manage_customer_list(uuid) to authenticated;
grant execute on function public.can_work_customer_list(uuid) to authenticated;
grant execute on function public.release_list_member_claim(uuid,text) to authenticated;
grant execute on function public.claim_customer_callback(uuid) to authenticated;
grant execute on function public.split_customer_list_to_team(uuid,uuid,text,integer,text) to authenticated;
grant execute on function public.claim_next_list_member(uuid,uuid) to authenticated;

commit;
