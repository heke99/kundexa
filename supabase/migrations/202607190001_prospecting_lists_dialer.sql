begin;

-- Kundexa list/dialer completion. Existing customers remain the canonical party record,
-- activities remain the canonical callback/task record and calls remain the canonical call record.

alter table public.customer_lists
  add column if not exists status text not null default 'draft',
  add column if not exists dialing_mode text not null default 'manual',
  add column if not exists distribution_strategy text not null default 'shared_queue',
  add column if not exists priority integer not null default 100,
  add column if not exists timezone text not null default 'Europe/Stockholm',
  add column if not exists allowed_days integer[] not null default '{1,2,3,4,5}',
  add column if not exists allowed_start_time time not null default '09:00',
  add column if not exists allowed_end_time time not null default '18:00',
  add column if not exists max_attempts integer not null default 7,
  add column if not exists retry_delay_minutes integer not null default 1440,
  add column if not exists auto_next_delay_seconds integer not null default 4,
  add column if not exists allow_skip boolean not null default true,
  add column if not exists allow_browse boolean not null default false,
  add column if not exists lock_to_seller boolean not null default false,
  add column if not exists callback_policy text not null default 'both',
  add column if not exists required_disposition boolean not null default true,
  add column if not exists outbound_phone_number_id uuid,
  add column if not exists script text,
  add column if not exists questionnaire jsonb not null default '[]'::jsonb,
  add column if not exists settings jsonb not null default '{}'::jsonb,
  add column if not exists starts_at timestamptz,
  add column if not exists ends_at timestamptz;

alter table public.customer_lists drop constraint if exists customer_lists_status_check;
alter table public.customer_lists add constraint customer_lists_status_check check(status in ('draft','active','paused','completed','archived'));
alter table public.customer_lists drop constraint if exists customer_lists_list_type_check;
alter table public.customer_lists add constraint customer_lists_list_type_check check(list_type in ('static','dynamic','campaign','personal','callback','renewal','import','upsell','missed_calls','block'));
alter table public.customer_lists drop constraint if exists customer_lists_dialing_mode_check;
alter table public.customer_lists add constraint customer_lists_dialing_mode_check check(dialing_mode in ('manual','automatic'));
alter table public.customer_lists drop constraint if exists customer_lists_distribution_strategy_check;
alter table public.customer_lists add constraint customer_lists_distribution_strategy_check check(distribution_strategy in ('shared_queue','round_robin','fixed_owner','manual'));
alter table public.customer_lists drop constraint if exists customer_lists_callback_policy_check;
alter table public.customer_lists add constraint customer_lists_callback_policy_check check(callback_policy in ('personal','global','both'));
alter table public.customer_lists drop constraint if exists customer_lists_dialer_limits_check;
alter table public.customer_lists add constraint customer_lists_dialer_limits_check check(
  max_attempts between 1 and 100 and retry_delay_minutes between 1 and 525600
  and auto_next_delay_seconds between 0 and 300 and priority between 0 and 10000
);
alter table public.customer_lists drop constraint if exists customer_lists_tenant_outbound_number_fk;
alter table public.customer_lists add constraint customer_lists_tenant_outbound_number_fk
  foreign key(tenant_id,outbound_phone_number_id) references public.phone_numbers(tenant_id,id) on delete set null;

create table public.customer_list_seller_assignments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  list_id uuid not null,
  user_id uuid not null,
  status text not null default 'active' check(status in ('active','paused','ended')),
  weight integer not null default 100 check(weight between 1 and 10000),
  daily_capacity integer check(daily_capacity is null or daily_capacity between 1 and 10000),
  starts_at timestamptz,
  ends_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(tenant_id,id),
  unique(list_id,user_id),
  foreign key(tenant_id,list_id) references public.customer_lists(tenant_id,id) on delete cascade,
  foreign key(tenant_id,user_id) references public.tenant_memberships(tenant_id,user_id) on delete cascade
);

create table public.list_dispositions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  list_id uuid not null,
  key text not null check(key ~ '^[a-z0-9_]{2,50}$'),
  label text not null,
  outcome_group text not null check(outcome_group in ('positive','neutral','negative','unreachable','blocked')),
  terminal boolean not null default false,
  retry_after_minutes integer check(retry_after_minutes is null or retry_after_minutes between 1 and 525600),
  requires_note boolean not null default false,
  requires_callback boolean not null default false,
  requires_order boolean not null default false,
  sort_order integer not null default 100,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(tenant_id,id),
  unique(list_id,key),
  foreign key(tenant_id,list_id) references public.customer_lists(tenant_id,id) on delete cascade
);

alter table public.customer_list_members
  add column if not exists id uuid not null default gen_random_uuid(),
  add column if not exists source_segment_id uuid,
  add column if not exists assigned_user_id uuid,
  add column if not exists state text not null default 'pending',
  add column if not exists priority integer not null default 100,
  add column if not exists attempts integer not null default 0,
  add column if not exists next_attempt_at timestamptz,
  add column if not exists last_call_id uuid,
  add column if not exists outcome text,
  add column if not exists claimed_by uuid,
  add column if not exists claim_expires_at timestamptz,
  add column if not exists last_contacted_at timestamptz,
  add column if not exists completed_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();
alter table public.customer_list_members drop constraint if exists customer_list_members_state_check;
alter table public.customer_list_members add constraint customer_list_members_state_check check(state in ('pending','claimed','dialing','after_call','retry','callback','completed','blocked','skipped'));
alter table public.customer_list_members drop constraint if exists customer_list_members_attempts_check;
alter table public.customer_list_members add constraint customer_list_members_attempts_check check(attempts >= 0 and priority between 0 and 10000);
alter table public.customer_list_members add constraint customer_list_members_tenant_id_id_key unique(tenant_id,id);
alter table public.customer_list_members add constraint customer_list_members_assigned_user_fk
  foreign key(tenant_id,assigned_user_id) references public.tenant_memberships(tenant_id,user_id) on delete set null;
alter table public.customer_list_members add constraint customer_list_members_claimed_by_fk
  foreign key(tenant_id,claimed_by) references public.tenant_memberships(tenant_id,user_id) on delete set null;
alter table public.customer_list_members add constraint customer_list_members_source_segment_fk
  foreign key(tenant_id,source_segment_id) references public.segments(tenant_id,id) on delete set null;

create table public.customer_list_contact_candidates (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  list_id uuid not null,
  customer_id uuid not null,
  segment_id uuid,
  status text not null default 'pending' check(status in ('pending','pending_nix','approved','blocked')),
  policy_reason text,
  evaluated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(list_id,customer_id),
  foreign key(tenant_id,list_id) references public.customer_lists(tenant_id,id) on delete cascade,
  foreign key(tenant_id,customer_id) references public.customers(tenant_id,id) on delete cascade,
  foreign key(tenant_id,segment_id) references public.segments(tenant_id,id) on delete set null
);

create table public.dialer_sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  list_id uuid not null,
  user_id uuid not null,
  mode text not null check(mode in ('manual','automatic')),
  state text not null default 'active' check(state in ('active','calling','after_call','paused','ended')),
  current_list_member_id uuid,
  current_callback_activity_id uuid,
  current_call_id uuid,
  started_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  paused_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(tenant_id,id),
  foreign key(tenant_id,list_id) references public.customer_lists(tenant_id,id) on delete cascade,
  foreign key(tenant_id,user_id) references public.tenant_memberships(tenant_id,user_id) on delete cascade,
  foreign key(tenant_id,current_list_member_id) references public.customer_list_members(tenant_id,id) on delete set null,
  foreign key(tenant_id,current_callback_activity_id) references public.activities(tenant_id,id) on delete set null
);
create unique index dialer_sessions_one_open_idx on public.dialer_sessions(tenant_id,list_id,user_id) where state <> 'ended';

alter table public.calls
  add column if not exists list_id uuid,
  add column if not exists list_member_id uuid,
  add column if not exists dialer_session_id uuid,
  add column if not exists callback_activity_id uuid,
  add column if not exists after_call_completed_at timestamptz;
alter table public.calls add constraint calls_list_tenant_fk foreign key(tenant_id,list_id) references public.customer_lists(tenant_id,id) on delete set null;
alter table public.calls add constraint calls_list_member_tenant_fk foreign key(tenant_id,list_member_id) references public.customer_list_members(tenant_id,id) on delete set null;
alter table public.calls add constraint calls_dialer_session_tenant_fk foreign key(tenant_id,dialer_session_id) references public.dialer_sessions(tenant_id,id) on delete set null;

alter table public.dialer_sessions add constraint dialer_sessions_current_call_fk
  foreign key(tenant_id,current_call_id) references public.calls(tenant_id,id) on delete set null;
alter table public.customer_list_members add constraint customer_list_members_last_call_fk
  foreign key(tenant_id,last_call_id) references public.calls(tenant_id,id) on delete set null;

alter table public.activities
  add column if not exists list_id uuid,
  add column if not exists call_id uuid,
  add column if not exists callback_scope text,
  add column if not exists claimed_by uuid,
  add column if not exists claim_expires_at timestamptz,
  add column if not exists snoozed_until timestamptz,
  add column if not exists handled_at timestamptz;
alter table public.activities add constraint activities_callback_scope_check check(callback_scope is null or callback_scope in ('personal','global'));
alter table public.activities add constraint activities_list_tenant_fk foreign key(tenant_id,list_id) references public.customer_lists(tenant_id,id) on delete set null;
alter table public.activities add constraint activities_call_tenant_fk foreign key(tenant_id,call_id) references public.calls(tenant_id,id) on delete set null;
alter table public.activities add constraint activities_claimed_by_fk foreign key(tenant_id,claimed_by) references public.tenant_memberships(tenant_id,user_id) on delete set null;
alter table public.calls add constraint calls_callback_activity_tenant_fk foreign key(tenant_id,callback_activity_id) references public.activities(tenant_id,id) on delete set null;

alter table public.notes
  add column if not exists call_id uuid,
  add column if not exists list_id uuid,
  add column if not exists note_type text not null default 'general',
  add column if not exists archived_at timestamptz;
