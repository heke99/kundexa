begin;

-- Complete the hierarchy platform -> tenant -> team -> seller without creating
-- a parallel CRM. Tenant customer_lists/customer_list_members stay the operational
-- dialer objects; platform lists only represent the central supply and allocation trail.

alter table public.teams
  add column if not exists code text,
  add column if not exists status text not null default 'active',
  add column if not exists invite_sellers_enabled boolean not null default true,
  add column if not exists max_members integer,
  add column if not exists default_dialing_mode text not null default 'manual',
  add column if not exists archived_at timestamptz;

alter table public.teams drop constraint if exists teams_status_check;
alter table public.teams add constraint teams_status_check check(status in ('active','paused','archived'));
alter table public.teams drop constraint if exists teams_default_dialing_mode_check;
alter table public.teams add constraint teams_default_dialing_mode_check check(default_dialing_mode in ('manual','automatic'));
alter table public.teams drop constraint if exists teams_max_members_check;
alter table public.teams add constraint teams_max_members_check check(max_members is null or max_members between 1 and 10000);
create unique index if not exists teams_tenant_code_unique_idx on public.teams(tenant_id,lower(code)) where code is not null;

alter table public.team_members
  add column if not exists is_primary boolean not null default false,
  add column if not exists assignment_paused boolean not null default false,
  add column if not exists daily_lead_limit integer,
  add column if not exists joined_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();
alter table public.team_members drop constraint if exists team_members_daily_lead_limit_check;
alter table public.team_members add constraint team_members_daily_lead_limit_check check(daily_lead_limit is null or daily_lead_limit between 1 and 10000);
create unique index if not exists team_members_one_primary_idx on public.team_members(tenant_id,user_id) where is_primary;

alter table public.customer_list_members
  add column if not exists last_claimed_by uuid references auth.users(id) on delete set null,
  add column if not exists last_claimed_at timestamptz;
create index if not exists customer_list_members_daily_claim_idx
  on public.customer_list_members(tenant_id,last_claimed_by,last_claimed_at) where last_claimed_by is not null;

create or replace function public.track_customer_list_member_claim()
returns trigger
language plpgsql
set search_path=public
as $$
begin
  if new.claimed_by is not null and (old.claimed_by is distinct from new.claimed_by or old.claim_expires_at is distinct from new.claim_expires_at) then
    new.last_claimed_by:=new.claimed_by;
    new.last_claimed_at:=now();
  end if;
  return new;
end $$;
create trigger customer_list_members_track_claim
  before update of claimed_by,claim_expires_at on public.customer_list_members
  for each row execute function public.track_customer_list_member_claim();

-- Team membership pause and team-wide daily lead limit are enforced by the
-- canonical dialer permission check, not only by the user interface.
create or replace function public.can_work_customer_list(p_list_id uuid)
returns boolean
language sql
stable
security definer
set search_path=public
as $$
  select exists(
    select 1
    from public.customer_lists l
    where l.id=p_list_id
      and l.tenant_id=public.current_tenant_id()
      and l.status='active'
      and (l.starts_at is null or l.starts_at<=now())
      and (l.ends_at is null or l.ends_at>now())
      and (
        l.team_id is null
        or exists(select 1 from public.teams t where t.tenant_id=l.tenant_id and t.id=l.team_id and t.status='active')
      )
      and (
        public.can_manage_customer_list(l.id)
        or exists(
          select 1
          from public.customer_list_seller_assignments a
          where a.tenant_id=l.tenant_id and a.list_id=l.id and a.user_id=auth.uid()
            and a.status='active'
            and (a.starts_at is null or a.starts_at<=now())
            and (a.ends_at is null or a.ends_at>now())
            and (
              l.team_id is null
              or exists(
                select 1
                from public.team_members tm
                where tm.tenant_id=l.tenant_id and tm.team_id=l.team_id and tm.user_id=auth.uid()
                  and not tm.assignment_paused
                  and (
                    tm.daily_lead_limit is null
                    or (
                      select count(*)
                      from public.customer_list_members claimed
                      join public.customer_lists claimed_list
                        on claimed_list.tenant_id=claimed.tenant_id and claimed_list.id=claimed.list_id
                      where claimed.tenant_id=l.tenant_id
                        and claimed_list.team_id=l.team_id
                        and claimed.last_claimed_by=auth.uid()
                        and (claimed.last_claimed_at at time zone l.timezone)::date=(now() at time zone l.timezone)::date
                    ) < tm.daily_lead_limit
                  )
              )
            )
        )
      )
  )
$$;

alter table public.tenant_memberships
  add column if not exists primary_team_id uuid,
  add column if not exists deactivated_at timestamptz,
  add column if not exists deactivated_by uuid references auth.users(id) on delete set null;
do $$
begin
  if not exists(select 1 from pg_constraint where conname='tenant_memberships_primary_team_fk') then
    alter table public.tenant_memberships add constraint tenant_memberships_primary_team_fk
      foreign key(tenant_id,primary_team_id) references public.teams(tenant_id,id) on delete set null;
  end if;
end $$;

create table if not exists public.tenant_invitations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  email citext not null,
  role public.membership_role not null,
  status text not null default 'pending' check(status in ('pending','accepted','expired','revoked','failed')),
  invited_user_id uuid references auth.users(id) on delete set null,
  invited_by uuid references auth.users(id) on delete set null,
  team_ids uuid[] not null default '{}',
  message text,
  expires_at timestamptz not null default now()+interval '7 days',
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(tenant_id,id)
);
create unique index if not exists tenant_invitations_one_pending_idx
  on public.tenant_invitations(tenant_id,lower(email::text)) where status='pending';
create index if not exists tenant_invitations_tenant_status_idx on public.tenant_invitations(tenant_id,status,created_at desc);

create table if not exists public.platform_lists (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  source_provider text not null default 'file',
  source_website text,
  source_file_name text,
  source_file_sha256 text,
  status text not null default 'active' check(status in ('draft','active','paused','archived')),
  exclusivity_mode text not null default 'exclusive' check(exclusivity_mode in ('exclusive','shared','time_limited')),
  default_exclusive_days integer check(default_exclusive_days is null or default_exclusive_days between 1 and 3650),
  mapping_snapshot jsonb not null default '{}'::jsonb,
  import_report jsonb not null default '{}'::jsonb,
  total_entries integer not null default 0,
  available_entries integer not null default 0,
  allocated_entries integer not null default 0,
  consumed_entries integer not null default 0,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists platform_lists_file_hash_idx on public.platform_lists(source_file_sha256) where source_file_sha256 is not null and status<>'archived';

create table if not exists public.platform_list_entries (
  id uuid primary key default gen_random_uuid(),
  platform_list_id uuid not null references public.platform_lists(id) on delete cascade,
  source_key text,
  organization_number text,
  display_name text not null,
  company_name text,
  contact_name text,
  contact_role text,
  phone_e164 text,
  alternate_phone_e164 text,
  contact_phone_e164 text,
  email citext,
  contact_email citext,
  website text,
  address_line1 text,
  postal_code text,
  city text,
  municipality text,
  county text,
  country_code text not null default 'SE',
  industry text,
  sni_code text,
  revenue numeric,
  employee_count integer,
  source_external_id text,
  state text not null default 'available' check(state in ('available','allocated','blocked','invalid','archived')),
  data_hash text not null,
  raw_data jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(platform_list_id,id),
  unique(platform_list_id,data_hash)
);
create unique index if not exists platform_list_entries_source_key_idx on public.platform_list_entries(platform_list_id,source_key) where source_key is not null;
create index if not exists platform_list_entries_available_idx on public.platform_list_entries(platform_list_id,state,city,municipality,industry);
create index if not exists platform_list_entries_org_idx on public.platform_list_entries(organization_number) where organization_number is not null;
create index if not exists platform_list_entries_phone_idx on public.platform_list_entries(phone_e164) where phone_e164 is not null;

alter table public.customer_lists
  add column if not exists source_kind text not null default 'tenant',
  add column if not exists source_platform_list_id uuid,
  add column if not exists source_platform_allocation_id uuid,
  add column if not exists parent_list_id uuid,
  add column if not exists allocation_level text not null default 'tenant';
alter table public.customer_lists drop constraint if exists customer_lists_source_kind_check;
alter table public.customer_lists add constraint customer_lists_source_kind_check check(source_kind in ('tenant','platform','import','segment','campaign'));
alter table public.customer_lists drop constraint if exists customer_lists_allocation_level_check;
alter table public.customer_lists add constraint customer_lists_allocation_level_check check(allocation_level in ('tenant','team','seller'));
do $$
begin
  if not exists(select 1 from pg_constraint where conname='customer_lists_parent_tenant_fk') then
    alter table public.customer_lists add constraint customer_lists_parent_tenant_fk
      foreign key(tenant_id,parent_list_id) references public.customer_lists(tenant_id,id) on delete set null;
  end if;
  if not exists(select 1 from pg_constraint where conname='customer_lists_source_platform_list_fk') then
    alter table public.customer_lists add constraint customer_lists_source_platform_list_fk
      foreign key(source_platform_list_id) references public.platform_lists(id) on delete set null;
  end if;
end $$;

create table if not exists public.platform_list_allocations (
  id uuid primary key default gen_random_uuid(),
  platform_list_id uuid not null references public.platform_lists(id) on delete restrict,
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  target_list_id uuid,
  name text not null,
  status text not null default 'active' check(status in ('draft','active','completed','revoked')),
  allocation_method text not null default 'count' check(allocation_method in ('count','filter','manual')),
  exclusivity_mode text not null check(exclusivity_mode in ('exclusive','shared','time_limited')),
  requested_count integer not null check(requested_count between 1 and 1000000),
  allocated_count integer not null default 0,
  filters jsonb not null default '{}'::jsonb,
  starts_at timestamptz,
  ends_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  activated_at timestamptz,
  revoked_at timestamptz,
  revoke_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(tenant_id,id),
  foreign key(tenant_id,target_list_id) references public.customer_lists(tenant_id,id) on delete set null
);
create index if not exists platform_list_allocations_tenant_idx on public.platform_list_allocations(tenant_id,status,created_at desc);
create index if not exists platform_list_allocations_list_idx on public.platform_list_allocations(platform_list_id,status,created_at desc);

do $$
begin
  if not exists(select 1 from pg_constraint where conname='customer_lists_source_platform_allocation_fk') then
    alter table public.customer_lists add constraint customer_lists_source_platform_allocation_fk
      foreign key(source_platform_allocation_id) references public.platform_list_allocations(id) on delete set null;
  end if;
end $$;

create table if not exists public.platform_list_allocation_entries (
  allocation_id uuid not null references public.platform_list_allocations(id) on delete cascade,
  platform_entry_id uuid not null references public.platform_list_entries(id) on delete restrict,
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  customer_id uuid,
  list_member_id uuid,
  status text not null default 'active' check(status in ('active','revoked','converted')),
  allocated_at timestamptz not null default now(),
  revoked_at timestamptz,
  primary key(allocation_id,platform_entry_id),
  foreign key(tenant_id,customer_id) references public.customers(tenant_id,id) on delete set null,
  foreign key(tenant_id,list_member_id) references public.customer_list_members(tenant_id,id) on delete set null
);
create index if not exists platform_allocation_entries_entry_idx on public.platform_list_allocation_entries(platform_entry_id,status);
create index if not exists platform_allocation_entries_tenant_idx on public.platform_list_allocation_entries(tenant_id,status);

create or replace function public.current_tenant_id()
returns uuid
language sql
stable
security definer
set search_path=public
as $$
  select p.active_tenant_id
  from public.profiles p
  join public.tenant_memberships m on m.tenant_id=p.active_tenant_id and m.user_id=p.id and m.status='active'
  join public.tenants t on t.id=p.active_tenant_id and t.status in ('trial','active')
  where p.id=auth.uid()
$$;

create or replace function public.can_manage_team(p_team_id uuid)
returns boolean
language sql
stable
security definer
set search_path=public
as $$
  select exists(
    select 1 from public.teams t
    where t.id=p_team_id and t.tenant_id=public.current_tenant_id()
      and (
        public.is_tenant_admin(t.tenant_id)
        or exists(
          select 1 from public.team_members tm
          where tm.tenant_id=t.tenant_id and tm.team_id=t.id and tm.user_id=auth.uid() and tm.role='manager'
        )
      )
  )
$$;

create or replace function public.create_managed_team(
  p_name text,
  p_description text default null,
  p_department text default null,
  p_office text default null,
  p_code text default null,
  p_invite_sellers_enabled boolean default true,
  p_max_members integer default null,
  p_default_dialing_mode text default 'manual'
)
returns uuid
language plpgsql
security definer
set search_path=public
as $$
declare
  v_tenant uuid:=public.current_tenant_id();
  v_user uuid:=auth.uid();
  v_team uuid;
  v_allow_team_lead boolean;
begin
  if v_tenant is null or v_user is null then raise exception 'authentication_required'; end if;
  if nullif(trim(coalesce(p_name,'')),'') is null then raise exception 'team_name_required'; end if;
  select coalesce((settings->>'team_leads_can_create_teams')::boolean,true)
    into v_allow_team_lead from public.tenant_settings where tenant_id=v_tenant;
  if not public.is_tenant_admin(v_tenant)
     and not (public.current_membership_role()='team_lead' and coalesce(v_allow_team_lead,true)) then
    raise exception 'team_create_permission_required';
  end if;
  insert into public.teams(tenant_id,name,description,department,office,code,invite_sellers_enabled,max_members,default_dialing_mode)
  values(v_tenant,trim(p_name),nullif(trim(coalesce(p_description,'')),''),nullif(trim(coalesce(p_department,'')),''),
    nullif(trim(coalesce(p_office,'')),''),nullif(lower(trim(coalesce(p_code,''))),''),p_invite_sellers_enabled,p_max_members,p_default_dialing_mode)
  returning id into v_team;
  insert into public.team_members(tenant_id,team_id,user_id,role,is_primary)
  values(v_tenant,v_team,v_user,'manager',false)
  on conflict(team_id,user_id) do update set role='manager',updated_at=now();
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
  values(v_tenant,v_user,'team.created','team',v_team::text,jsonb_build_object('name',trim(p_name),'created_by_team_lead',not public.is_tenant_admin(v_tenant)));
  return v_team;
end $$;

create or replace function public.update_managed_team(
  p_team_id uuid,
  p_name text,
  p_description text default null,
  p_department text default null,
  p_office text default null,
  p_code text default null,
  p_status text default 'active',
  p_invite_sellers_enabled boolean default true,
  p_max_members integer default null,
  p_default_dialing_mode text default 'manual'
)
returns void
language plpgsql
security definer
set search_path=public
as $$
declare
  v_tenant uuid:=public.current_tenant_id();
  v_actor uuid:=auth.uid();
  v_before public.teams%rowtype;
begin
  if not public.can_manage_team(p_team_id) then raise exception 'team_manage_permission_required'; end if;
  if nullif(trim(coalesce(p_name,'')),'') is null then raise exception 'team_name_required'; end if;
  if p_status not in ('active','paused','archived') then raise exception 'invalid_team_status'; end if;
  if p_default_dialing_mode not in ('manual','automatic') then raise exception 'invalid_default_dialing_mode'; end if;
  if p_max_members is not null and (p_max_members<1 or p_max_members>10000) then raise exception 'invalid_team_member_limit'; end if;
  select * into v_before from public.teams where tenant_id=v_tenant and id=p_team_id for update;
  if not found then raise exception 'team_not_found'; end if;
  if v_before.is_default and p_status='archived' then raise exception 'default_team_cannot_be_archived'; end if;
  update public.teams set
    name=trim(p_name),
    description=nullif(trim(coalesce(p_description,'')),''),
    department=nullif(trim(coalesce(p_department,'')),''),
    office=nullif(trim(coalesce(p_office,'')),''),
    code=nullif(lower(trim(coalesce(p_code,''))),''),
    status=p_status,
    invite_sellers_enabled=p_invite_sellers_enabled,
    max_members=p_max_members,
    default_dialing_mode=p_default_dialing_mode,
    archived_at=case when p_status='archived' then coalesce(archived_at,now()) else null end,
    updated_at=now()
  where tenant_id=v_tenant and id=p_team_id;
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,before_data,after_data)
  values(v_tenant,v_actor,'team.updated','team',p_team_id::text,
    jsonb_build_object('name',v_before.name,'status',v_before.status,'invite_sellers_enabled',v_before.invite_sellers_enabled,'max_members',v_before.max_members),
    jsonb_build_object('name',trim(p_name),'status',p_status,'invite_sellers_enabled',p_invite_sellers_enabled,'max_members',p_max_members));