alter table public.notes add constraint notes_visibility_check check(visibility in ('private','team','tenant'));
alter table public.notes add constraint notes_type_check check(note_type in ('general','call','callback','order','internal'));
alter table public.notes add constraint notes_call_tenant_fk foreign key(tenant_id,call_id) references public.calls(tenant_id,id) on delete set null;
alter table public.notes add constraint notes_list_tenant_fk foreign key(tenant_id,list_id) references public.customer_lists(tenant_id,id) on delete set null;

create table public.note_revisions (
  id bigint generated always as identity primary key,
  tenant_id uuid not null,
  note_id uuid not null,
  body text not null,
  visibility text not null,
  is_pinned boolean not null,
  changed_by uuid references auth.users(id) on delete set null,
  changed_at timestamptz not null default now(),
  foreign key(tenant_id,note_id) references public.notes(tenant_id,id) on delete cascade
);

create table public.sales_orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  order_number text not null,
  customer_id uuid not null,
  source_call_id uuid,
  source_list_id uuid,
  owner_user_id uuid references auth.users(id) on delete set null,
  status text not null default 'draft' check(status in ('draft','confirmed','fulfilled','cancelled')),
  currency text not null default 'SEK',
  subtotal numeric not null default 0,
  discount_total numeric not null default 0,
  total numeric not null default 0,
  notes text,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(tenant_id,id),
  unique(tenant_id,order_number),
  foreign key(tenant_id,customer_id) references public.customers(tenant_id,id) on delete restrict,
  foreign key(tenant_id,source_call_id) references public.calls(tenant_id,id) on delete set null,
  foreign key(tenant_id,source_list_id) references public.customer_lists(tenant_id,id) on delete set null
);

create table public.sales_order_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  order_id uuid not null,
  product_id uuid,
  price_version_id uuid,
  description text not null,
  quantity numeric not null default 1 check(quantity > 0),
  unit_price numeric not null default 0 check(unit_price >= 0),
  discount numeric not null default 0 check(discount >= 0),
  line_total numeric not null default 0 check(line_total >= 0),
  created_at timestamptz not null default now(),
  unique(tenant_id,id),
  foreign key(tenant_id,order_id) references public.sales_orders(tenant_id,id) on delete cascade,
  foreign key(tenant_id,product_id) references public.products(tenant_id,id) on delete restrict,
  foreign key(tenant_id,price_version_id) references public.product_price_versions(tenant_id,id) on delete restrict
);

create index customer_list_sellers_user_idx on public.customer_list_seller_assignments(tenant_id,user_id,status,list_id);
create index customer_list_members_next_idx on public.customer_list_members(tenant_id,list_id,state,next_attempt_at,priority desc);
create index customer_list_candidates_status_idx on public.customer_list_contact_candidates(tenant_id,list_id,status);
create index activities_callback_due_idx on public.activities(tenant_id,type,status,due_at) where type='callback';
create index sales_orders_customer_idx on public.sales_orders(tenant_id,customer_id,created_at desc);

-- The original generic trigger referenced contract_id on calls. PostgreSQL records are
-- shape-specific, so each table branch must only access columns that table owns.
create or replace function public.enforce_outbound_contact_policy() returns trigger
language plpgsql security definer set search_path=public as $$
declare v_channel text; v_policy jsonb; v_amount numeric:=1;
begin
  if tg_table_name='calls' then
    if new.direction<>'outbound' or new.status<>'queued' then return new; end if;
    v_channel:='call';
  elsif tg_table_name='sms_messages' then
    if new.direction<>'outbound' or new.status<>'queued' then return new; end if;
    v_channel:='sms'; v_amount:=greatest(1,ceil(length(new.body)::numeric/160));
    if new.contract_id is not null and new.purpose='direct_marketing' then new.purpose:='contract_delivery'; end if;
  elsif tg_table_name='email_messages' then
    if new.direction<>'outbound' or new.status<>'queued' then return new; end if;
    v_channel:='email';
    if new.contract_id is not null and new.purpose='direct_marketing' then new.purpose:='contract_delivery'; end if;
  else raise exception 'unsupported_contact_policy_table';
  end if;
  if new.customer_id is null then raise exception 'outbound_customer_required'; end if;
  v_policy:=public.evaluate_contact_policy_for_tenant(new.tenant_id,new.customer_id,v_channel,new.purpose);
  if not coalesce((v_policy->>'allowed')::boolean,false) then raise exception 'contact_not_allowed:%',coalesce(v_policy->>'reason','unknown'); end if;
  perform public.reserve_usage_for_tenant(new.tenant_id,case v_channel when 'call' then 'calls_started' when 'sms' then 'sms_parts' else 'emails_sent' end,v_amount);
  return new;
end $$;

create trigger customer_list_sellers_touch before update on public.customer_list_seller_assignments for each row execute function public.touch_updated_at();
create trigger list_dispositions_touch before update on public.list_dispositions for each row execute function public.touch_updated_at();
create trigger customer_list_contact_candidates_touch before update on public.customer_list_contact_candidates for each row execute function public.touch_updated_at();
create trigger customer_list_members_touch before update on public.customer_list_members for each row execute function public.touch_updated_at();
create trigger dialer_sessions_touch before update on public.dialer_sessions for each row execute function public.touch_updated_at();
create trigger sales_orders_touch before update on public.sales_orders for each row execute function public.touch_updated_at();

create or replace function public.capture_note_revision() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  if old.body is distinct from new.body or old.visibility is distinct from new.visibility or old.is_pinned is distinct from new.is_pinned then
    insert into public.note_revisions(tenant_id,note_id,body,visibility,is_pinned,changed_by)
    values(old.tenant_id,old.id,old.body,old.visibility,old.is_pinned,auth.uid());
  end if;
  return new;
end $$;
create trigger notes_capture_revision before update on public.notes for each row execute function public.capture_note_revision();

create or replace function public.can_manage_customer_list(p_list_id uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select exists(
    select 1 from public.customer_lists l
    where l.id=p_list_id and l.tenant_id=public.current_tenant_id()
      and (
        public.is_tenant_admin(l.tenant_id)
        or l.owner_user_id=auth.uid()
        or (
          public.has_current_role(array['team_lead'])
          and l.team_id is not null
          and exists(select 1 from public.team_members tm where tm.tenant_id=l.tenant_id and tm.team_id=l.team_id and tm.user_id=auth.uid() and tm.role='manager')
        )
      )
  )
$$;

create or replace function public.can_work_customer_list(p_list_id uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select public.can_manage_customer_list(p_list_id) or exists(
    select 1 from public.customer_list_seller_assignments a
    join public.customer_lists l on l.tenant_id=a.tenant_id and l.id=a.list_id
    where a.list_id=p_list_id and a.tenant_id=public.current_tenant_id() and a.user_id=auth.uid()
      and a.status='active' and l.status='active'
      and (a.starts_at is null or a.starts_at<=now()) and (a.ends_at is null or a.ends_at>now())
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
      or (c.assigned_team_id is not null and exists(select 1 from public.team_members tm where tm.tenant_id=c.tenant_id and tm.team_id=c.assigned_team_id and tm.user_id=auth.uid()))
      or exists(
        select 1 from public.customer_list_members lm
        where lm.tenant_id=c.tenant_id and lm.customer_id=c.id and public.can_work_customer_list(lm.list_id)
      )
    )
  )
$$;

create or replace function public.seed_list_dispositions(p_tenant uuid,p_list uuid)
returns void language plpgsql security definer set search_path=public as $$
begin
  insert into public.list_dispositions(tenant_id,list_id,key,label,outcome_group,terminal,retry_after_minutes,requires_note,requires_callback,requires_order,sort_order) values
    (p_tenant,p_list,'interested','Intresserad','positive',true,null,false,false,false,10),
    (p_tenant,p_list,'order','Order skapad','positive',true,null,false,false,true,20),
    (p_tenant,p_list,'callback','Återkomst bokad','neutral',false,null,true,true,false,30),
    (p_tenant,p_list,'no_answer','Inget svar','unreachable',false,1440,false,false,false,40),
    (p_tenant,p_list,'busy','Upptaget','unreachable',false,120,false,false,false,50),
    (p_tenant,p_list,'voicemail','Telefonsvarare','unreachable',false,1440,false,false,false,60),
    (p_tenant,p_list,'not_interested','Inte intresserad','negative',true,null,false,false,false,70),
    (p_tenant,p_list,'wrong_number','Fel nummer','negative',true,null,true,false,false,80),
    (p_tenant,p_list,'do_not_call','Ring inte igen','blocked',true,null,true,false,false,90)
  on conflict(list_id,key) do nothing;
end $$;

create or replace function public.create_managed_customer_list(
  p_name text,p_description text,p_list_type text,p_team_id uuid,p_dialing_mode text,p_priority integer,
  p_start_time time,p_end_time time,p_max_attempts integer,p_retry_delay_minutes integer,p_auto_next_delay_seconds integer,
  p_callback_policy text,p_allow_skip boolean,p_allow_browse boolean,p_script text
) returns uuid language plpgsql security definer set search_path=public as $$
declare v_tenant uuid:=public.current_tenant_id(); v_user uuid:=auth.uid(); v_list uuid;
begin
  if v_tenant is null or v_user is null then raise exception 'authentication_required'; end if;
  if not public.has_current_role(array['owner','admin','team_lead']) then raise exception 'list_manage_permission_required'; end if;
  if nullif(trim(p_name),'') is null then raise exception 'list_name_required'; end if;
  if p_team_id is not null and not exists(select 1 from public.teams where tenant_id=v_tenant and id=p_team_id) then raise exception 'team_not_found'; end if;
  if public.has_current_role(array['team_lead']) and not public.is_tenant_admin(v_tenant) and (
    p_team_id is null or not exists(select 1 from public.team_members where tenant_id=v_tenant and team_id=p_team_id and user_id=v_user and role='manager')
  ) then raise exception 'team_list_manage_permission_required'; end if;
  insert into public.customer_lists(
    tenant_id,name,description,list_type,team_id,owner_user_id,status,dialing_mode,priority,allowed_start_time,allowed_end_time,
    max_attempts,retry_delay_minutes,auto_next_delay_seconds,callback_policy,allow_skip,allow_browse,script
  ) values(
    v_tenant,trim(p_name),nullif(trim(p_description),''),p_list_type,p_team_id,v_user,'draft',p_dialing_mode,
    greatest(0,least(p_priority,10000)),p_start_time,p_end_time,greatest(1,least(p_max_attempts,100)),
    greatest(1,least(p_retry_delay_minutes,525600)),greatest(0,least(p_auto_next_delay_seconds,300)),
    p_callback_policy,p_allow_skip,p_allow_browse,nullif(p_script,'')
  ) returning id into v_list;
  perform public.seed_list_dispositions(v_tenant,v_list);
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
  values(v_tenant,v_user,'customer_list.created','customer_list',v_list::text,jsonb_build_object('name',p_name,'dialing_mode',p_dialing_mode));
  return v_list;
end $$;

create or replace function public.update_customer_list_configuration(
  p_list_id uuid,p_name text,p_description text,p_status text,p_dialing_mode text,p_priority integer,p_start_time time,p_end_time time,
  p_max_attempts integer,p_retry_delay_minutes integer,p_auto_next_delay_seconds integer,p_callback_policy text,
  p_allow_skip boolean,p_allow_browse boolean,p_lock_to_seller boolean,p_script text,p_timezone text,p_allowed_days integer[],
  p_outbound_phone_number_id uuid,p_recording_enabled boolean,p_starts_at timestamptz,p_ends_at timestamptz
) returns void language plpgsql security definer set search_path=public as $$
begin
  if not public.can_manage_customer_list(p_list_id) then raise exception 'list_manage_permission_required'; end if;
  if nullif(trim(p_timezone),'') is null then raise exception 'list_timezone_required'; end if;
  if coalesce(array_length(p_allowed_days,1),0)=0 or exists(select 1 from unnest(p_allowed_days) day where day not between 1 and 7) then raise exception 'list_allowed_days_invalid'; end if;
  if p_ends_at is not null and p_starts_at is not null and p_ends_at<=p_starts_at then raise exception 'list_end_must_follow_start'; end if;
  if p_outbound_phone_number_id is not null and not exists(
    select 1 from public.phone_numbers where tenant_id=public.current_tenant_id() and id=p_outbound_phone_number_id and status='active' and supports_voice
  ) then raise exception 'active_voice_number_required'; end if;
  update public.customer_lists set name=trim(p_name),description=nullif(trim(p_description),''),status=p_status,dialing_mode=p_dialing_mode,
    priority=greatest(0,least(p_priority,10000)),allowed_start_time=p_start_time,allowed_end_time=p_end_time,
    max_attempts=greatest(1,least(p_max_attempts,100)),retry_delay_minutes=greatest(1,least(p_retry_delay_minutes,525600)),
    auto_next_delay_seconds=greatest(0,least(p_auto_next_delay_seconds,300)),callback_policy=p_callback_policy,
    allow_skip=p_allow_skip,allow_browse=p_allow_browse,lock_to_seller=p_lock_to_seller,script=nullif(p_script,''),timezone=trim(p_timezone),
    allowed_days=(select array_agg(distinct day order by day) from unnest(p_allowed_days) day),outbound_phone_number_id=p_outbound_phone_number_id,
    starts_at=p_starts_at,ends_at=p_ends_at,settings=jsonb_set(settings,'{recordingEnabled}',to_jsonb(p_recording_enabled),true)
  where tenant_id=public.current_tenant_id() and id=p_list_id;
  if not found then raise exception 'list_not_found'; end if;
end $$;

create or replace function public.set_customer_list_sellers(p_list_id uuid,p_user_ids uuid[])
returns integer language plpgsql security definer set search_path=public as $$
declare v_tenant uuid:=public.current_tenant_id(); v_user uuid:=auth.uid(); v_team uuid; v_count integer;
begin
  if not public.can_manage_customer_list(p_list_id) then raise exception 'list_manage_permission_required'; end if;
  select team_id into v_team from public.customer_lists where tenant_id=v_tenant and id=p_list_id;
  if exists(
    select 1 from unnest(coalesce(p_user_ids,'{}'::uuid[])) x(user_id)
    where not exists(select 1 from public.tenant_memberships m where m.tenant_id=v_tenant and m.user_id=x.user_id and m.status='active' and m.role in ('sales','team_lead','admin','owner'))
      or (v_team is not null and not exists(select 1 from public.team_members tm where tm.tenant_id=v_tenant and tm.team_id=v_team and tm.user_id=x.user_id))
  ) then raise exception 'seller_not_active_in_list_team'; end if;
  update public.customer_list_seller_assignments set status='ended',ends_at=coalesce(ends_at,now()),updated_at=now()
    where tenant_id=v_tenant and list_id=p_list_id and status<>'ended'
      and not (user_id=any(coalesce(p_user_ids,'{}'::uuid[])));
  insert into public.customer_list_seller_assignments(tenant_id,list_id,user_id,created_by)
    select v_tenant,p_list_id,x.user_id,v_user from unnest(coalesce(p_user_ids,'{}'::uuid[])) x(user_id)
    on conflict(list_id,user_id) do update set status='active',ends_at=null,updated_at=now();
  get diagnostics v_count=row_count;
  return v_count;
end $$;

create or replace function public.add_customers_to_list(p_list_id uuid,p_customer_ids uuid[])
returns integer language plpgsql security definer set search_path=public as $$
declare v_tenant uuid:=public.current_tenant_id(); v_user uuid:=auth.uid(); v_count integer;
begin
  if not public.can_manage_customer_list(p_list_id) then raise exception 'list_manage_permission_required'; end if;
  if exists(select 1 from unnest(coalesce(p_customer_ids,'{}'::uuid[])) x(id) where not exists(select 1 from public.customers c where c.tenant_id=v_tenant and c.id=x.id and c.deleted_at is null)) then
    raise exception 'customer_not_found';
  end if;
  insert into public.customer_list_members(tenant_id,list_id,customer_id,added_by)
    select v_tenant,p_list_id,x.id,v_user from unnest(coalesce(p_customer_ids,'{}'::uuid[])) x(id)
    on conflict(list_id,customer_id) do update set state=case when public.customer_list_members.state in ('completed','blocked') then public.customer_list_members.state else 'pending' end,updated_at=now();
  get diagnostics v_count=row_count;
  return v_count;
end $$;

create or replace function public.materialize_segment_to_customer_list(p_segment_id uuid,p_list_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_tenant uuid:=public.current_tenant_id(); v_actor uuid:=auth.uid(); v_segment public.segments%rowtype;
  v_list public.customer_lists%rowtype; v_snapshot uuid; v_row record; v_customer uuid; v_policy jsonb;
  v_created integer:=0; v_added integer:=0; v_pending_nix integer:=0; v_blocked integer:=0; v_removed integer:=0; v_affected integer:=0;
begin
  if v_actor is null or v_tenant is null then raise exception 'authentication_required'; end if;
  if not public.can_manage_customer_list(p_list_id) then raise exception 'list_manage_permission_required'; end if;
  select * into v_list from public.customer_lists where tenant_id=v_tenant and id=p_list_id for update;
  if not found then raise exception 'list_not_found'; end if;
  select * into v_segment from public.segments where tenant_id=v_tenant and id=p_segment_id and active;
  if not found then raise exception 'segment_not_found'; end if;

  perform public.refresh_segment_materialization(v_segment.id,v_actor);
  select id into v_snapshot from public.segment_snapshots where tenant_id=v_tenant and segment_id=v_segment.id order by generated_at desc limit 1;

  for v_row in
    select me.* from public.segment_memberships sm join public.master_entities me on me.id=sm.master_entity_id
    where sm.tenant_id=v_tenant and sm.snapshot_id=v_snapshot
  loop
    select customer_id into v_customer from public.tenant_entities where tenant_id=v_tenant and master_entity_id=v_row.id;
    if v_customer is null then
      insert into public.customers(
        tenant_id,customer_type,display_name,organization_number,email,phone_e164,address_line1,postal_code,city,
        lifecycle,assigned_team_id,source_name,source_external_id,created_by
      ) values(
        v_tenant,case when v_row.entity_type='person' then 'person'::public.customer_type else 'company'::public.customer_type end,
        v_row.canonical_name,v_row.organization_number,v_row.email,v_row.phone_e164,v_row.address_line1,v_row.postal_code,v_row.city,
        'prospect',v_list.team_id,'Kundexa directory',v_row.id::text,v_actor
      ) returning id into v_customer;
      insert into public.tenant_entities(tenant_id,master_entity_id,customer_id,relationship,created_by)
      values(v_tenant,v_row.id,v_customer,'prospect',v_actor)
      on conflict(tenant_id,master_entity_id) do update set customer_id=excluded.customer_id,updated_at=now();
      v_created:=v_created+1;
    end if;

    v_policy:=public.evaluate_contact_policy_for_tenant(v_tenant,v_customer,'call','direct_marketing');
    insert into public.customer_list_contact_candidates(tenant_id,list_id,customer_id,segment_id,status,policy_reason,evaluated_at)
    values(
      v_tenant,p_list_id,v_customer,v_segment.id,
      case when v_policy->>'allowed'='true' then 'approved' when v_policy->>'reason'='nix_check_required' then 'pending_nix' else 'blocked' end,
      coalesce(v_policy->>'reason','unknown'),now()
    ) on conflict(list_id,customer_id) do update set
      segment_id=excluded.segment_id,status=excluded.status,policy_reason=excluded.policy_reason,evaluated_at=now(),updated_at=now();

    if v_policy->>'allowed'='true' then
      insert into public.customer_list_members(tenant_id,list_id,customer_id,source_segment_id,added_by)
      values(v_tenant,p_list_id,v_customer,v_segment.id,v_actor) on conflict(list_id,customer_id) do nothing;
      get diagnostics v_affected=row_count;
      v_added:=v_added+v_affected;
    elsif v_policy->>'reason'='nix_check_required' then
      if exists(select 1 from public.nix_provider_configurations where tenant_id=v_tenant and status='active') then
        perform public.queue_nix_check_for_customer(v_tenant,v_customer,v_actor,false);
      end if;
      v_pending_nix:=v_pending_nix+1;
    else
      v_blocked:=v_blocked+1;
    end if;
  end loop;

  if v_list.list_type='dynamic' then
    delete from public.customer_list_members lm
    using public.tenant_entities te
    where lm.tenant_id=v_tenant and lm.list_id=p_list_id and lm.source_segment_id=v_segment.id
      and lm.attempts=0 and lm.state in ('pending','retry','skipped')
      and te.tenant_id=v_tenant and te.customer_id=lm.customer_id
      and not exists(
        select 1 from public.segment_memberships sm
        where sm.tenant_id=v_tenant and sm.snapshot_id=v_snapshot and sm.master_entity_id=te.master_entity_id
      );
    get diagnostics v_removed=row_count;
  end if;

  update public.customer_lists set filter_definition=jsonb_build_object(
    'source','segment','segmentId',v_segment.id,'segmentName',v_segment.name,'snapshotId',v_snapshot,'syncedAt',now()
  ) where tenant_id=v_tenant and id=p_list_id;
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
  values(v_tenant,v_actor,'customer_list.segment_materialized','customer_list',p_list_id::text,jsonb_build_object(
    'segmentId',v_segment.id,'snapshotId',v_snapshot,'createdCustomers',v_created,'addedToList',v_added,
    'pendingNix',v_pending_nix,'blocked',v_blocked,'removedFromDynamicList',v_removed
  ));
  return jsonb_build_object('snapshotId',v_snapshot,'createdCustomers',v_created,'addedToList',v_added,
    'pendingNix',v_pending_nix,'blocked',v_blocked,'removedFromDynamicList',v_removed);
end $$;

-- Preserve campaign handling and release approved list candidates from the same NIX worker.
create or replace function public.complete_nix_check_job(p_job_id uuid,p_result text,p_source_version text default null,p_evidence jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path=public as $$
declare j public.nix_check_jobs%rowtype; cfg public.nix_provider_configurations%rowtype; candidate record; policy jsonb;
begin
  if p_result not in ('listed','not_listed','unknown','error') then raise exception 'invalid_nix_result'; end if;
  select * into j from public.nix_check_jobs where id=p_job_id for update; if not found then raise exception 'nix_job_not_found'; end if;
  select * into cfg from public.nix_provider_configurations where id=j.configuration_id;
  insert into public.nix_checks(tenant_id,customer_id,phone_e164,source,source_version,result,checked_at,valid_until,evidence)
  values(j.tenant_id,j.customer_id,j.phone_e164,cfg.name,p_source_version,p_result,now(),now()+make_interval(days=>cfg.validity_days),coalesce(p_evidence,'{}'));
  update public.nix_check_jobs set status='completed',completed_at=now(),locked_at=null,locked_by=null,last_error=null where id=j.id;
  for candidate in select * from public.campaign_contact_candidates where tenant_id=j.tenant_id and customer_id=j.customer_id and status='pending_nix' for update loop
    policy:=public.evaluate_contact_policy_for_tenant(j.tenant_id,j.customer_id,'call','direct_marketing');
    if policy->>'allowed'='true' then
      insert into public.campaign_members(tenant_id,campaign_id,customer_id) values(j.tenant_id,candidate.campaign_id,j.customer_id) on conflict do nothing;
      update public.campaign_contact_candidates set status='approved',policy_reason='allowed',evaluated_at=now() where campaign_id=candidate.campaign_id and customer_id=j.customer_id;
    else
      update public.campaign_contact_candidates set status='blocked',policy_reason=policy->>'reason',evaluated_at=now() where campaign_id=candidate.campaign_id and customer_id=j.customer_id;
    end if;
  end loop;
  for candidate in select * from public.customer_list_contact_candidates where tenant_id=j.tenant_id and customer_id=j.customer_id and status='pending_nix' for update loop
    policy:=public.evaluate_contact_policy_for_tenant(j.tenant_id,j.customer_id,'call','direct_marketing');
    if policy->>'allowed'='true' then
      insert into public.customer_list_members(tenant_id,list_id,customer_id,source_segment_id,added_by)
      values(j.tenant_id,candidate.list_id,j.customer_id,candidate.segment_id,j.requested_by) on conflict(list_id,customer_id) do nothing;
      update public.customer_list_contact_candidates set status='approved',policy_reason='allowed',evaluated_at=now() where list_id=candidate.list_id and customer_id=j.customer_id;
    else
      update public.customer_list_contact_candidates set status='blocked',policy_reason=policy->>'reason',evaluated_at=now() where list_id=candidate.list_id and customer_id=j.customer_id;
    end if;
  end loop;
end $$;

create or replace function public.refresh_due_dynamic_customer_lists(p_limit integer default 100)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_list record; v_previous_sub text:=current_setting('request.jwt.claim.sub',true); v_completed integer:=0; v_failed integer:=0;
begin
  for v_list in
    select l.id,l.owner_user_id,(l.filter_definition->>'segmentId')::uuid segment_id
    from public.customer_lists l join public.segments s on s.tenant_id=l.tenant_id and s.id=(l.filter_definition->>'segmentId')::uuid
    where l.list_type='dynamic' and l.status='active' and l.filter_definition->>'source'='segment' and s.active
      and coalesce((l.filter_definition->>'syncedAt')::timestamptz,'epoch'::timestamptz)<coalesce(s.last_refreshed_at,now())
      and l.owner_user_id is not null and exists(
        select 1 from public.tenant_memberships m where m.tenant_id=l.tenant_id and m.user_id=l.owner_user_id and m.status='active'
      )
    order by s.last_refreshed_at nulls first,l.updated_at limit greatest(1,least(p_limit,500))
  loop
    begin
      perform set_config('request.jwt.claim.sub',v_list.owner_user_id::text,true);
      perform public.materialize_segment_to_customer_list(v_list.segment_id,v_list.id);
      v_completed:=v_completed+1;
    exception when others then
      v_failed:=v_failed+1;
    end;
  end loop;
  perform set_config('request.jwt.claim.sub',coalesce(v_previous_sub,''),true);
  return jsonb_build_object('completed',v_completed,'failed',v_failed);
end $$;

create or replace function public.start_dialer_session(p_list_id uuid)
returns uuid language plpgsql security definer set search_path=public as $$
declare v_tenant uuid:=public.current_tenant_id(); v_user uuid:=auth.uid(); v_mode text; v_session uuid;
begin
  if not public.can_work_customer_list(p_list_id) then raise exception 'list_work_permission_required'; end if;
  select dialing_mode into v_mode from public.customer_lists where tenant_id=v_tenant and id=p_list_id and status='active';
  if not found then raise exception 'list_not_active'; end if;
  select id into v_session from public.dialer_sessions where tenant_id=v_tenant and list_id=p_list_id and user_id=v_user and state<>'ended' for update;
  if v_session is null then
    insert into public.dialer_sessions(tenant_id,list_id,user_id,mode) values(v_tenant,p_list_id,v_user,v_mode) returning id into v_session;
  else
    update public.dialer_sessions set state='active',mode=v_mode,paused_at=null,last_seen_at=now() where id=v_session;
  end if;
  return v_session;
end $$;

create or replace function public.claim_next_list_member(p_list_id uuid,p_session_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_tenant uuid:=public.current_tenant_id(); v_user uuid:=auth.uid(); v_list public.customer_lists%rowtype;
  v_session public.dialer_sessions%rowtype; v_member public.customer_list_members%rowtype; v_customer public.customers%rowtype;
  v_callback public.activities%rowtype; v_local timestamp; v_time time; v_callback_id uuid; v_notes jsonb;
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
  if exists(
    select 1 from public.customer_list_seller_assignments a where a.tenant_id=v_tenant and a.list_id=p_list_id and a.user_id=v_user
      and a.daily_capacity is not null and (
        select count(*) from public.calls c where c.tenant_id=v_tenant and c.list_id=p_list_id and c.user_id=v_user
          and (c.created_at at time zone v_list.timezone)::date=v_local::date
      )>=a.daily_capacity
  ) then raise exception 'seller_daily_capacity_reached'; end if;

  update public.customer_list_members set state=case when attempts>=v_list.max_attempts then 'completed' else 'retry' end,claimed_by=null,claim_expires_at=null
    where tenant_id=v_tenant and list_id=p_list_id and state in ('claimed','dialing') and claim_expires_at<now();
  update public.activities set status='open',claimed_by=null,claim_expires_at=null
    where tenant_id=v_tenant and list_id=p_list_id and type='callback' and status='in_progress' and claim_expires_at<now();

  if v_session.current_list_member_id is not null then
    select * into v_member from public.customer_list_members where tenant_id=v_tenant and id=v_session.current_list_member_id and claimed_by=v_user and claim_expires_at>now();
    v_callback_id:=v_session.current_callback_activity_id;
  end if;

  if v_member.id is null then
    select a.* into v_callback from public.activities a
    where a.tenant_id=v_tenant and a.list_id=p_list_id and a.type='callback' and a.status='open'
      and coalesce(a.snoozed_until,a.due_at)<=now()
      and (a.assigned_user_id=v_user or (a.callback_scope='global' and (a.assigned_team_id is null or exists(select 1 from public.team_members tm where tm.tenant_id=v_tenant and tm.team_id=a.assigned_team_id and tm.user_id=v_user))))
    order by coalesce(a.snoozed_until,a.due_at),a.created_at for update skip locked limit 1;
    if v_callback.id is not null then
      update public.activities set status='in_progress',claimed_by=v_user,claim_expires_at=now()+interval '10 minutes' where id=v_callback.id;
      select * into v_member from public.customer_list_members where tenant_id=v_tenant and list_id=p_list_id and customer_id=v_callback.customer_id for update;
      v_callback_id:=v_callback.id;
    end if;
  end if;

  if v_member.id is null then
    select lm.* into v_member from public.customer_list_members lm
    join public.customers c on c.tenant_id=lm.tenant_id and c.id=lm.customer_id
    where lm.tenant_id=v_tenant and lm.list_id=p_list_id and lm.state in ('pending','retry','callback','skipped')
      and (lm.next_attempt_at is null or lm.next_attempt_at<=now()) and lm.attempts<v_list.max_attempts
      and c.deleted_at is null and c.phone_e164 is not null and not c.do_not_call and c.lifecycle<>'blocked'
      and public.evaluate_contact_policy_for_tenant(v_tenant,c.id,'call','direct_marketing')->>'allowed'='true'
      and (not v_list.lock_to_seller or lm.assigned_user_id is null or lm.assigned_user_id=v_user)
      and (lm.claimed_by is null or lm.claim_expires_at<now())
    order by case when lm.state='callback' then 0 else 1 end,lm.priority desc,lm.next_attempt_at nulls first,lm.created_at
    for update of lm skip locked limit 1;
  end if;

  if v_member.id is null then
    update public.dialer_sessions set current_list_member_id=null,current_callback_activity_id=null,current_call_id=null,last_seen_at=now() where id=p_session_id;
    return jsonb_build_object('empty',true,'sessionId',p_session_id);
  end if;
  update public.customer_list_members set state='claimed',claimed_by=v_user,claim_expires_at=now()+interval '10 minutes',assigned_user_id=coalesce(assigned_user_id,case when v_list.lock_to_seller then v_user else null end) where id=v_member.id returning * into v_member;
  update public.dialer_sessions set state='active',current_list_member_id=v_member.id,current_callback_activity_id=v_callback_id,current_call_id=null,last_seen_at=now() where id=p_session_id;
  select * into v_customer from public.customers where tenant_id=v_tenant and id=v_member.customer_id;
  select coalesce(jsonb_agg(jsonb_build_object('id',n.id,'body',n.body,'isPinned',n.is_pinned,'createdAt',n.created_at) order by n.is_pinned desc,n.created_at desc),'[]'::jsonb)
    into v_notes from (select id,body,is_pinned,created_at from public.notes where tenant_id=v_tenant and customer_id=v_member.customer_id and archived_at is null order by is_pinned desc,created_at desc limit 8) n;
  return jsonb_build_object(
    'empty',false,'sessionId',p_session_id,'memberId',v_member.id,'callbackActivityId',v_callback_id,
    'mode',v_list.dialing_mode,'autoNextDelaySeconds',v_list.auto_next_delay_seconds,'allowSkip',v_list.allow_skip,
    'script',v_list.script,'questionnaire',v_list.questionnaire,
    'customer',jsonb_build_object('id',v_customer.id,'displayName',v_customer.display_name,'customerType',v_customer.customer_type,
      'companyName',v_customer.company_name,'organizationNumber',v_customer.organization_number,'phone',v_customer.phone_e164,'email',v_customer.email,
      'address',concat_ws(', ',v_customer.address_line1,v_customer.postal_code,v_customer.city),'industry',v_customer.industry,'sniCode',v_customer.sni_code,
      'callAttempts',v_member.attempts,'lastContactAt',v_customer.last_contact_at,'customFields',v_customer.custom_fields,'notes',v_notes)
  );
end $$;

create or replace function public.release_list_member_claim(p_session_id uuid,p_reason text default 'paused')
returns void language plpgsql security definer set search_path=public as $$
declare v_tenant uuid:=public.current_tenant_id(); v_user uuid:=auth.uid(); v_member uuid; v_callback uuid;
begin
  select current_list_member_id,current_callback_activity_id into v_member,v_callback from public.dialer_sessions where tenant_id=v_tenant and id=p_session_id and user_id=v_user and state<>'ended' for update;
  if not found then raise exception 'dialer_session_not_found'; end if;
  update public.customer_list_members set state=case when p_reason='skip' then 'skipped' else 'pending' end,claimed_by=null,claim_expires_at=null where tenant_id=v_tenant and id=v_member and claimed_by=v_user;
  update public.activities set status='open',claimed_by=null,claim_expires_at=null where tenant_id=v_tenant and id=v_callback and claimed_by=v_user and status='in_progress';
  update public.dialer_sessions set state=case when p_reason='end' then 'ended' else 'paused' end,current_list_member_id=null,current_callback_activity_id=null,current_call_id=null,
    paused_at=case when p_reason<>'end' then now() else paused_at end,ended_at=case when p_reason='end' then now() else ended_at end,last_seen_at=now() where id=p_session_id;
end $$;

create or replace function public.queue_list_outbound_call(
  p_session_id uuid,p_list_member_id uuid,p_callback_activity_id uuid,p_callback_token_hash text,p_callback_token text,
  p_voice_client_number text,p_idempotency_key text,p_purpose text default 'direct_marketing'
) returns uuid language plpgsql security definer set search_path=public as $$
declare v_tenant uuid:=public.current_tenant_id(); v_user uuid:=auth.uid(); v_member public.customer_list_members%rowtype; v_session public.dialer_sessions%rowtype; v_list public.customer_lists%rowtype; v_call uuid;
begin
  select * into v_session from public.dialer_sessions where tenant_id=v_tenant and id=p_session_id and user_id=v_user and state in ('active','after_call') for update;
  if not found then raise exception 'dialer_session_not_active'; end if;
  select * into v_member from public.customer_list_members where tenant_id=v_tenant and id=p_list_member_id and list_id=v_session.list_id and claimed_by=v_user and claim_expires_at>now() for update;
  if not found then raise exception 'list_member_claim_expired'; end if;
  if p_callback_activity_id is distinct from v_session.current_callback_activity_id then raise exception 'callback_claim_mismatch'; end if;
  select * into v_list from public.customer_lists where tenant_id=v_tenant and id=v_session.list_id;
  v_call:=public.queue_outbound_call(v_member.customer_id,p_callback_token_hash,p_callback_token,p_voice_client_number,p_idempotency_key,p_purpose);
  update public.calls set list_id=v_member.list_id,list_member_id=v_member.id,dialer_session_id=p_session_id,callback_activity_id=p_callback_activity_id,
    phone_number_id=coalesce(v_list.outbound_phone_number_id,phone_number_id),
    from_number=coalesce((select number_e164 from public.phone_numbers where tenant_id=v_tenant and id=v_list.outbound_phone_number_id and status='active' and supports_voice),from_number),
    recording_enabled=coalesce((v_list.settings->>'recordingEnabled')::boolean,false),
    metadata=metadata||jsonb_build_object('mode','list_dialer','list_id',v_member.list_id,'list_member_id',v_member.id,'dialer_session_id',p_session_id)
    where tenant_id=v_tenant and id=v_call;
  update public.customer_list_members set state='dialing',attempts=attempts+1,last_call_id=v_call,last_contacted_at=now(),claim_expires_at=now()+interval '2 hours' where id=v_member.id;
  update public.dialer_sessions set state='calling',current_call_id=v_call,last_seen_at=now() where id=p_session_id;
  return v_call;
end $$;

create or replace function public.claim_customer_callback(p_activity_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_tenant uuid:=public.current_tenant_id(); v_user uuid:=auth.uid(); v_activity public.activities%rowtype;
begin
  select * into v_activity from public.activities where tenant_id=v_tenant and id=p_activity_id and type='callback' for update;
  if not found then raise exception 'callback_not_found'; end if;
  if coalesce(v_activity.snoozed_until,v_activity.due_at)>now() then raise exception 'callback_not_due'; end if;
  if v_activity.status='in_progress' and v_activity.claimed_by<>v_user and v_activity.claim_expires_at>now() then raise exception 'callback_already_claimed'; end if;
  if v_activity.callback_scope='personal' and v_activity.assigned_user_id<>v_user then raise exception 'personal_callback_owner_required'; end if;
  if v_activity.callback_scope='global' and v_activity.assigned_team_id is not null and not exists(
    select 1 from public.team_members where tenant_id=v_tenant and team_id=v_activity.assigned_team_id and user_id=v_user
  ) then raise exception 'callback_team_permission_required'; end if;
  if v_activity.status not in ('open','in_progress') then raise exception 'callback_not_open'; end if;
  update public.activities set status='in_progress',claimed_by=v_user,claim_expires_at=now()+interval '10 minutes'
    where tenant_id=v_tenant and id=p_activity_id;
  return jsonb_build_object('callbackId',v_activity.id,'customerId',v_activity.customer_id,'listId',v_activity.list_id);
end $$;

create or replace function public.snooze_customer_callback(p_activity_id uuid,p_snoozed_until timestamptz)
returns void language plpgsql security definer set search_path=public as $$
declare v_tenant uuid:=public.current_tenant_id(); v_user uuid:=auth.uid(); v_activity public.activities%rowtype;
begin
  if p_snoozed_until<=now() then raise exception 'future_snooze_required'; end if;
  select * into v_activity from public.activities where tenant_id=v_tenant and id=p_activity_id and type='callback' for update;
  if not found then raise exception 'callback_not_found'; end if;
  if not public.is_tenant_admin(v_tenant)
    and not (v_activity.callback_scope='personal' and v_activity.assigned_user_id=v_user)
    and not (v_activity.claimed_by=v_user and v_activity.claim_expires_at>now())
    and not (v_activity.list_id is not null and public.can_manage_customer_list(v_activity.list_id))
  then raise exception 'callback_snooze_permission_required'; end if;
  update public.activities set status='open',snoozed_until=p_snoozed_until,claimed_by=null,claim_expires_at=null
    where tenant_id=v_tenant and id=p_activity_id and status in ('open','in_progress');
  if not found then raise exception 'callback_not_open'; end if;
end $$;

create or replace function public.complete_customer_callback(p_activity_id uuid,p_notes text default null)
returns void language plpgsql security definer set search_path=public as $$
declare v_tenant uuid:=public.current_tenant_id(); v_user uuid:=auth.uid(); v_activity public.activities%rowtype;
begin
  select * into v_activity from public.activities where tenant_id=v_tenant and id=p_activity_id and type='callback' for update;
  if not found then raise exception 'callback_not_found'; end if;
  if not public.is_tenant_admin(v_tenant)
    and not (v_activity.callback_scope='personal' and v_activity.assigned_user_id=v_user)
    and not (v_activity.claimed_by=v_user and v_activity.claim_expires_at>now())
    and not (v_activity.list_id is not null and public.can_manage_customer_list(v_activity.list_id))
  then raise exception 'callback_complete_permission_required'; end if;
  update public.activities set status='completed',completed_at=now(),handled_at=now(),claimed_by=null,claim_expires_at=null
    where tenant_id=v_tenant and id=p_activity_id and status in ('open','in_progress');
  if not found then raise exception 'callback_not_open'; end if;
  if v_activity.customer_id is not null and nullif(trim(p_notes),'') is not null then
    insert into public.notes(tenant_id,customer_id,body,visibility,note_type,list_id,created_by)
    values(v_tenant,v_activity.customer_id,trim(p_notes),'team','callback',v_activity.list_id,v_user);
  end if;
end $$;

create or replace function public.reassign_customer_callback(p_activity_id uuid,p_user_id uuid)
returns void language plpgsql security definer set search_path=public as $$
declare v_tenant uuid:=public.current_tenant_id(); v_user uuid:=auth.uid(); v_activity public.activities%rowtype;
begin
  select * into v_activity from public.activities where tenant_id=v_tenant and id=p_activity_id and type='callback' for update;
  if not found then raise exception 'callback_not_found'; end if;
  if not public.is_tenant_admin(v_tenant) and not (v_activity.list_id is not null and public.can_manage_customer_list(v_activity.list_id)) and not (
    public.has_current_role(array['team_lead']) and v_activity.assigned_team_id is not null and exists(
      select 1 from public.team_members where tenant_id=v_tenant and team_id=v_activity.assigned_team_id and user_id=v_user and role='manager'
    )
  ) then raise exception 'callback_reassign_permission_required'; end if;
  if not exists(select 1 from public.tenant_memberships where tenant_id=v_tenant and user_id=p_user_id and status='active') then raise exception 'callback_assignee_not_active'; end if;
  if v_activity.assigned_team_id is not null and not exists(select 1 from public.team_members where tenant_id=v_tenant and team_id=v_activity.assigned_team_id and user_id=p_user_id) then raise exception 'callback_assignee_not_in_team'; end if;
  update public.activities set callback_scope='personal',assigned_user_id=p_user_id,status='open',claimed_by=null,claim_expires_at=null
    where tenant_id=v_tenant and id=p_activity_id and status in ('open','in_progress');
  if not found then raise exception 'callback_not_open'; end if;
end $$;

create or replace function public.queue_callback_outbound_call(
  p_activity_id uuid,p_customer_id uuid,p_callback_token_hash text,p_callback_token text,p_voice_client_number text,
  p_idempotency_key text,p_purpose text default 'direct_marketing'
) returns uuid language plpgsql security definer set search_path=public as $$
declare v_tenant uuid:=public.current_tenant_id(); v_user uuid:=auth.uid(); v_activity public.activities%rowtype; v_call uuid;
begin
  select * into v_activity from public.activities where tenant_id=v_tenant and id=p_activity_id and type='callback' and customer_id=p_customer_id for update;
  if not found then raise exception 'callback_not_found'; end if;
  if v_activity.callback_scope='personal' and v_activity.assigned_user_id<>v_user then raise exception 'personal_callback_owner_required'; end if;
  if v_activity.callback_scope='global' and v_activity.claimed_by<>v_user then raise exception 'global_callback_claim_required'; end if;
  if v_activity.status not in ('open','in_progress') then raise exception 'callback_not_open'; end if;
  v_call:=public.queue_outbound_call(p_customer_id,p_callback_token_hash,p_callback_token,p_voice_client_number,p_idempotency_key,p_purpose);
  update public.calls set callback_activity_id=p_activity_id,metadata=metadata||jsonb_build_object('callback_activity_id',p_activity_id) where tenant_id=v_tenant and id=v_call;
  update public.activities set status='in_progress',claimed_by=v_user,claim_expires_at=now()+interval '2 hours',call_id=v_call where tenant_id=v_tenant and id=p_activity_id;
  return v_call;
end $$;

create or replace function public.complete_manual_call_work(
  p_call_id uuid,p_disposition text,p_notes text,p_callback_scope text,p_callback_due_at timestamptz
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_tenant uuid:=public.current_tenant_id(); v_user uuid:=auth.uid(); v_call public.calls%rowtype; v_callback uuid; v_team uuid;
begin
  if p_disposition not in ('no_answer','busy','voicemail','callback','interested','not_interested','wrong_number','do_not_call') then raise exception 'manual_disposition_invalid'; end if;
  select * into v_call from public.calls where tenant_id=v_tenant and id=p_call_id and user_id=v_user for update;
  if not found or v_call.list_id is not null then raise exception 'manual_call_not_found'; end if;
  if v_call.disposition is not null then return jsonb_build_object('completed',true,'idempotentReplay',true); end if;
  if v_call.status not in ('completed','busy','no_answer','failed','cancelled') or v_call.ended_at is null then raise exception 'call_not_finished'; end if;
  if p_disposition='callback' and (p_callback_due_at is null or p_callback_due_at<=now() or p_callback_scope not in ('personal','global')) then raise exception 'future_callback_required'; end if;
  update public.calls set disposition=p_disposition,notes=nullif(trim(p_notes),''),after_call_completed_at=now() where tenant_id=v_tenant and id=p_call_id;
  update public.customers set last_contact_at=coalesce(v_call.ended_at,now()),call_attempts=call_attempts+1 where tenant_id=v_tenant and id=v_call.customer_id;
  if nullif(trim(p_notes),'') is not null then
    insert into public.notes(tenant_id,customer_id,body,visibility,note_type,call_id,created_by)
    values(v_tenant,v_call.customer_id,trim(p_notes),'team',case when p_disposition='callback' then 'callback' else 'call' end,p_call_id,v_user);
  end if;
  if v_call.callback_activity_id is not null then
    update public.activities set status='completed',completed_at=now(),handled_at=now(),claimed_by=null,claim_expires_at=null
      where tenant_id=v_tenant and id=v_call.callback_activity_id;
  end if;
  if p_disposition='callback' then
    select assigned_team_id into v_team from public.customers where tenant_id=v_tenant and id=v_call.customer_id;
    insert into public.activities(tenant_id,customer_id,type,status,title,description,assigned_user_id,assigned_team_id,priority,due_at,created_by,call_id,callback_scope)
    values(v_tenant,v_call.customer_id,'callback','open','Återkomst',nullif(trim(p_notes),''),case when p_callback_scope='personal' then v_user else null end,
      case when p_callback_scope='global' then v_team else null end,'high',p_callback_due_at,v_user,p_call_id,p_callback_scope) returning id into v_callback;
    update public.customers set next_activity_at=least(coalesce(next_activity_at,p_callback_due_at),p_callback_due_at) where tenant_id=v_tenant and id=v_call.customer_id;
  end if;
  if p_disposition='do_not_call' then
    update public.customers set do_not_call=true,blocked_reason=coalesce(nullif(trim(p_notes),''),'Kundens önskemål via manuell dialer') where tenant_id=v_tenant and id=v_call.customer_id;
    insert into public.compliance_blocks(tenant_id,customer_id,phone_e164,channels,reason,created_by)
      select v_tenant,id,phone_e164,array['call'],coalesce(nullif(trim(p_notes),''),'Kundens önskemål via manuell dialer'),v_user
      from public.customers where tenant_id=v_tenant and id=v_call.customer_id;
  end if;
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
  values(v_tenant,v_user,'manual_call.after_work_completed','call',p_call_id::text,jsonb_build_object('disposition',p_disposition,'callbackId',v_callback));
  return jsonb_build_object('completed',true,'callbackId',v_callback);
end $$;

create or replace function public.complete_dialer_work(
  p_call_id uuid,p_disposition_key text,p_notes text,p_callback_scope text,p_callback_due_at timestamptz,
  p_create_order boolean,p_product_id uuid,p_quantity numeric,p_unit_price numeric,p_idempotency_key text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_tenant uuid:=public.current_tenant_id(); v_user uuid:=auth.uid(); v_call public.calls%rowtype; v_member public.customer_list_members%rowtype;
  v_list public.customer_lists%rowtype; v_disposition public.list_dispositions%rowtype; v_order uuid; v_order_number text;
  v_product public.products%rowtype; v_price public.product_price_versions%rowtype; v_quantity numeric:=greatest(coalesce(p_quantity,1),0.0001);
  v_unit numeric; v_line numeric; v_next timestamptz; v_callback uuid; v_team uuid;
begin
  if nullif(trim(p_idempotency_key),'') is null then raise exception 'idempotency_key_required'; end if;
  select * into v_call from public.calls where tenant_id=v_tenant and id=p_call_id and user_id=v_user for update;
  if not found or v_call.list_id is null or v_call.list_member_id is null or v_call.dialer_session_id is null then raise exception 'list_call_not_found'; end if;
  if v_call.after_call_completed_at is not null then
    select id into v_order from public.sales_orders where tenant_id=v_tenant and source_call_id=p_call_id;
    return jsonb_build_object('completed',true,'idempotentReplay',true,'orderId',v_order);
  end if;
  if v_call.status not in ('completed','busy','no_answer','failed','cancelled') or v_call.ended_at is null then raise exception 'call_not_finished'; end if;
  select * into v_list from public.customer_lists where tenant_id=v_tenant and id=v_call.list_id;
  select * into v_member from public.customer_list_members where tenant_id=v_tenant and id=v_call.list_member_id for update;
  select * into v_disposition from public.list_dispositions where tenant_id=v_tenant and list_id=v_call.list_id and key=p_disposition_key and active;
  if not found then raise exception 'invalid_list_disposition'; end if;
  if v_disposition.requires_note and nullif(trim(p_notes),'') is null then raise exception 'disposition_note_required'; end if;
  if v_disposition.requires_callback and (p_callback_due_at is null or p_callback_due_at<=now()) then raise exception 'future_callback_required'; end if;
  if p_callback_scope is not null and p_callback_scope not in ('personal','global') then raise exception 'callback_scope_invalid'; end if;
  if v_disposition.requires_callback and not (v_list.callback_policy='both' or v_list.callback_policy=p_callback_scope) then raise exception 'callback_scope_not_allowed'; end if;

  update public.calls set disposition=p_disposition_key,notes=nullif(trim(p_notes),''),after_call_completed_at=now(),
    status=case when status in ('queued','initiating','ringing','answered') then 'completed' else status end,ended_at=coalesce(ended_at,now())
  where id=p_call_id;
  update public.customers set last_contact_at=now(),call_attempts=call_attempts+1 where tenant_id=v_tenant and id=v_call.customer_id;
  if nullif(trim(p_notes),'') is not null then
    insert into public.notes(tenant_id,customer_id,body,visibility,note_type,call_id,list_id,created_by)
    values(v_tenant,v_call.customer_id,trim(p_notes),'team',case when v_disposition.requires_callback then 'callback' else 'call' end,p_call_id,v_call.list_id,v_user);
  end if;

  if v_call.callback_activity_id is not null then
    update public.activities set status='completed',completed_at=now(),handled_at=now(),claimed_by=null,claim_expires_at=null where tenant_id=v_tenant and id=v_call.callback_activity_id;
  end if;
  if v_disposition.requires_callback then
    v_team:=v_list.team_id;
    insert into public.activities(tenant_id,customer_id,type,status,title,description,assigned_user_id,assigned_team_id,priority,due_at,created_by,list_id,call_id,callback_scope,metadata)
    values(v_tenant,v_call.customer_id,'callback','open','Återkomst · '||v_list.name,nullif(trim(p_notes),''),case when p_callback_scope='personal' then v_user else null end,
      case when p_callback_scope='global' then v_team else null end,'high',p_callback_due_at,v_user,v_call.list_id,p_call_id,p_callback_scope,jsonb_build_object('source','dialer','disposition',p_disposition_key))
    returning id into v_callback;
    v_next:=p_callback_due_at;
  elsif v_disposition.retry_after_minutes is not null then
    v_next:=now()+make_interval(mins=>v_disposition.retry_after_minutes);
  end if;

  if p_create_order or v_disposition.requires_order then
    if p_product_id is null then raise exception 'order_product_required'; end if;
    select * into v_product from public.products where tenant_id=v_tenant and id=p_product_id and active;
    if not found then raise exception 'active_product_not_found'; end if;
    select * into v_price from public.product_price_versions where tenant_id=v_tenant and product_id=p_product_id and active and valid_from<=current_date and (valid_to is null or valid_to>=current_date) order by version desc limit 1;
    v_unit:=coalesce(p_unit_price,v_price.setup_fee+v_price.recurring_fee,0); v_line:=round(v_quantity*v_unit,2);
    v_order_number:='KX-'||to_char(now(),'YYYYMM')||'-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,8));
    insert into public.sales_orders(tenant_id,order_number,customer_id,source_call_id,source_list_id,owner_user_id,status,currency,subtotal,total,notes,confirmed_at)
    values(v_tenant,v_order_number,v_call.customer_id,p_call_id,v_call.list_id,v_user,'confirmed',coalesce(v_price.currency,'SEK'),v_line,v_line,nullif(trim(p_notes),''),now()) returning id into v_order;
    insert into public.sales_order_items(tenant_id,order_id,product_id,price_version_id,description,quantity,unit_price,line_total)
    values(v_tenant,v_order,p_product_id,v_price.id,v_product.name,v_quantity,v_unit,v_line);
    update public.customers set lifecycle='customer' where tenant_id=v_tenant and id=v_call.customer_id and lifecycle in ('prospect','lead');
  end if;

  update public.customer_list_members set
    state=case when p_disposition_key='do_not_call' then 'blocked' when v_disposition.requires_callback then 'callback'
      when v_disposition.retry_after_minutes is not null and attempts<v_list.max_attempts then 'retry' else 'completed' end,
    outcome=p_disposition_key,next_attempt_at=v_next,claimed_by=null,claim_expires_at=null,
    completed_at=case when v_disposition.terminal or p_create_order or v_disposition.requires_order then now() else null end
  where id=v_member.id;
  if p_disposition_key='do_not_call' then
    update public.customers set do_not_call=true,blocked_reason=coalesce(nullif(trim(p_notes),''),'Kundens önskemål via dialer') where tenant_id=v_tenant and id=v_call.customer_id;
    insert into public.compliance_blocks(tenant_id,customer_id,phone_e164,channels,reason,created_by)
      select v_tenant,id,phone_e164,array['call'],coalesce(nullif(trim(p_notes),''),'Kundens önskemål via dialer'),v_user from public.customers where tenant_id=v_tenant and id=v_call.customer_id;
  end if;
  update public.customers set next_activity_at=v_next where tenant_id=v_tenant and id=v_call.customer_id;
  update public.dialer_sessions set state='active',current_list_member_id=null,current_callback_activity_id=null,current_call_id=null,last_seen_at=now() where tenant_id=v_tenant and id=v_call.dialer_session_id and user_id=v_user;
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,request_id,after_data)
  values(v_tenant,v_user,'dialer.after_call_completed','call',p_call_id::text,p_idempotency_key,jsonb_build_object('disposition',p_disposition_key,'callback_id',v_callback,'order_id',v_order));
  return jsonb_build_object('completed',true,'orderId',v_order,'callbackId',v_callback,'nextAttemptAt',v_next,'autoNextDelaySeconds',v_list.auto_next_delay_seconds);
end $$;

create or replace function public.schedule_customer_callback(
  p_customer_id uuid,p_list_id uuid,p_scope text,p_due_at timestamptz,p_title text,p_description text
) returns uuid language plpgsql security definer set search_path=public as $$
declare v_tenant uuid:=public.current_tenant_id(); v_user uuid:=auth.uid(); v_team uuid; v_id uuid;
begin
  if not public.can_write_customer(p_customer_id) then raise exception 'customer_write_permission_required'; end if;
  if p_scope not in ('personal','global') or p_due_at<=now() then raise exception 'callback_details_invalid'; end if;
  if p_list_id is not null then
    if not public.can_work_customer_list(p_list_id) then raise exception 'list_work_permission_required'; end if;
    select team_id into v_team from public.customer_lists where tenant_id=v_tenant and id=p_list_id and (callback_policy='both' or callback_policy=p_scope);
    if not found then raise exception 'callback_scope_not_allowed'; end if;
  else
    select assigned_team_id into v_team from public.customers where tenant_id=v_tenant and id=p_customer_id;
  end if;
  insert into public.activities(tenant_id,customer_id,type,status,title,description,assigned_user_id,assigned_team_id,priority,due_at,created_by,list_id,callback_scope)
  values(v_tenant,p_customer_id,'callback','open',coalesce(nullif(trim(p_title),''),'Återkomst'),nullif(trim(p_description),''),case when p_scope='personal' then v_user else null end,
    case when p_scope='global' then v_team else null end,'high',p_due_at,v_user,p_list_id,p_scope) returning id into v_id;
  update public.customers set next_activity_at=least(coalesce(next_activity_at,p_due_at),p_due_at) where tenant_id=v_tenant and id=p_customer_id;
  return v_id;
end $$;

create or replace function public.create_or_match_manual_prospect(p_display_name text,p_phone_e164 text,p_customer_type public.customer_type default 'person')
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_tenant uuid:=public.current_tenant_id(); v_user uuid:=auth.uid(); v_customer public.customers%rowtype; v_created boolean:=false;
begin
  if not public.can_write_customer(null) then raise exception 'customer_write_permission_required'; end if;
  if p_phone_e164 !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'phone_must_be_e164'; end if;
  select * into v_customer from public.customers where tenant_id=v_tenant and phone_e164=p_phone_e164 and deleted_at is null order by created_at limit 1 for update;
  if not found then
    insert into public.customers(tenant_id,customer_type,lifecycle,display_name,phone_e164,source_name,created_by,assigned_user_id)
    values(v_tenant,p_customer_type,'prospect',coalesce(nullif(trim(p_display_name),''),p_phone_e164),p_phone_e164,'Manuell dialer',v_user,v_user) returning * into v_customer;
    v_created:=true;
  end if;
  return jsonb_build_object('customerId',v_customer.id,'displayName',v_customer.display_name,'created',v_created);
end $$;

-- Replace broad policies with list-aware policies and protect newly added tables.
alter table public.customer_list_seller_assignments enable row level security;
alter table public.list_dispositions enable row level security;
alter table public.customer_list_contact_candidates enable row level security;
alter table public.dialer_sessions enable row level security;
alter table public.note_revisions enable row level security;
alter table public.sales_orders enable row level security;
alter table public.sales_order_items enable row level security;

drop policy if exists customer_lists_member_select on public.customer_lists;
drop policy if exists customer_lists_operator_insert on public.customer_lists;
drop policy if exists customer_lists_owner_update on public.customer_lists;
drop policy if exists customer_lists_owner_delete on public.customer_lists;
create policy customer_lists_scoped_select on public.customer_lists for select to authenticated using(tenant_id=public.current_tenant_id() and public.can_work_customer_list(id));
create policy customer_lists_managed_write on public.customer_lists for all to authenticated
  using(tenant_id=public.current_tenant_id() and public.can_manage_customer_list(id))
  with check(tenant_id=public.current_tenant_id() and (
    public.is_tenant_admin(tenant_id)
    or (owner_user_id=auth.uid() and public.has_current_role(array['team_lead']) and team_id is not null and exists(select 1 from public.team_members tm where tm.tenant_id=customer_lists.tenant_id and tm.team_id=customer_lists.team_id and tm.user_id=auth.uid() and tm.role='manager'))
  ));

drop policy if exists customer_list_members_scoped_select on public.customer_list_members;
drop policy if exists customer_list_members_scoped_insert on public.customer_list_members;
drop policy if exists customer_list_members_scoped_delete on public.customer_list_members;
create policy customer_list_members_list_select on public.customer_list_members for select to authenticated using(tenant_id=public.current_tenant_id() and public.can_work_customer_list(list_id));
create policy customer_list_members_manager_write on public.customer_list_members for all to authenticated using(tenant_id=public.current_tenant_id() and public.can_manage_customer_list(list_id)) with check(tenant_id=public.current_tenant_id() and public.can_manage_customer_list(list_id));

create policy list_sellers_scoped_select on public.customer_list_seller_assignments for select to authenticated using(tenant_id=public.current_tenant_id() and (user_id=auth.uid() or public.can_manage_customer_list(list_id)));
create policy list_sellers_manager_write on public.customer_list_seller_assignments for all to authenticated using(tenant_id=public.current_tenant_id() and public.can_manage_customer_list(list_id)) with check(tenant_id=public.current_tenant_id() and public.can_manage_customer_list(list_id));
create policy list_dispositions_worker_select on public.list_dispositions for select to authenticated using(tenant_id=public.current_tenant_id() and public.can_work_customer_list(list_id));
create policy list_dispositions_manager_write on public.list_dispositions for all to authenticated using(tenant_id=public.current_tenant_id() and public.can_manage_customer_list(list_id)) with check(tenant_id=public.current_tenant_id() and public.can_manage_customer_list(list_id));
create policy customer_list_contact_candidates_manage on public.customer_list_contact_candidates for all to authenticated
  using(tenant_id=public.current_tenant_id() and public.can_manage_customer_list(list_id))
  with check(tenant_id=public.current_tenant_id() and public.can_manage_customer_list(list_id));
create policy dialer_sessions_scoped_select on public.dialer_sessions for select to authenticated using(tenant_id=public.current_tenant_id() and (user_id=auth.uid() or public.can_manage_customer_list(list_id)));
create policy dialer_sessions_owner_insert on public.dialer_sessions for insert to authenticated with check(tenant_id=public.current_tenant_id() and user_id=auth.uid() and public.can_work_customer_list(list_id));
create policy dialer_sessions_owner_update on public.dialer_sessions for update to authenticated using(tenant_id=public.current_tenant_id() and user_id=auth.uid()) with check(tenant_id=public.current_tenant_id() and user_id=auth.uid());
create policy note_revisions_customer_select on public.note_revisions for select to authenticated using(tenant_id=public.current_tenant_id() and exists(select 1 from public.notes n where n.tenant_id=note_revisions.tenant_id and n.id=note_revisions.note_id and public.can_access_customer(n.customer_id) and (n.visibility<>'private' or n.created_by=auth.uid() or public.is_tenant_admin(n.tenant_id))));
create policy sales_orders_customer_select on public.sales_orders for select to authenticated using(tenant_id=public.current_tenant_id() and public.can_access_customer(customer_id));
create policy sales_orders_customer_insert on public.sales_orders for insert to authenticated with check(tenant_id=public.current_tenant_id() and owner_user_id=auth.uid() and public.can_write_customer(customer_id));
create policy sales_orders_customer_update on public.sales_orders for update to authenticated using(tenant_id=public.current_tenant_id() and (owner_user_id=auth.uid() or public.is_tenant_admin(tenant_id))) with check(tenant_id=public.current_tenant_id());
create policy sales_order_items_order_select on public.sales_order_items for select to authenticated using(tenant_id=public.current_tenant_id() and exists(select 1 from public.sales_orders o where o.tenant_id=sales_order_items.tenant_id and o.id=sales_order_items.order_id and public.can_access_customer(o.customer_id)));

-- Team managers must be able to resolve the names of sellers in their own teams.
create policy profiles_team_manager_select on public.profiles for select to authenticated using(
  exists(
    select 1 from public.team_members manager
    join public.team_members colleague on colleague.tenant_id=manager.tenant_id and colleague.team_id=manager.team_id and colleague.user_id=profiles.id
    where manager.tenant_id=public.current_tenant_id() and manager.user_id=auth.uid() and manager.role='manager'
  )
);
create policy memberships_team_manager_select on public.tenant_memberships for select to authenticated using(
  tenant_id=public.current_tenant_id() and exists(
    select 1 from public.team_members manager
    join public.team_members colleague on colleague.tenant_id=manager.tenant_id and colleague.team_id=manager.team_id and colleague.user_id=tenant_memberships.user_id
    where manager.tenant_id=tenant_memberships.tenant_id and manager.user_id=auth.uid() and manager.role='manager'
  )
);

drop policy if exists notes_customer_select on public.notes;
create policy notes_visibility_select on public.notes for select to authenticated using(
  tenant_id=public.current_tenant_id() and public.can_access_customer(customer_id)
  and (visibility<>'private' or created_by=auth.uid() or public.is_tenant_admin(tenant_id))
);
drop policy if exists notes_customer_update on public.notes;
create policy notes_owner_update on public.notes for update to authenticated
  using(tenant_id=public.current_tenant_id() and public.can_write_customer(customer_id) and (created_by=auth.uid() or public.is_tenant_admin(tenant_id)))
  with check(tenant_id=public.current_tenant_id() and public.can_write_customer(customer_id) and (created_by=auth.uid() or public.is_tenant_admin(tenant_id)));
drop policy if exists activities_scoped_select on public.activities;
create policy activities_callback_aware_select on public.activities for select to authenticated using(
  tenant_id=public.current_tenant_id() and (
    public.has_current_role(array['owner','admin','team_lead','backoffice','quality'])
    or (
      type='callback' and (
        (callback_scope='personal' and (assigned_user_id=auth.uid() or created_by=auth.uid()))
        or (callback_scope='global' and (list_id is null or public.can_work_customer_list(list_id)) and (assigned_team_id is null or exists(select 1 from public.team_members tm where tm.tenant_id=activities.tenant_id and tm.team_id=activities.assigned_team_id and tm.user_id=auth.uid())))
      )
    )
    or (type<>'callback' and (assigned_user_id=auth.uid() or created_by=auth.uid() or (customer_id is not null and public.can_access_customer(customer_id))))
  )
);
drop policy if exists activities_operator_update on public.activities;
create policy activities_callback_aware_update on public.activities for update to authenticated using(
  tenant_id=public.current_tenant_id() and (
    public.is_tenant_admin(tenant_id)
    or (type='callback' and (assigned_user_id=auth.uid() or claimed_by=auth.uid() or (list_id is not null and public.can_manage_customer_list(list_id))))
    or (type<>'callback' and (assigned_user_id=auth.uid() or created_by=auth.uid() or (customer_id is not null and public.can_write_customer(customer_id))))
  )
) with check(tenant_id=public.current_tenant_id());

create trigger customer_list_seller_assignments_tenant_immutable before update of tenant_id on public.customer_list_seller_assignments for each row execute function public.prevent_tenant_move();
create trigger list_dispositions_tenant_immutable before update of tenant_id on public.list_dispositions for each row execute function public.prevent_tenant_move();
create trigger customer_list_contact_candidates_tenant_immutable before update of tenant_id on public.customer_list_contact_candidates for each row execute function public.prevent_tenant_move();
create trigger dialer_sessions_tenant_immutable before update of tenant_id on public.dialer_sessions for each row execute function public.prevent_tenant_move();
create trigger note_revisions_tenant_immutable before update of tenant_id on public.note_revisions for each row execute function public.prevent_tenant_move();
create trigger sales_orders_tenant_immutable before update of tenant_id on public.sales_orders for each row execute function public.prevent_tenant_move();
create trigger sales_order_items_tenant_immutable before update of tenant_id on public.sales_order_items for each row execute function public.prevent_tenant_move();

revoke all on function public.seed_list_dispositions(uuid,uuid) from public,anon,authenticated;
grant execute on function public.can_manage_customer_list(uuid) to authenticated;
grant execute on function public.can_work_customer_list(uuid) to authenticated;
grant execute on function public.create_managed_customer_list(text,text,text,uuid,text,integer,time,time,integer,integer,integer,text,boolean,boolean,text) to authenticated;
grant execute on function public.update_customer_list_configuration(uuid,text,text,text,text,integer,time,time,integer,integer,integer,text,boolean,boolean,boolean,text,text,integer[],uuid,boolean,timestamptz,timestamptz) to authenticated;
grant execute on function public.set_customer_list_sellers(uuid,uuid[]) to authenticated;
grant execute on function public.add_customers_to_list(uuid,uuid[]) to authenticated;
grant execute on function public.materialize_segment_to_customer_list(uuid,uuid) to authenticated;
grant execute on function public.start_dialer_session(uuid) to authenticated;
grant execute on function public.claim_next_list_member(uuid,uuid) to authenticated;
grant execute on function public.release_list_member_claim(uuid,text) to authenticated;
grant execute on function public.queue_list_outbound_call(uuid,uuid,uuid,text,text,text,text,text) to authenticated;
grant execute on function public.claim_customer_callback(uuid) to authenticated;
grant execute on function public.snooze_customer_callback(uuid,timestamptz) to authenticated;
grant execute on function public.complete_customer_callback(uuid,text) to authenticated;
grant execute on function public.reassign_customer_callback(uuid,uuid) to authenticated;
grant execute on function public.queue_callback_outbound_call(uuid,uuid,text,text,text,text,text) to authenticated;
grant execute on function public.complete_manual_call_work(uuid,text,text,text,timestamptz) to authenticated;
grant execute on function public.complete_dialer_work(uuid,text,text,text,timestamptz,boolean,uuid,numeric,numeric,text) to authenticated;
grant execute on function public.schedule_customer_callback(uuid,uuid,text,timestamptz,text,text) to authenticated;
grant execute on function public.create_or_match_manual_prospect(text,text,public.customer_type) to authenticated;
revoke all on function public.refresh_due_dynamic_customer_lists(integer) from public,anon,authenticated;
grant execute on function public.refresh_due_dynamic_customer_lists(integer) to service_role;

-- Supabase Realtime is optional in local PostgreSQL; when present, publish the canonical work tables once.
do $$
declare v_table text;
begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime') then
    foreach v_table in array array['calls','activities','customer_lists','customer_list_members','dialer_sessions','sales_orders'] loop
      if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename=v_table) then
        execute format('alter publication supabase_realtime add table public.%I',v_table);
      end if;
    end loop;
  end if;
end $$;

commit;