end $$;

create or replace function public.set_managed_team_member(
  p_team_id uuid,
  p_user_id uuid,
  p_team_role text default 'member',
  p_is_primary boolean default false,
  p_daily_lead_limit integer default null,
  p_assignment_paused boolean default false
)
returns void
language plpgsql
security definer
set search_path=public
as $$
declare
  v_tenant uuid:=public.current_tenant_id();
  v_actor uuid:=auth.uid();
  v_member_role public.membership_role;
  v_max integer;
  v_count integer;
begin
  if not public.can_manage_team(p_team_id) then raise exception 'team_manage_permission_required'; end if;
  if p_team_role not in ('manager','member') then raise exception 'invalid_team_role'; end if;
  select role into v_member_role from public.tenant_memberships
    where tenant_id=v_tenant and user_id=p_user_id and status in ('invited','active');
  if not found then raise exception 'tenant_member_not_found'; end if;
  if not public.is_tenant_admin(v_tenant) then
    if v_member_role<>'sales' or p_team_role<>'member' then raise exception 'team_lead_can_only_manage_sellers'; end if;
  elsif p_team_role='manager' and v_member_role not in ('owner','admin','team_lead') then
    raise exception 'manager_membership_role_required';
  end if;
  select max_members into v_max from public.teams where tenant_id=v_tenant and id=p_team_id for update;
  if v_max is not null and not exists(select 1 from public.team_members where team_id=p_team_id and user_id=p_user_id) then
    select count(*) into v_count from public.team_members where team_id=p_team_id;
    if v_count>=v_max then raise exception 'team_member_limit_reached'; end if;
  end if;
  if p_is_primary then
    update public.team_members set is_primary=false,updated_at=now() where tenant_id=v_tenant and user_id=p_user_id and team_id<>p_team_id;
    update public.tenant_memberships set primary_team_id=p_team_id,updated_at=now() where tenant_id=v_tenant and user_id=p_user_id;
  end if;
  insert into public.team_members(tenant_id,team_id,user_id,role,is_primary,daily_lead_limit,assignment_paused,joined_at,updated_at)
  values(v_tenant,p_team_id,p_user_id,p_team_role,p_is_primary,p_daily_lead_limit,p_assignment_paused,now(),now())
  on conflict(team_id,user_id) do update set
    role=excluded.role,is_primary=excluded.is_primary,daily_lead_limit=excluded.daily_lead_limit,
    assignment_paused=excluded.assignment_paused,updated_at=now();
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
  values(v_tenant,v_actor,'team.member_set','team_member',p_team_id::text||':'||p_user_id::text,
    jsonb_build_object('team_id',p_team_id,'user_id',p_user_id,'team_role',p_team_role,'primary',p_is_primary,'assignment_paused',p_assignment_paused));
end $$;

create or replace function public.remove_managed_team_member(p_team_id uuid,p_user_id uuid)
returns void
language plpgsql
security definer
set search_path=public
as $$
declare v_tenant uuid:=public.current_tenant_id(); v_actor uuid:=auth.uid();
begin
  if not public.can_manage_team(p_team_id) then raise exception 'team_manage_permission_required'; end if;
  if not public.is_tenant_admin(v_tenant) and p_user_id=auth.uid() then raise exception 'team_manager_cannot_remove_self'; end if;
  delete from public.team_members where tenant_id=v_tenant and team_id=p_team_id and user_id=p_user_id;
  if not found then raise exception 'team_member_not_found'; end if;
  update public.tenant_memberships set primary_team_id=null,updated_at=now()
    where tenant_id=v_tenant and user_id=p_user_id and primary_team_id=p_team_id;
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,before_data)
  values(v_tenant,v_actor,'team.member_removed','team_member',p_team_id::text||':'||p_user_id::text,
    jsonb_build_object('team_id',p_team_id,'user_id',p_user_id));
end $$;

create or replace function public.register_tenant_invitation(
  p_tenant_id uuid,
  p_invited_user_id uuid,
  p_email text,
  p_role public.membership_role,
  p_team_ids uuid[] default '{}',
  p_message text default null,
  p_expires_at timestamptz default now()+interval '7 days'
)
returns uuid
language plpgsql
security definer
set search_path=public
as $$
declare
  v_actor uuid:=auth.uid();
  v_invitation uuid;
  v_team uuid;
  v_is_platform boolean;
begin
  if v_actor is null then raise exception 'authentication_required'; end if;
  v_is_platform:=public.is_platform_role(array['platform_owner'::public.platform_role,'platform_admin'::public.platform_role]);
  if not v_is_platform and p_tenant_id<>public.current_tenant_id() then raise exception 'tenant_mismatch'; end if;
  if not v_is_platform and not public.is_tenant_admin(p_tenant_id) then
    if public.current_membership_role()<>'team_lead' or p_role<>'sales' then raise exception 'invitation_permission_required'; end if;
    if coalesce(array_length(p_team_ids,1),0)=0 then raise exception 'team_required_for_team_lead_invitation'; end if;
    if exists(select 1 from unnest(p_team_ids) as requested(team_id) where not public.can_manage_team(requested.team_id)) then raise exception 'team_manage_permission_required'; end if;
    if exists(select 1 from public.teams t where t.id=any(p_team_ids) and not t.invite_sellers_enabled) then raise exception 'team_seller_invitations_disabled'; end if;
  end if;
  if p_role='owner' and not v_is_platform and public.current_membership_role()<>'owner' then raise exception 'owner_invitation_requires_owner'; end if;
  if exists(
    select 1
    from unnest(coalesce(p_team_ids,'{}'::uuid[])) as requested(team_id)
    where not exists(
      select 1 from public.teams t
      where t.id=requested.team_id and t.tenant_id=p_tenant_id and t.status<>'archived'
    )
  ) then
    raise exception 'invitation_team_not_found';
  end if;
  update public.tenant_invitations set status='revoked',revoked_at=now(),updated_at=now()
    where tenant_id=p_tenant_id and lower(email::text)=lower(trim(p_email)) and status='pending';
  insert into public.tenant_invitations(tenant_id,email,role,invited_user_id,invited_by,team_ids,message,expires_at)
  values(p_tenant_id,lower(trim(p_email)),p_role,p_invited_user_id,v_actor,coalesce(p_team_ids,'{}'::uuid[]),nullif(trim(coalesce(p_message,'')),''),p_expires_at)
  returning id into v_invitation;
  insert into public.tenant_memberships(tenant_id,user_id,role,status,invited_by,invited_at)
  values(p_tenant_id,p_invited_user_id,p_role,'invited',v_actor,now())
  on conflict(tenant_id,user_id) do update set
    role=excluded.role,status=case when public.tenant_memberships.status='active' then 'active'::public.membership_status else 'invited'::public.membership_status end,
    invited_by=v_actor,invited_at=now(),updated_at=now();
  foreach v_team in array coalesce(p_team_ids,'{}'::uuid[]) loop
    insert into public.team_members(tenant_id,team_id,user_id,role,is_primary)
    values(p_tenant_id,v_team,p_invited_user_id,case when p_role in ('owner','admin','team_lead') then 'manager' else 'member' end,false)
    on conflict(team_id,user_id) do update set role=excluded.role,updated_at=now();
  end loop;
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
  values(p_tenant_id,v_actor,'tenant.invitation_created','tenant_invitation',v_invitation::text,
    jsonb_build_object('email',lower(trim(p_email)),'role',p_role,'team_ids',coalesce(p_team_ids,'{}'::uuid[])));
  return v_invitation;
end $$;

create or replace function public.update_tenant_member(
  p_user_id uuid,
  p_role public.membership_role,
  p_status public.membership_status,
  p_reassign_user_id uuid default null
)
returns void
language plpgsql
security definer
set search_path=public
as $$
declare
  v_tenant uuid:=public.current_tenant_id();
  v_actor uuid:=auth.uid();
  v_actor_role public.membership_role:=public.current_membership_role();
  v_before public.tenant_memberships%rowtype;
  v_owner_count integer;
begin
  if v_tenant is null or v_actor is null or v_actor_role not in ('owner','admin') then raise exception 'tenant_admin_required'; end if;
  select * into v_before from public.tenant_memberships
    where tenant_id=v_tenant and user_id=p_user_id for update;
  if not found then raise exception 'tenant_member_not_found'; end if;
  if p_status not in ('invited','active','suspended','removed') then raise exception 'invalid_membership_status'; end if;
  if p_status='invited' and v_before.status<>'invited' then raise exception 'active_member_cannot_return_to_invited'; end if;
  if v_before.status='invited' and p_status not in ('invited','removed') then raise exception 'invitation_must_be_accepted_by_user'; end if;
  if v_actor=p_user_id and (p_role is distinct from v_before.role or p_status<>'active') then
    raise exception 'cannot_change_own_role_or_status';
  end if;
  if v_actor_role='admin' and (v_before.role in ('owner','admin') or p_role in ('owner','admin')) then
    raise exception 'owner_required_for_privileged_role';
  end if;
  if v_before.role='owner' and (p_role<>'owner' or p_status<>'active') then
    select count(*) into v_owner_count from public.tenant_memberships
      where tenant_id=v_tenant and role='owner' and status='active';
    if v_owner_count<=1 then raise exception 'tenant_requires_active_owner'; end if;
  end if;
  if p_reassign_user_id=p_user_id then raise exception 'invalid_reassignment_target'; end if;
  if p_reassign_user_id is not null and not exists(
    select 1 from public.tenant_memberships
    where tenant_id=v_tenant and user_id=p_reassign_user_id and status='active'
  ) then raise exception 'active_reassignment_target_required'; end if;

  if p_status='removed' then
    update public.tenant_invitations set status='revoked',revoked_at=now(),updated_at=now()
      where tenant_id=v_tenant and invited_user_id=p_user_id and status='pending';
  end if;

  if p_status in ('suspended','removed') then
    update public.customer_list_seller_assignments
      set status=case when p_status='removed' then 'ended' else 'paused' end,updated_at=now()
      where tenant_id=v_tenant and user_id=p_user_id and status='active';
    update public.customer_list_members
      set assigned_user_id=p_reassign_user_id,updated_at=now()
      where tenant_id=v_tenant and assigned_user_id=p_user_id and state not in ('completed','blocked');
    update public.customer_list_members
      set claimed_by=null,claim_expires_at=null,state=case when state='claimed' then 'pending' else state end,updated_at=now()
      where tenant_id=v_tenant and claimed_by=p_user_id and state in ('pending','claimed','retry','callback','skipped');
    update public.customers set assigned_user_id=p_reassign_user_id,updated_at=now()
      where tenant_id=v_tenant and assigned_user_id=p_user_id;
    update public.activities set assigned_user_id=p_reassign_user_id,updated_at=now()
      where tenant_id=v_tenant and assigned_user_id=p_user_id and status in ('open','in_progress');
    update public.deals set owner_user_id=p_reassign_user_id,updated_at=now()
      where tenant_id=v_tenant and owner_user_id=p_user_id and status='open';
    if p_status='removed' then
      delete from public.team_members where tenant_id=v_tenant and user_id=p_user_id;
    else
      update public.team_members set assignment_paused=true,updated_at=now()
        where tenant_id=v_tenant and user_id=p_user_id;
    end if;
  end if;

  update public.tenant_memberships set
    role=p_role,
    status=p_status,
    deactivated_at=case when p_status in ('suspended','removed') then now() else null end,
    deactivated_by=case when p_status in ('suspended','removed') then v_actor else null end,
    joined_at=case when p_status='active' then coalesce(joined_at,now()) else joined_at end,
    updated_at=now()
  where tenant_id=v_tenant and user_id=p_user_id;
  if p_role not in ('owner','admin','team_lead') then
    update public.team_members set role='member',updated_at=now()
      where tenant_id=v_tenant and user_id=p_user_id and role='manager';
  end if;
  if p_status in ('suspended','removed') then
    update public.profiles p set active_tenant_id=(
      select m.tenant_id
      from public.tenant_memberships m
      join public.tenants t on t.id=m.tenant_id
      where m.user_id=p_user_id and m.status='active' and m.tenant_id<>v_tenant and t.status in ('trial','active')
      order by m.joined_at desc nulls last,m.created_at desc
      limit 1
    ),updated_at=now()
    where p.id=p_user_id and p.active_tenant_id=v_tenant;
  end if;
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,before_data,after_data)
  values(v_tenant,v_actor,'tenant.member_updated','tenant_membership',p_user_id::text,
    jsonb_build_object('role',v_before.role,'status',v_before.status),
    jsonb_build_object('role',p_role,'status',p_status,'reassigned_to',p_reassign_user_id));
end $$;

create or replace function public.activate_current_user_invitation()
returns uuid
language plpgsql
security definer
set search_path=public,auth
as $$
declare
  v_user uuid:=auth.uid();
  v_email text;
  v_inv public.tenant_invitations%rowtype;
  v_tenant uuid;
begin
  if v_user is null then return null; end if;
  select lower(email) into v_email from auth.users where id=v_user;
  select * into v_inv from public.tenant_invitations
    where status='pending' and expires_at>now()
      and (invited_user_id=v_user or lower(email::text)=v_email)
    order by created_at desc limit 1 for update;
  if found then
    v_tenant:=v_inv.tenant_id;
    update public.tenant_invitations set status='accepted',invited_user_id=v_user,accepted_at=now(),updated_at=now() where id=v_inv.id;
  else
    select tenant_id into v_tenant from public.tenant_memberships
      where user_id=v_user and status='invited' order by invited_at desc nulls last,created_at desc limit 1 for update;
    if v_tenant is null then return null; end if;
  end if;
  update public.tenant_memberships set status='active',joined_at=coalesce(joined_at,now()),updated_at=now()
    where tenant_id=v_tenant and user_id=v_user;
  update public.profiles set active_tenant_id=coalesce(active_tenant_id,v_tenant),updated_at=now() where id=v_user;
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
  values(v_tenant,v_user,'tenant.invitation_accepted','tenant_membership',v_user::text,jsonb_build_object('tenant_id',v_tenant));
  return v_tenant;
end $$;

create or replace function public.list_current_user_tenants()
returns table(tenant_id uuid,tenant_name text,tenant_legal_name text,tenant_timezone text,membership_role public.membership_role,is_active boolean)
language sql
stable
security definer
set search_path=public
as $$
  select t.id,t.name,t.legal_name,t.timezone,m.role,(p.active_tenant_id=t.id)
  from public.tenant_memberships m
  join public.tenants t on t.id=m.tenant_id
  join public.profiles p on p.id=m.user_id
  where m.user_id=auth.uid() and m.status='active' and t.status in ('trial','active')
  order by (p.active_tenant_id=t.id) desc,t.name
$$;

create or replace function public.switch_active_tenant(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path=public
as $$
declare v_user uuid:=auth.uid(); v_previous uuid;
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  if not exists(
    select 1
    from public.tenant_memberships m
    join public.tenants t on t.id=m.tenant_id
    where m.tenant_id=p_tenant_id and m.user_id=v_user and m.status='active' and t.status in ('trial','active')
  ) then
    raise exception 'active_tenant_membership_required';
  end if;
  select active_tenant_id into v_previous from public.profiles where id=v_user for update;
  if v_previous=p_tenant_id then return; end if;
  update public.profiles set active_tenant_id=p_tenant_id,updated_at=now() where id=v_user;
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,before_data,after_data)
  values(p_tenant_id,v_user,'tenant.switched','profile',v_user::text,jsonb_build_object('tenant_id',v_previous),jsonb_build_object('tenant_id',p_tenant_id));
end $$;

create or replace function public.validate_active_tenant()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
begin
  if new.active_tenant_id is not null and not exists(
    select 1
    from public.tenant_memberships m
    join public.tenants t on t.id=m.tenant_id
    where m.tenant_id=new.active_tenant_id and m.user_id=new.id and m.status='active' and t.status in ('trial','active')
  ) then
    raise exception 'active_tenant_membership_required';
  end if;
  return new;
end $$;

create or replace function public.create_platform_tenant(
  p_name text,
  p_legal_name text,
  p_organization_number text default null,
  p_country_code text default 'SE',
  p_timezone text default 'Europe/Stockholm',
  p_locale text default 'sv-SE'
)
returns uuid
language plpgsql
security definer
set search_path=public
as $$
declare v_actor uuid:=auth.uid(); v_tenant uuid; v_slug text; v_team uuid;
begin
  if not public.is_platform_role(array['platform_owner'::public.platform_role,'platform_admin'::public.platform_role]) then raise exception 'platform_admin_required'; end if;
  if nullif(trim(coalesce(p_name,'')),'') is null or nullif(trim(coalesce(p_legal_name,'')),'') is null then raise exception 'tenant_name_required'; end if;
  v_slug:=trim(both '-' from regexp_replace(lower(trim(p_name)),'[^a-z0-9]+','-','g'))||'-'||substr(replace(gen_random_uuid()::text,'-',''),1,6);
  insert into public.tenants(slug,name,legal_name,organization_number,country_code,timezone,locale,status)
  values(v_slug,trim(p_name),trim(p_legal_name),nullif(trim(coalesce(p_organization_number,'')),''),upper(p_country_code),p_timezone,p_locale,'trial')
  returning id into v_tenant;
  perform public.ensure_tenant_defaults(v_tenant);
  insert into public.teams(tenant_id,name,is_default,code)
  values(v_tenant,'Huvudteam',true,'main')
  on conflict(tenant_id,name) do update set is_default=true
  returning id into v_team;
  insert into public.platform_audit_logs(actor_user_id,action,entity_type,entity_id,tenant_id,reason,metadata)
  values(v_actor,'tenant.created_by_platform','tenant',v_tenant::text,v_tenant,'Skapad från plattformsadministrationen',jsonb_build_object('name',trim(p_name),'default_team_id',v_team));
  return v_tenant;
end $$;

create or replace function public.refresh_platform_list_counts(p_platform_list_id uuid)
returns void
language plpgsql
security definer
set search_path=public
as $$
begin
  update public.platform_lists l set
    total_entries=(select count(*) from public.platform_list_entries e where e.platform_list_id=l.id and e.state<>'archived'),
    available_entries=(select count(*) from public.platform_list_entries e where e.platform_list_id=l.id and e.state='available'),
    allocated_entries=(select count(distinct ae.platform_entry_id) from public.platform_list_allocation_entries ae join public.platform_list_allocations a on a.id=ae.allocation_id where a.platform_list_id=l.id and ae.status='active'),
    consumed_entries=(select count(distinct ae.platform_entry_id) from public.platform_list_allocation_entries ae join public.platform_list_allocations a on a.id=ae.allocation_id where a.platform_list_id=l.id and ae.status='converted'),
    updated_at=now()
  where l.id=p_platform_list_id;
end $$;

create or replace function public.allocate_platform_list_to_tenant(
  p_platform_list_id uuid,
  p_tenant_id uuid,
  p_name text,
  p_requested_count integer,
  p_filters jsonb default '{}'::jsonb,
  p_exclusivity_mode text default null,
  p_starts_at timestamptz default null,
  p_ends_at timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path=public
as $$
declare
  v_actor uuid:=auth.uid();
  v_list public.platform_lists%rowtype;
  v_allocation uuid;
  v_target_list uuid;
  v_entry public.platform_list_entries%rowtype;
  v_customer uuid;
  v_member uuid;
  v_count integer:=0;
  v_mode text;
  v_starts_at timestamptz;
  v_ends_at timestamptz;
begin
  if not public.is_platform_role(array['platform_owner'::public.platform_role,'platform_admin'::public.platform_role]) then raise exception 'platform_admin_required'; end if;
  if nullif(trim(coalesce(p_name,'')),'') is null then raise exception 'allocation_name_required'; end if;
  if p_requested_count<1 or p_requested_count>1000000 then raise exception 'invalid_allocation_count'; end if;
  if p_ends_at is not null and p_starts_at is not null and p_ends_at<=p_starts_at then raise exception 'allocation_end_must_follow_start'; end if;
  select * into v_list from public.platform_lists where id=p_platform_list_id for update;
  if not found or v_list.status<>'active' then raise exception 'active_platform_list_required'; end if;
  if not exists(select 1 from public.tenants where id=p_tenant_id and status in ('trial','active')) then raise exception 'active_tenant_required'; end if;
  v_mode:=coalesce(p_exclusivity_mode,v_list.exclusivity_mode);
  if v_mode not in ('exclusive','shared','time_limited') then raise exception 'invalid_exclusivity_mode'; end if;
  v_starts_at:=coalesce(p_starts_at,now());
  v_ends_at:=p_ends_at;
  if v_mode='time_limited' and v_ends_at is null then
    v_ends_at:=v_starts_at+make_interval(days=>coalesce(v_list.default_exclusive_days,30));
  end if;
  if v_ends_at is not null and v_ends_at<=v_starts_at then raise exception 'allocation_end_must_follow_start'; end if;

  insert into public.customer_lists(
    tenant_id,name,description,list_type,status,dialing_mode,distribution_strategy,priority,timezone,
    source_kind,source_platform_list_id,allocation_level,starts_at,ends_at,owner_user_id
  )
  select p_tenant_id,trim(p_name),coalesce(v_list.description,'Tilldelad från Kundexas centrala listbank'),'import','draft','manual','shared_queue',100,t.timezone,
    'platform',v_list.id,'tenant',v_starts_at,v_ends_at,null
  from public.tenants t where t.id=p_tenant_id
  returning id into v_target_list;
  perform public.seed_list_dispositions(p_tenant_id,v_target_list);

  insert into public.platform_list_allocations(platform_list_id,tenant_id,target_list_id,name,status,allocation_method,exclusivity_mode,requested_count,filters,starts_at,ends_at,created_by,activated_at)
  values(v_list.id,p_tenant_id,v_target_list,trim(p_name),'active',case when coalesce(p_filters,'{}'::jsonb)='{}'::jsonb then 'count' else 'filter' end,v_mode,p_requested_count,coalesce(p_filters,'{}'::jsonb),v_starts_at,v_ends_at,v_actor,now())
  returning id into v_allocation;
  update public.customer_lists set source_platform_allocation_id=v_allocation where id=v_target_list;

  for v_entry in
    select e.* from public.platform_list_entries e
    where e.platform_list_id=v_list.id
      and e.state='available'
      and (nullif(coalesce(p_filters,'{}'::jsonb)->>'city','') is null or lower(e.city)=lower(coalesce(p_filters,'{}'::jsonb)->>'city'))
      and (nullif(coalesce(p_filters,'{}'::jsonb)->>'municipality','') is null or lower(e.municipality)=lower(coalesce(p_filters,'{}'::jsonb)->>'municipality'))
      and (nullif(coalesce(p_filters,'{}'::jsonb)->>'county','') is null or lower(e.county)=lower(coalesce(p_filters,'{}'::jsonb)->>'county'))
      and (nullif(coalesce(p_filters,'{}'::jsonb)->>'industry','') is null or lower(e.industry) like '%'||lower(coalesce(p_filters,'{}'::jsonb)->>'industry')||'%')
      and (nullif(coalesce(p_filters,'{}'::jsonb)->>'postal_prefix','') is null or e.postal_code like (coalesce(p_filters,'{}'::jsonb)->>'postal_prefix')||'%')
      and (nullif(coalesce(p_filters,'{}'::jsonb)->>'min_employees','') is null or coalesce(e.employee_count,0)>=(coalesce(p_filters,'{}'::jsonb)->>'min_employees')::integer)
      and (nullif(coalesce(p_filters,'{}'::jsonb)->>'max_employees','') is null or coalesce(e.employee_count,0)<=(coalesce(p_filters,'{}'::jsonb)->>'max_employees')::integer)
      and (
        v_mode='shared'
        or not exists(
          select 1 from public.platform_list_allocation_entries ae
          join public.platform_list_allocations a on a.id=ae.allocation_id
          where ae.platform_entry_id=e.id and ae.status='active' and a.status='active'
            and (a.ends_at is null or a.ends_at>now())
        )
      )
    order by e.created_at,e.id
    for update skip locked
    limit p_requested_count
  loop
    v_customer:=null;
    if v_entry.organization_number is not null then
      select id into v_customer from public.customers where tenant_id=p_tenant_id and organization_number=v_entry.organization_number and deleted_at is null order by created_at limit 1;
    end if;
    if v_customer is null and v_entry.phone_e164 is not null then
      select id into v_customer from public.customers where tenant_id=p_tenant_id and phone_e164=v_entry.phone_e164 and deleted_at is null order by created_at limit 1;
    end if;
    if v_customer is null and v_entry.email is not null then
      select id into v_customer from public.customers where tenant_id=p_tenant_id and email=v_entry.email and deleted_at is null order by created_at limit 1;
    end if;
    if v_customer is null then
      insert into public.customers(
        tenant_id,customer_type,lifecycle,display_name,company_name,organization_number,email,phone_e164,alternate_phone_e164,
        website,address_line1,postal_code,city,municipality,county,country_code,industry,sni_code,revenue,employee_count,
        source_name,source_external_id,source_retrieved_at,marketing_allowed,legal_basis,created_by
      ) values(
        p_tenant_id,'company','prospect',v_entry.display_name,coalesce(v_entry.company_name,v_entry.display_name),v_entry.organization_number,
        v_entry.email,v_entry.phone_e164,v_entry.alternate_phone_e164,v_entry.website,v_entry.address_line1,v_entry.postal_code,v_entry.city,
        v_entry.municipality,v_entry.county,v_entry.country_code,v_entry.industry,v_entry.sni_code,v_entry.revenue,v_entry.employee_count,
        coalesce(v_list.source_provider,'platform_list'),v_entry.source_external_id,now(),true,'legitimate_interest',v_actor
      ) returning id into v_customer;
    end if;
    if v_entry.contact_name is not null and not exists(
      select 1 from public.contact_people cp where cp.tenant_id=p_tenant_id and cp.customer_id=v_customer
        and lower(cp.full_name)=lower(v_entry.contact_name) and coalesce(cp.phone_e164,'')=coalesce(v_entry.contact_phone_e164,'')
    ) then
      insert into public.contact_people(tenant_id,customer_id,full_name,title,email,phone_e164,is_primary)
      values(p_tenant_id,v_customer,v_entry.contact_name,v_entry.contact_role,v_entry.contact_email,v_entry.contact_phone_e164,true);
    end if;
    insert into public.customer_list_members(tenant_id,list_id,customer_id,added_by,state,priority)
    values(p_tenant_id,v_target_list,v_customer,v_actor,'pending',100)
    on conflict(list_id,customer_id) do update set state=case when public.customer_list_members.state in ('completed','blocked') then public.customer_list_members.state else 'pending' end,updated_at=now()
    returning id into v_member;
    insert into public.platform_list_allocation_entries(allocation_id,platform_entry_id,tenant_id,customer_id,list_member_id)
    values(v_allocation,v_entry.id,p_tenant_id,v_customer,v_member);
    if v_mode<>'shared' then update public.platform_list_entries set state='allocated',updated_at=now() where id=v_entry.id; end if;
    v_count:=v_count+1;
  end loop;
  if v_count=0 then
    delete from public.platform_list_allocations where id=v_allocation;
    delete from public.customer_lists where id=v_target_list;
    raise exception 'no_platform_entries_available_for_allocation';
  end if;
  update public.platform_list_allocations set allocated_count=v_count,updated_at=now() where id=v_allocation;
  perform public.refresh_platform_list_counts(v_list.id);
  insert into public.platform_audit_logs(actor_user_id,action,entity_type,entity_id,tenant_id,reason,metadata)
  values(v_actor,'platform_list.allocated','platform_list_allocation',v_allocation::text,p_tenant_id,'Central lista tilldelad tenant',
    jsonb_build_object('platform_list_id',v_list.id,'target_list_id',v_target_list,'requested',p_requested_count,'allocated',v_count,'filters',p_filters,'exclusivity_mode',v_mode));
  return v_allocation;
end $$;

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
    select lm.id,lm.customer_id from public.customer_list_members lm
    where lm.tenant_id=v_tenant and lm.list_id=p_source_list_id
      and lm.state in ('pending','retry','skipped') and lm.claimed_by is null
    order by lm.priority desc,lm.created_at,lm.id
    for update skip locked limit p_count
  ), inserted as (
    insert into public.customer_list_members(
      tenant_id,list_id,customer_id,added_by,source_segment_id,assigned_user_id,state,priority,attempts,next_attempt_at,outcome,last_contacted_at
    )
    select v_tenant,v_child,lm.customer_id,v_actor,lm.source_segment_id,null,'pending',lm.priority,lm.attempts,lm.next_attempt_at,lm.outcome,lm.last_contacted_at
    from public.customer_list_members lm join selected s on s.id=lm.id
    on conflict(list_id,customer_id) do nothing
    returning customer_id
  )
  delete from public.customer_list_members lm using inserted i
    where lm.tenant_id=v_tenant and lm.list_id=p_source_list_id and lm.customer_id=i.customer_id;
  get diagnostics v_moved=row_count;
  if v_moved=0 then delete from public.customer_lists where id=v_child; raise exception 'no_open_list_members_available'; end if;
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
  values(v_tenant,v_actor,'customer_list.split_to_team','customer_list',v_child::text,
    jsonb_build_object('source_list_id',p_source_list_id,'team_id',p_team_id,'requested',p_count,'moved',v_moved));
  return v_child;
end $$;

create or replace function public.revoke_platform_list_allocation(p_allocation_id uuid,p_reason text)
returns integer
language plpgsql
security definer
set search_path=public
as $$
declare
  v_actor uuid:=auth.uid();
  v_allocation public.platform_list_allocations%rowtype;
  v_removed integer:=0;
begin
  if not public.is_platform_role(array['platform_owner'::public.platform_role,'platform_admin'::public.platform_role]) then raise exception 'platform_admin_required'; end if;
  if nullif(trim(coalesce(p_reason,'')),'') is null then raise exception 'reason_required'; end if;
  select * into v_allocation from public.platform_list_allocations where id=p_allocation_id for update;
  if not found then raise exception 'allocation_not_found'; end if;
  if v_allocation.status='revoked' then return 0; end if;
  update public.platform_list_allocation_entries ae set status='converted'
  where ae.allocation_id=v_allocation.id and ae.status='active' and exists(
    select 1 from public.customer_lists cl
    join public.customer_list_members lm on lm.tenant_id=cl.tenant_id and lm.list_id=cl.id and lm.customer_id=ae.customer_id
    where cl.tenant_id=ae.tenant_id and cl.source_platform_allocation_id=v_allocation.id
      and not (lm.state in ('pending','retry','skipped') and lm.claimed_by is null and lm.attempts=0 and lm.last_contacted_at is null)
  );
  delete from public.customer_list_members lm
  using public.platform_list_allocation_entries ae, public.customer_lists cl
  where ae.allocation_id=v_allocation.id and ae.status='active'
    and cl.tenant_id=ae.tenant_id and cl.source_platform_allocation_id=v_allocation.id
    and lm.tenant_id=cl.tenant_id and lm.list_id=cl.id and lm.customer_id=ae.customer_id
    and lm.state in ('pending','retry','skipped') and lm.claimed_by is null and lm.attempts=0 and lm.last_contacted_at is null;
  get diagnostics v_removed=row_count;
  update public.platform_list_allocation_entries set status='revoked',revoked_at=now() where allocation_id=v_allocation.id and status='active';
  update public.platform_list_allocations set status='revoked',revoked_at=now(),revoke_reason=trim(p_reason),updated_at=now() where id=v_allocation.id;
  update public.customer_lists set status='paused',updated_at=now() where tenant_id=v_allocation.tenant_id and source_platform_allocation_id=v_allocation.id and status in ('draft','active');
  update public.platform_list_entries e set state='available',updated_at=now()
    where e.platform_list_id=v_allocation.platform_list_id
      and not exists(
        select 1 from public.platform_list_allocation_entries ae
        left join public.platform_list_allocations a on a.id=ae.allocation_id
        where ae.platform_entry_id=e.id
          and (ae.status='converted' or (ae.status='active' and a.status='active'))
      ) and e.state='allocated';
  perform public.refresh_platform_list_counts(v_allocation.platform_list_id);
  insert into public.platform_audit_logs(actor_user_id,action,entity_type,entity_id,tenant_id,reason,metadata)
  values(v_actor,'platform_list.allocation_revoked','platform_list_allocation',v_allocation.id::text,v_allocation.tenant_id,trim(p_reason),jsonb_build_object('removed_unworked_members',v_removed));
  return v_removed;
end $$;

create or replace function public.validate_customer_list_platform_source()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
begin
  if new.source_platform_allocation_id is not null then
    if not exists(
      select 1 from public.platform_list_allocations a
      where a.id=new.source_platform_allocation_id and a.tenant_id=new.tenant_id
        and (new.source_platform_list_id is null or a.platform_list_id=new.source_platform_list_id)
    ) then raise exception 'customer_list_platform_allocation_tenant_mismatch'; end if;
  end if;
  if new.source_platform_list_id is not null and new.source_kind<>'platform' then
    raise exception 'platform_source_kind_required';
  end if;
  return new;
end $$;
create trigger customer_lists_validate_platform_source
  before insert or update of tenant_id,source_kind,source_platform_list_id,source_platform_allocation_id
  on public.customer_lists for each row execute function public.validate_customer_list_platform_source();

create or replace function public.release_expired_platform_allocations(p_limit integer default 100)
returns integer
language plpgsql
security definer
set search_path=public
as $$
declare v_allocation public.platform_list_allocations%rowtype; v_processed integer:=0;
begin
  for v_allocation in
    select * from public.platform_list_allocations
    where status='active' and exclusivity_mode='time_limited' and ends_at is not null and ends_at<=now()
    order by ends_at for update skip locked limit greatest(1,least(p_limit,1000))
  loop
    update public.platform_list_allocation_entries ae set status='converted'
    where ae.allocation_id=v_allocation.id and ae.status='active' and exists(
      select 1 from public.customer_lists cl
      join public.customer_list_members lm on lm.tenant_id=cl.tenant_id and lm.list_id=cl.id and lm.customer_id=ae.customer_id
      where cl.tenant_id=ae.tenant_id and cl.source_platform_allocation_id=v_allocation.id
        and not (lm.state in ('pending','retry','skipped') and lm.claimed_by is null and lm.attempts=0 and lm.last_contacted_at is null)
    );
    delete from public.customer_list_members lm
    using public.platform_list_allocation_entries ae, public.customer_lists cl
    where ae.allocation_id=v_allocation.id and ae.status='active'
      and cl.tenant_id=ae.tenant_id and cl.source_platform_allocation_id=v_allocation.id
      and lm.tenant_id=cl.tenant_id and lm.list_id=cl.id and lm.customer_id=ae.customer_id
      and lm.state in ('pending','retry','skipped') and lm.claimed_by is null and lm.attempts=0 and lm.last_contacted_at is null;
    update public.platform_list_allocation_entries set status='revoked',revoked_at=now()
      where allocation_id=v_allocation.id and status='active';
    update public.platform_list_allocations set status='completed',updated_at=now()
      where id=v_allocation.id;
    update public.customer_lists set status='paused',updated_at=now()
      where tenant_id=v_allocation.tenant_id and source_platform_allocation_id=v_allocation.id and status in ('draft','active');
    update public.platform_list_entries e set state='available',updated_at=now()
      where e.platform_list_id=v_allocation.platform_list_id and e.state='allocated'
        and not exists(
          select 1 from public.platform_list_allocation_entries ae
          left join public.platform_list_allocations a on a.id=ae.allocation_id
          where ae.platform_entry_id=e.id
            and (ae.status='converted' or (ae.status='active' and a.status='active'))
        );
    perform public.refresh_platform_list_counts(v_allocation.platform_list_id);
    v_processed:=v_processed+1;
  end loop;
  return v_processed;
end $$;

-- Tenant membership reads are scoped to self, tenant admins or a manager's own teams.
drop policy if exists membership_self_or_admin_select on public.tenant_memberships;
drop policy if exists memberships_team_manager_select on public.tenant_memberships;
create policy membership_scoped_select on public.tenant_memberships for select to authenticated using(
  user_id=auth.uid()
  or public.is_tenant_admin(tenant_id)
  or exists(
    select 1
    from public.team_members manager_membership
    join public.team_members target_membership
      on target_membership.tenant_id=manager_membership.tenant_id and target_membership.team_id=manager_membership.team_id
    where manager_membership.tenant_id=tenant_memberships.tenant_id
      and manager_membership.user_id=auth.uid() and manager_membership.role='manager'
      and target_membership.user_id=tenant_memberships.user_id
  )
);
drop policy if exists profiles_self_select on public.profiles;
drop policy if exists profiles_team_manager_select on public.profiles;
create policy profiles_scoped_select on public.profiles for select to authenticated using(
  id=auth.uid()
  or exists(
    select 1
    from public.tenant_memberships target_membership
    where target_membership.tenant_id=public.current_tenant_id()
      and target_membership.user_id=profiles.id
      and target_membership.status in ('invited','active')
      and (
        public.is_tenant_admin(target_membership.tenant_id)
        or exists(
          select 1
          from public.team_members manager_membership
          join public.team_members visible_membership
            on visible_membership.tenant_id=manager_membership.tenant_id and visible_membership.team_id=manager_membership.team_id
          where manager_membership.tenant_id=target_membership.tenant_id
            and manager_membership.user_id=auth.uid() and manager_membership.role='manager'
            and visible_membership.user_id=profiles.id
        )
      )
  )
);

-- Harden team and membership writes: all writes go through audited RPCs.
drop policy if exists membership_admin_all on public.tenant_memberships;
drop policy if exists teams_tenant_insert on public.teams;
drop policy if exists teams_tenant_update on public.teams;
drop policy if exists teams_tenant_delete on public.teams;
drop policy if exists teams_admin_write on public.teams;
drop policy if exists team_members_tenant_insert on public.team_members;
drop policy if exists team_members_tenant_update on public.team_members;
drop policy if exists team_members_tenant_delete on public.team_members;
drop policy if exists team_members_admin_write on public.team_members;

alter table public.tenant_invitations enable row level security;
alter table public.tenant_invitations force row level security;
alter table public.platform_lists enable row level security;
alter table public.platform_lists force row level security;
alter table public.platform_list_entries enable row level security;
alter table public.platform_list_entries force row level security;
alter table public.platform_list_allocations enable row level security;
alter table public.platform_list_allocations force row level security;
alter table public.platform_list_allocation_entries enable row level security;
alter table public.platform_list_allocation_entries force row level security;

create policy tenant_invitations_read on public.tenant_invitations for select to authenticated using(
  tenant_id=public.current_tenant_id() and (
    public.is_tenant_admin(tenant_id) or invited_user_id=auth.uid() or invited_by=auth.uid()
  )
);
create policy platform_lists_admin_read on public.platform_lists for select to authenticated using(
  public.is_platform_role(array['platform_owner'::public.platform_role,'platform_admin'::public.platform_role,'platform_auditor'::public.platform_role])
);
create policy platform_lists_admin_write on public.platform_lists for all to authenticated using(
  public.is_platform_role(array['platform_owner'::public.platform_role,'platform_admin'::public.platform_role])
) with check(public.is_platform_role(array['platform_owner'::public.platform_role,'platform_admin'::public.platform_role]));
create policy platform_list_entries_admin_read on public.platform_list_entries for select to authenticated using(
  public.is_platform_role(array['platform_owner'::public.platform_role,'platform_admin'::public.platform_role,'platform_auditor'::public.platform_role])
);
create policy platform_list_entries_admin_write on public.platform_list_entries for all to authenticated using(
  public.is_platform_role(array['platform_owner'::public.platform_role,'platform_admin'::public.platform_role])
) with check(public.is_platform_role(array['platform_owner'::public.platform_role,'platform_admin'::public.platform_role]));
create policy platform_allocations_scoped_read on public.platform_list_allocations for select to authenticated using(
  public.is_platform_role(array['platform_owner'::public.platform_role,'platform_admin'::public.platform_role,'platform_auditor'::public.platform_role])
  or (tenant_id=public.current_tenant_id() and public.is_tenant_admin(tenant_id))
);
create policy platform_allocation_entries_admin_read on public.platform_list_allocation_entries for select to authenticated using(
  public.is_platform_role(array['platform_owner'::public.platform_role,'platform_admin'::public.platform_role,'platform_auditor'::public.platform_role])
);

create trigger tenant_invitations_touch before update on public.tenant_invitations for each row execute function public.touch_updated_at();
create trigger platform_lists_touch before update on public.platform_lists for each row execute function public.touch_updated_at();
create trigger platform_list_entries_touch before update on public.platform_list_entries for each row execute function public.touch_updated_at();
create trigger platform_list_allocations_touch before update on public.platform_list_allocations for each row execute function public.touch_updated_at();
create trigger team_members_touch before update on public.team_members for each row execute function public.touch_updated_at();

revoke all on function public.can_manage_team(uuid) from public,anon;
revoke all on function public.create_managed_team(text,text,text,text,text,boolean,integer,text) from public,anon;
revoke all on function public.update_managed_team(uuid,text,text,text,text,text,text,boolean,integer,text) from public,anon;
revoke all on function public.set_managed_team_member(uuid,uuid,text,boolean,integer,boolean) from public,anon;
revoke all on function public.remove_managed_team_member(uuid,uuid) from public,anon;
revoke all on function public.register_tenant_invitation(uuid,uuid,text,public.membership_role,uuid[],text,timestamptz) from public,anon;
revoke all on function public.update_tenant_member(uuid,public.membership_role,public.membership_status,uuid) from public,anon;
revoke all on function public.activate_current_user_invitation() from public,anon;
revoke all on function public.list_current_user_tenants() from public,anon;
revoke all on function public.switch_active_tenant(uuid) from public,anon;
revoke all on function public.create_platform_tenant(text,text,text,text,text,text) from public,anon;
revoke all on function public.refresh_platform_list_counts(uuid) from public,anon,authenticated;
revoke all on function public.release_expired_platform_allocations(integer) from public,anon,authenticated;
revoke all on function public.allocate_platform_list_to_tenant(uuid,uuid,text,integer,jsonb,text,timestamptz,timestamptz) from public,anon;
revoke all on function public.split_customer_list_to_team(uuid,uuid,text,integer,text) from public,anon;
revoke all on function public.revoke_platform_list_allocation(uuid,text) from public,anon;

grant execute on function public.can_manage_team(uuid) to authenticated;
grant execute on function public.create_managed_team(text,text,text,text,text,boolean,integer,text) to authenticated;
grant execute on function public.update_managed_team(uuid,text,text,text,text,text,text,boolean,integer,text) to authenticated;
grant execute on function public.set_managed_team_member(uuid,uuid,text,boolean,integer,boolean) to authenticated;
grant execute on function public.remove_managed_team_member(uuid,uuid) to authenticated;
grant execute on function public.register_tenant_invitation(uuid,uuid,text,public.membership_role,uuid[],text,timestamptz) to authenticated;
grant execute on function public.update_tenant_member(uuid,public.membership_role,public.membership_status,uuid) to authenticated;
grant execute on function public.activate_current_user_invitation() to authenticated;
grant execute on function public.list_current_user_tenants() to authenticated;
grant execute on function public.switch_active_tenant(uuid) to authenticated;
grant execute on function public.create_platform_tenant(text,text,text,text,text,text) to authenticated;
grant execute on function public.allocate_platform_list_to_tenant(uuid,uuid,text,integer,jsonb,text,timestamptz,timestamptz) to authenticated;
grant execute on function public.split_customer_list_to_team(uuid,uuid,text,integer,text) to authenticated;
grant execute on function public.revoke_platform_list_allocation(uuid,text) to authenticated;
grant execute on function public.refresh_platform_list_counts(uuid) to service_role;
grant execute on function public.release_expired_platform_allocations(integer) to service_role;

commit;
