begin;

-- Forward-only cutover from the already shipped tenant-owned Rinkel model.
-- Provider credentials are environment-owned after this migration.

create table if not exists public.platform_integrations (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  provider_type text not null,
  name text not null,
  status text not null default 'not_configured' check (status in (
    'not_configured','testing','connected','degraded','authentication_failed',
    'plan_unsupported','unavailable','disabled','error'
  )),
  public_id uuid not null default gen_random_uuid() unique,
  webhook_status text not null default 'not_configured' check (webhook_status in (
    'not_configured','pending','active','degraded','disabled','error'
  )),
  webhook_secret_hash text,
  webhook_last_received_at timestamptz,
  last_connection_test_at timestamptz,
  last_verified_at timestamptz,
  last_successful_sync_at timestamptz,
  last_reconciled_at timestamptz,
  last_failed_sync_at timestamptz,
  last_error_code text,
  last_error_message text,
  capabilities jsonb not null default '{}'::jsonb,
  configuration jsonb not null default '{}'::jsonb,
  disabled_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists platform_integrations_one_active_rinkel_uidx
  on public.platform_integrations(provider)
  where provider='rinkel' and disabled_at is null and status<>'disabled';

insert into public.platform_integrations(provider,provider_type,name,status,configuration)
values('rinkel','telephony','Rinkel','not_configured','{"account_mode":"platform_managed","api_version":"v1"}')
on conflict do nothing;

create table if not exists public.platform_rinkel_users (
  id uuid primary key default gen_random_uuid(),
  platform_integration_id uuid not null references public.platform_integrations(id) on delete restrict,
  external_user_id text not null,
  external_device_id text,
  email citext,
  display_name text not null,
  active boolean not null default true,
  raw_provider_data jsonb not null default '{}'::jsonb,
  provider_created_at timestamptz,
  last_synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(platform_integration_id,external_user_id)
);

create table if not exists public.platform_rinkel_numbers (
  id uuid primary key default gen_random_uuid(),
  platform_integration_id uuid not null references public.platform_integrations(id) on delete restrict,
  external_number_id text not null,
  phone_number_e164 text not null check(phone_number_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  display_name text,
  country_code text,
  provider_status text not null default 'active',
  active boolean not null default true,
  recording_enabled boolean not null default false,
  raw_provider_data jsonb not null default '{}'::jsonb,
  last_synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(platform_integration_id,external_number_id),
  unique(phone_number_e164)
);

create table if not exists public.rinkel_user_allocations (
  id uuid primary key default gen_random_uuid(),
  rinkel_user_id uuid not null references public.platform_rinkel_users(id) on delete restrict,
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  status text not null default 'active' check(status in ('active','revoked','conflict')),
  valid_from timestamptz not null default now(),
  valid_to timestamptz,
  allocated_by uuid references auth.users(id) on delete set null,
  revoked_by uuid references auth.users(id) on delete set null,
  allocation_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check((status='active' and valid_to is null) or status<>'active')
);
create unique index if not exists rinkel_user_allocations_one_active_uidx
  on public.rinkel_user_allocations(rinkel_user_id) where status='active' and valid_to is null;

create table if not exists public.rinkel_number_allocations (
  id uuid primary key default gen_random_uuid(),
  rinkel_number_id uuid not null references public.platform_rinkel_numbers(id) on delete restrict,
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  status text not null default 'active' check(status in ('active','revoked','conflict')),
  valid_from timestamptz not null default now(),
  valid_to timestamptz,
  allocated_by uuid references auth.users(id) on delete set null,
  revoked_by uuid references auth.users(id) on delete set null,
  allocation_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check((status='active' and valid_to is null) or status<>'active')
);
create unique index if not exists rinkel_number_allocations_one_active_uidx
  on public.rinkel_number_allocations(rinkel_number_id) where status='active' and valid_to is null;

create table if not exists public.rinkel_number_grants (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  number_allocation_id uuid not null references public.rinkel_number_allocations(id) on delete cascade,
  team_id uuid,
  user_id uuid,
  access_level text not null default 'dial' check(access_level in ('dial','inbound','manage')),
  is_default boolean not null default false,
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key(tenant_id,team_id) references public.teams(tenant_id,id) on delete cascade,
  foreign key(tenant_id,user_id) references public.tenant_memberships(tenant_id,user_id) on delete cascade,
  unique(number_allocation_id,team_id,user_id,access_level)
);
create unique index if not exists rinkel_number_grants_user_default_uidx
  on public.rinkel_number_grants(tenant_id,user_id)
  where active and is_default and user_id is not null;

create table if not exists public.rinkel_user_mappings_v2 (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  kundexa_user_id uuid not null,
  rinkel_user_allocation_id uuid not null references public.rinkel_user_allocations(id) on delete restrict,
  default_number_allocation_id uuid not null references public.rinkel_number_allocations(id) on delete restrict,
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key(tenant_id,kundexa_user_id) references public.tenant_memberships(tenant_id,user_id) on delete cascade
);
create unique index if not exists rinkel_user_mappings_v2_user_uidx
  on public.rinkel_user_mappings_v2(tenant_id,kundexa_user_id) where active;
create unique index if not exists rinkel_user_mappings_v2_provider_uidx
  on public.rinkel_user_mappings_v2(rinkel_user_allocation_id) where active;

create table if not exists public.platform_rinkel_capabilities (
  platform_integration_id uuid primary key references public.platform_integrations(id) on delete cascade,
  api_access boolean not null default false,
  dial boolean not null default false,
  webhooks boolean not null default false,
  recordings boolean not null default false,
  transcription boolean not null default false,
  ai_insights boolean not null default false,
  detected_at timestamptz not null default now(),
  details jsonb not null default '{}'::jsonb
);

create table if not exists public.platform_rinkel_webhook_subscriptions (
  id uuid primary key default gen_random_uuid(),
  platform_integration_id uuid not null references public.platform_integrations(id) on delete cascade,
  event_type text not null check(event_type in ('incomingCall','outgoingCall','callStart','callEnd','callInsights')),
  target_url_hash text not null,
  status text not null default 'pending' check(status in ('pending','active','disabled','error','unsupported')),
  last_verified_at timestamptz,
  last_received_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(platform_integration_id,event_type)
);

create table if not exists public.platform_rinkel_conflicts (
  id uuid primary key default gen_random_uuid(),
  conflict_type text not null,
  provider_resource_type text not null,
  provider_resource_key text not null,
  claimed_tenant_ids uuid[] not null default '{}',
  event_id uuid,
  details jsonb not null default '{}'::jsonb,
  status text not null default 'open' check(status in ('open','resolved','ignored')),
  resolved_by uuid references auth.users(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists platform_rinkel_conflicts_open_resource_uidx
  on public.platform_rinkel_conflicts(conflict_type,provider_resource_key) where status='open';

create table if not exists public.platform_rinkel_webhook_events (
  id uuid primary key default gen_random_uuid(),
  platform_integration_id uuid not null references public.platform_integrations(id) on delete restrict,
  tenant_id uuid references public.tenants(id) on delete restrict,
  event_type text not null,
  external_call_id text not null,
  provider_event_id text not null unique,
  payload_hash text not null,
  content_type text not null,
  source_ip inet,
  headers jsonb not null default '{}'::jsonb,
  payload jsonb not null,
  event_at timestamptz,
  status text not null default 'received' check(status in ('received','processing','processed','conflict','failed','dead_letter')),
  attempts integer not null default 0,
  last_error text,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

create table if not exists public.platform_rinkel_jobs (
  id uuid primary key default gen_random_uuid(),
  job_type text not null,
  aggregate_id uuid,
  idempotency_key text not null unique,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check(status in ('pending','processing','completed','failed','dead_letter')),
  attempts integer not null default 0,
  max_attempts integer not null default 10,
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists public.rinkel_call_attempts_v2 (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  call_id uuid not null,
  seller_user_id uuid not null,
  platform_integration_id uuid not null references public.platform_integrations(id) on delete restrict,
  mapping_id uuid not null references public.rinkel_user_mappings_v2(id) on delete restrict,
  user_allocation_id uuid not null references public.rinkel_user_allocations(id) on delete restrict,
  number_allocation_id uuid not null references public.rinkel_number_allocations(id) on delete restrict,
  rinkel_user_id uuid not null references public.platform_rinkel_users(id) on delete restrict,
  rinkel_number_id uuid not null references public.platform_rinkel_numbers(id) on delete restrict,
  external_rinkel_user_id text not null,
  external_rinkel_number_id text not null,
  rinkel_device_id text not null,
  source_number_e164 text not null,
  destination_number_e164 text not null,
  client_request_id uuid not null,
  idempotency_key text not null,
  status text not null default 'requested' check(status in (
    'requested','dial_requested','awaiting_provider_event','matched','failed',
    'provider_outcome_unknown','reconciliation_required','completed','expired'
  )),
  requested_at timestamptz not null default now(),
  provider_request_started_at timestamptz,
  provider_request_finished_at timestamptz,
  external_call_id text,
  error_code text,
  error_message text,
  expires_at timestamptz not null default now()+interval '15 minutes',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(tenant_id,client_request_id),
  unique(tenant_id,idempotency_key),
  foreign key(tenant_id,call_id) references public.calls(tenant_id,id) on delete cascade,
  foreign key(tenant_id,seller_user_id) references public.tenant_memberships(tenant_id,user_id) on delete restrict
);
create unique index if not exists rinkel_call_attempts_v2_active_seller_uidx
  on public.rinkel_call_attempts_v2(tenant_id,seller_user_id)
  where status in ('requested','dial_requested','awaiting_provider_event','matched','provider_outcome_unknown','reconciliation_required');
create unique index if not exists rinkel_call_attempts_v2_active_device_uidx
  on public.rinkel_call_attempts_v2(platform_integration_id,rinkel_device_id)
  where status in ('requested','dial_requested','awaiting_provider_event','matched','provider_outcome_unknown','reconciliation_required');

alter table public.telephony_policies
  add column if not exists telephony_enabled boolean not null default false,
  add column if not exists manual_dialer_enabled boolean not null default true,
  add column if not exists automatic_dialer_enabled boolean not null default false;

-- Central catalog backfill. Ambiguous ownership is quarantined, never guessed.
with integration as (
  select id from public.platform_integrations where provider='rinkel' and disabled_at is null limit 1
)
insert into public.platform_rinkel_users(
  platform_integration_id,external_user_id,external_device_id,email,display_name,active,
  raw_provider_data,provider_created_at,last_synced_at,created_at,updated_at
)
select distinct on (ru.external_user_id)
  i.id,ru.external_user_id,ru.external_device_id,ru.email,ru.display_name,ru.active,
  ru.raw_provider_data,ru.provider_created_at,ru.last_synced_at,ru.created_at,ru.updated_at
from public.rinkel_users ru cross join integration i
order by ru.external_user_id,ru.last_synced_at desc
on conflict(platform_integration_id,external_user_id) do nothing;

with integration as (
  select id from public.platform_integrations where provider='rinkel' and disabled_at is null limit 1
)
insert into public.platform_rinkel_numbers(
  platform_integration_id,external_number_id,phone_number_e164,display_name,country_code,
  provider_status,active,recording_enabled,raw_provider_data,last_synced_at,created_at,updated_at
)
select distinct on (ru.external_number_id)
  i.id,ru.external_number_id,ru.phone_number_e164,ru.display_name,ru.country_code,
  case when ru.active then 'active' else 'inactive' end,ru.active,ru.recording_enabled,
  ru.raw_provider_data,ru.last_synced_at,ru.created_at,ru.updated_at
from public.rinkel_numbers ru cross join integration i
order by ru.external_number_id,ru.last_synced_at desc
on conflict do nothing;

insert into public.rinkel_user_allocations(rinkel_user_id,tenant_id,status,valid_from,allocation_reason)
select pru.id,(array_agg(ru.tenant_id order by ru.created_at))[1],'active',min(ru.created_at),'backfill_unambiguous_legacy_claim'
from public.rinkel_users ru
join public.platform_rinkel_users pru on pru.external_user_id=ru.external_user_id
group by pru.id
having count(distinct ru.tenant_id)=1
on conflict do nothing;

insert into public.rinkel_number_allocations(rinkel_number_id,tenant_id,status,valid_from,allocation_reason)
select prn.id,(array_agg(rn.tenant_id order by rn.created_at))[1],'active',min(rn.created_at),'backfill_unambiguous_legacy_claim'
from public.rinkel_numbers rn
join public.platform_rinkel_numbers prn
  on prn.external_number_id=rn.external_number_id or prn.phone_number_e164=rn.phone_number_e164
group by prn.id
having count(distinct rn.tenant_id)=1
on conflict do nothing;

insert into public.rinkel_number_grants(tenant_id,number_allocation_id,access_level,active)
select a.tenant_id,a.id,'dial',true
from public.rinkel_number_allocations a
where a.status='active' and a.valid_to is null
  and not exists(select 1 from public.rinkel_number_grants g where g.number_allocation_id=a.id and g.active);

insert into public.rinkel_user_mappings_v2(
  tenant_id,kundexa_user_id,rinkel_user_allocation_id,default_number_allocation_id,active,created_by,created_at,updated_at
)
select distinct on (legacy.tenant_id,legacy.kundexa_user_id)
  legacy.tenant_id,legacy.kundexa_user_id,ua.id,na.id,true,legacy.created_by,legacy.created_at,legacy.updated_at
from public.rinkel_user_mappings legacy
join public.rinkel_users legacy_user
  on legacy_user.tenant_id=legacy.tenant_id and legacy_user.id=legacy.rinkel_user_id
join public.platform_rinkel_users platform_user on platform_user.external_user_id=legacy_user.external_user_id
join public.rinkel_user_allocations ua
  on ua.rinkel_user_id=platform_user.id and ua.tenant_id=legacy.tenant_id and ua.status='active' and ua.valid_to is null
join public.rinkel_numbers legacy_number
  on legacy_number.tenant_id=legacy.tenant_id and legacy_number.id=legacy.default_number_id
join public.platform_rinkel_numbers platform_number
  on platform_number.external_number_id=legacy_number.external_number_id
join public.rinkel_number_allocations na
  on na.rinkel_number_id=platform_number.id and na.tenant_id=legacy.tenant_id and na.status='active' and na.valid_to is null
join public.tenant_memberships tm
  on tm.tenant_id=legacy.tenant_id and tm.user_id=legacy.kundexa_user_id and tm.status='active'
where legacy.active and platform_user.active and platform_user.external_device_id is not null and platform_number.active
  and not exists(
    select 1 from public.rinkel_user_mappings_v2 current_mapping
    where current_mapping.tenant_id=legacy.tenant_id
      and current_mapping.kundexa_user_id=legacy.kundexa_user_id
      and current_mapping.active
  )
order by legacy.tenant_id,legacy.kundexa_user_id,legacy.updated_at desc
on conflict do nothing;

insert into public.platform_rinkel_conflicts(
  conflict_type,provider_resource_type,provider_resource_key,claimed_tenant_ids,details
)
select 'legacy_multi_tenant_claim','user',ru.external_user_id,array_agg(distinct ru.tenant_id),
  jsonb_build_object('source','rinkel_users')
from public.rinkel_users ru group by ru.external_user_id having count(distinct ru.tenant_id)>1
on conflict do nothing;
insert into public.platform_rinkel_conflicts(
  conflict_type,provider_resource_type,provider_resource_key,claimed_tenant_ids,details
)
select 'legacy_multi_tenant_claim','number',coalesce(rn.external_number_id,rn.phone_number_e164),
  array_agg(distinct rn.tenant_id),jsonb_build_object('source','rinkel_numbers')
from public.rinkel_numbers rn
group by coalesce(rn.external_number_id,rn.phone_number_e164)
having count(distinct rn.tenant_id)>1
on conflict do nothing;

-- Hard cutover: legacy Rinkel credentials remain auditable but cannot execute.
update public.tenant_integrations
set credentials_ciphertext=null,
    api_key_last_four=null,
    webhook_secret_hash=null,
    webhook_status='disabled',
    status='disabled',
    disabled_at=coalesce(disabled_at,now()),
    configuration=coalesce(configuration,'{}'::jsonb)||'{"migration":"central_rinkel_platform","executable":false}'::jsonb,
    updated_at=now()
where provider='rinkel';
drop index if exists public.tenant_integrations_one_live_rinkel_uidx;
revoke all on function public.rinkel_reserve_outbound_call(uuid,uuid,text,uuid,uuid,uuid,uuid,text,text)
  from public,anon,authenticated,service_role;
revoke all on function public.replace_rinkel_user_mapping(uuid,uuid,uuid)
  from public,anon,authenticated,service_role;
revoke all on public.rinkel_users,public.rinkel_numbers,public.rinkel_user_mappings,
  public.rinkel_capabilities,public.rinkel_webhook_subscriptions
  from public,anon,authenticated;

create or replace function public.allocate_platform_rinkel_resource(
  p_resource_type text,p_resource_id uuid,p_tenant_id uuid,p_reason text default null
) returns uuid
language plpgsql security definer set search_path=public as $$
declare v_actor uuid:=auth.uid(); v_id uuid; v_previous uuid;
begin
  if v_actor is null or not public.is_platform_role(array[
    'platform_owner'::public.platform_role,'platform_admin'::public.platform_role
  ]) then raise exception 'platform_admin_required'; end if;
  if not exists(select 1 from public.tenants where id=p_tenant_id and status in ('trial','active')) then
    raise exception 'tenant_not_active';
  end if;
  if p_resource_type='user' then
    if not exists(select 1 from public.platform_rinkel_users where id=p_resource_id and active) then raise exception 'rinkel_user_inactive'; end if;
    perform pg_advisory_xact_lock(hashtextextended('rinkel-user:'||p_resource_id::text,0));
    select tenant_id into v_previous from public.rinkel_user_allocations where rinkel_user_id=p_resource_id and status='active' and valid_to is null for update;
    update public.rinkel_user_allocations set status='revoked',valid_to=now(),revoked_by=v_actor,updated_at=now()
      where rinkel_user_id=p_resource_id and status='active' and valid_to is null;
    update public.rinkel_user_mappings_v2 m set active=false,updated_at=now()
      where m.rinkel_user_allocation_id in (
        select id from public.rinkel_user_allocations where rinkel_user_id=p_resource_id and status='revoked'
      );
    insert into public.rinkel_user_allocations(rinkel_user_id,tenant_id,allocated_by,allocation_reason)
      values(p_resource_id,p_tenant_id,v_actor,p_reason) returning id into v_id;
  elsif p_resource_type='number' then
    if not exists(select 1 from public.platform_rinkel_numbers where id=p_resource_id and active) then raise exception 'rinkel_number_inactive'; end if;
    perform pg_advisory_xact_lock(hashtextextended('rinkel-number:'||p_resource_id::text,0));
    select tenant_id into v_previous from public.rinkel_number_allocations where rinkel_number_id=p_resource_id and status='active' and valid_to is null for update;
    update public.rinkel_number_allocations set status='revoked',valid_to=now(),revoked_by=v_actor,updated_at=now()
      where rinkel_number_id=p_resource_id and status='active' and valid_to is null;
    update public.rinkel_user_mappings_v2 m set active=false,updated_at=now()
      where m.default_number_allocation_id in (
        select id from public.rinkel_number_allocations where rinkel_number_id=p_resource_id and status='revoked'
      );
    insert into public.rinkel_number_allocations(rinkel_number_id,tenant_id,allocated_by,allocation_reason)
      values(p_resource_id,p_tenant_id,v_actor,p_reason) returning id into v_id;
    insert into public.rinkel_number_grants(tenant_id,number_allocation_id,access_level,active,created_by)
      values(p_tenant_id,v_id,'dial',true,v_actor);
  else raise exception 'invalid_rinkel_resource_type';
  end if;
  insert into public.platform_audit_logs(actor_user_id,action,entity_type,entity_id,tenant_id,reason,metadata)
  values(v_actor,'rinkel.resource_allocated','rinkel_'||p_resource_type,p_resource_id::text,p_tenant_id,p_reason,
    jsonb_build_object('allocation_id',v_id,'previous_tenant_id',v_previous));
  return v_id;
end $$;
revoke all on function public.allocate_platform_rinkel_resource(text,uuid,uuid,text) from public,anon;
grant execute on function public.allocate_platform_rinkel_resource(text,uuid,uuid,text) to authenticated;

create or replace function public.revoke_platform_rinkel_resource(
  p_resource_type text,p_allocation_id uuid,p_reason text default null
) returns void
language plpgsql security definer set search_path=public as $$
declare v_actor uuid:=auth.uid(); v_tenant uuid; v_resource uuid;
begin
  if v_actor is null or not public.is_platform_role(array[
    'platform_owner'::public.platform_role,'platform_admin'::public.platform_role
  ]) then raise exception 'platform_admin_required'; end if;
  if p_resource_type='user' then
    update public.rinkel_user_allocations set status='revoked',valid_to=now(),revoked_by=v_actor,updated_at=now()
      where id=p_allocation_id and status='active' and valid_to is null returning tenant_id,rinkel_user_id into v_tenant,v_resource;
    update public.rinkel_user_mappings_v2 set active=false,updated_at=now()
      where rinkel_user_allocation_id=p_allocation_id and active;
  elsif p_resource_type='number' then
    update public.rinkel_number_allocations set status='revoked',valid_to=now(),revoked_by=v_actor,updated_at=now()
      where id=p_allocation_id and status='active' and valid_to is null returning tenant_id,rinkel_number_id into v_tenant,v_resource;
    update public.rinkel_number_grants set active=false,updated_at=now() where number_allocation_id=p_allocation_id and active;
    update public.rinkel_user_mappings_v2 set active=false,updated_at=now()
      where default_number_allocation_id=p_allocation_id and active;
  else raise exception 'invalid_rinkel_resource_type';
  end if;
  if v_resource is null then raise exception 'active_allocation_not_found'; end if;
  insert into public.platform_audit_logs(actor_user_id,action,entity_type,entity_id,tenant_id,reason)
  values(v_actor,'rinkel.resource_revoked','rinkel_'||p_resource_type,v_resource::text,v_tenant,p_reason);
end $$;
revoke all on function public.revoke_platform_rinkel_resource(text,uuid,text) from public,anon;
grant execute on function public.revoke_platform_rinkel_resource(text,uuid,text) to authenticated;

create or replace function public.replace_rinkel_user_mapping_v2(
  p_kundexa_user_id uuid,p_rinkel_user_allocation_id uuid,p_default_number_allocation_id uuid
) returns uuid
language plpgsql security definer set search_path=public as $$
declare v_tenant uuid:=public.current_tenant_id(); v_actor uuid:=auth.uid(); v_role text:=public.current_membership_role(); v_id uuid;
begin
  if v_tenant is null or v_actor is null then raise exception 'authentication_required'; end if;
  if v_role not in ('owner','admin','team_lead') then raise exception 'rinkel_mapping_permission_required'; end if;
  if not exists(select 1 from public.tenant_memberships where tenant_id=v_tenant and user_id=p_kundexa_user_id and status='active')
    then raise exception 'rinkel_mapping_member_not_active'; end if;
  if v_role='team_lead' and not exists(
    select 1 from public.team_members tm where tm.tenant_id=v_tenant and tm.user_id=p_kundexa_user_id and public.can_manage_team(tm.team_id)
  ) then raise exception 'rinkel_mapping_team_permission_required'; end if;
  if not exists(
    select 1 from public.rinkel_user_allocations a join public.platform_rinkel_users u on u.id=a.rinkel_user_id
    where a.id=p_rinkel_user_allocation_id and a.tenant_id=v_tenant and a.status='active' and a.valid_to is null
      and u.active and u.external_device_id is not null
  ) then raise exception 'RINKEL_USER_NOT_ALLOCATED'; end if;
  if not exists(
    select 1 from public.rinkel_number_allocations a join public.platform_rinkel_numbers n on n.id=a.rinkel_number_id
    where a.id=p_default_number_allocation_id and a.tenant_id=v_tenant and a.status='active' and a.valid_to is null and n.active
  ) then raise exception 'RINKEL_NUMBER_NOT_ALLOCATED'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_tenant::text||':rinkel-mapping:'||p_kundexa_user_id::text,0));
  update public.rinkel_user_mappings_v2 set active=false,updated_at=now()
    where active and (tenant_id=v_tenant and kundexa_user_id=p_kundexa_user_id
      or rinkel_user_allocation_id=p_rinkel_user_allocation_id);
  insert into public.rinkel_user_mappings_v2(
    tenant_id,kundexa_user_id,rinkel_user_allocation_id,default_number_allocation_id,created_by
  ) values(v_tenant,p_kundexa_user_id,p_rinkel_user_allocation_id,p_default_number_allocation_id,v_actor)
  returning id into v_id;
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
  values(v_tenant,v_actor,'rinkel.user_mapping_saved','rinkel_user_mapping',v_id::text,
    jsonb_build_object('kundexa_user_id',p_kundexa_user_id));
  return v_id;
end $$;
revoke all on function public.replace_rinkel_user_mapping_v2(uuid,uuid,uuid) from public,anon;
grant execute on function public.replace_rinkel_user_mapping_v2(uuid,uuid,uuid) to authenticated;

create or replace function public.get_tenant_rinkel_resources()
returns jsonb language sql stable security definer set search_path=public as $$
  select jsonb_build_object(
    'users',coalesce((
      select jsonb_agg(jsonb_build_object(
        'allocationId',a.id,'userId',u.id,'displayName',u.display_name,'email',u.email,
        'hasDevice',u.external_device_id is not null,'active',u.active
      ) order by u.display_name)
      from public.rinkel_user_allocations a join public.platform_rinkel_users u on u.id=a.rinkel_user_id
      where a.tenant_id=public.current_tenant_id() and a.status='active' and a.valid_to is null
    ),'[]'::jsonb),
    'numbers',coalesce((
      select jsonb_agg(jsonb_build_object(
        'allocationId',a.id,'numberId',n.id,'number',n.phone_number_e164,
        'displayName',n.display_name,'recordingEnabled',n.recording_enabled,'active',n.active
      ) order by n.phone_number_e164)
      from public.rinkel_number_allocations a join public.platform_rinkel_numbers n on n.id=a.rinkel_number_id
      where a.tenant_id=public.current_tenant_id() and a.status='active' and a.valid_to is null
    ),'[]'::jsonb),
    'mappings',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',m.id,'kundexaUserId',m.kundexa_user_id,'userAllocationId',m.rinkel_user_allocation_id,
        'numberAllocationId',m.default_number_allocation_id,'active',m.active
      ))
      from public.rinkel_user_mappings_v2 m where m.tenant_id=public.current_tenant_id() and m.active
    ),'[]'::jsonb)
  )
  where public.current_tenant_id() is not null and public.is_tenant_member(public.current_tenant_id())
$$;
revoke all on function public.get_tenant_rinkel_resources() from public,anon;
grant execute on function public.get_tenant_rinkel_resources() to authenticated;

create or replace function public.telephony_status_for_current_user()
returns jsonb language sql stable security definer set search_path=public as $$
with platform as (
  select pi.status,pi.webhook_status,pi.last_verified_at,
    coalesce((pi.capabilities->>'dial')::boolean,false) dial,
    coalesce((pi.capabilities->>'webhooks')::boolean,false) webhooks
  from public.platform_integrations pi where pi.provider='rinkel' and pi.disabled_at is null limit 1
), state as (
  select p.*,tp.telephony_enabled,tp.manual_dialer_enabled,tp.automatic_dialer_enabled,
    m.id mapping_id,u.external_device_id,
    exists(
      select 1 from public.rinkel_number_grants g
      where g.tenant_id=public.current_tenant_id() and g.number_allocation_id=m.default_number_allocation_id and g.active
        and (g.user_id=auth.uid() or g.team_id in (
          select team_id from public.team_members where tenant_id=public.current_tenant_id() and user_id=auth.uid()
        ) or (g.user_id is null and g.team_id is null))
    ) has_grant
  from platform p
  left join public.telephony_policies tp on tp.tenant_id=public.current_tenant_id()
  left join public.rinkel_user_mappings_v2 m
    on m.tenant_id=public.current_tenant_id() and m.kundexa_user_id=auth.uid() and m.active
  left join public.rinkel_user_allocations ua on ua.id=m.rinkel_user_allocation_id and ua.status='active' and ua.valid_to is null
  left join public.platform_rinkel_users u on u.id=ua.rinkel_user_id and u.active
)
select jsonb_build_object(
  'platformConfigured',exists(select 1 from platform),
  'platformReady',coalesce(status in ('connected','degraded') and dial,false),
  'tenantEnabled',coalesce(telephony_enabled,false),
  'tenantHasNumber',exists(select 1 from public.rinkel_number_allocations a where a.tenant_id=public.current_tenant_id() and a.status='active' and a.valid_to is null),
  'userMapped',mapping_id is not null,
  'userHasDevice',external_device_id is not null,
  'userHasNumberAccess',coalesce(has_grant,false),
  'manualReady',coalesce(status in ('connected','degraded') and dial and telephony_enabled and manual_dialer_enabled
    and mapping_id is not null and external_device_id is not null and has_grant,false),
  'automaticReady',coalesce(status in ('connected','degraded') and dial and telephony_enabled and automatic_dialer_enabled
    and mapping_id is not null and external_device_id is not null and has_grant
    and webhook_status='active' and webhooks,false),
  'webhookReady',coalesce(webhook_status='active' and webhooks,false),
  'status',coalesce(status,'not_configured'),
  'errorCode',case
    when not exists(select 1 from platform) then 'RINKEL_PLATFORM_NOT_CONFIGURED'
    when not coalesce(telephony_enabled,false) then 'TELEPHONY_DISABLED'
    when mapping_id is null then 'RINKEL_USER_MAPPING_MISSING'
    when external_device_id is null then 'RINKEL_DEVICE_MISSING'
    when not coalesce(has_grant,false) then 'RINKEL_NUMBER_ACCESS_DENIED'
    else null end
) from state
$$;
revoke all on function public.telephony_status_for_current_user() from public,anon;
grant execute on function public.telephony_status_for_current_user() to authenticated;

create or replace function public.rinkel_reserve_platform_outbound_call(
  p_customer_id uuid,
  p_contact_person_id uuid,
  p_target_phone text,
  p_session_id uuid,
  p_list_member_id uuid,
  p_callback_activity_id uuid,
  p_client_request_id uuid,
  p_idempotency_key text,
  p_purpose text default 'direct_marketing'
) returns jsonb
language plpgsql security definer set search_path=public as $$
declare
  v_tenant uuid:=public.current_tenant_id();
  v_user uuid:=auth.uid();
  v_customer public.customers%rowtype;
  v_contact public.contact_people%rowtype;
  v_policy public.telephony_policies%rowtype;
  v_mapping record;
  v_existing record;
  v_call uuid;
  v_attempt uuid;
  v_local timestamp;
  v_nix text;
  v_is_automatic boolean:=false;
  v_list_id uuid;
begin
  if v_tenant is null or v_user is null then raise exception 'authentication_required'; end if;
  if not public.has_current_role(array['owner','admin','team_lead','sales']) then raise exception 'call_create_permission_required'; end if;
  if p_client_request_id is null or nullif(trim(p_idempotency_key),'') is null then raise exception 'idempotency_required'; end if;
  if p_target_phone !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'target_phone_invalid'; end if;

  select c.id call_id,a.id attempt_id,a.status attempt_status into v_existing
  from public.calls c join public.rinkel_call_attempts_v2 a on a.tenant_id=c.tenant_id and a.call_id=c.id
  where c.tenant_id=v_tenant and (a.client_request_id=p_client_request_id or a.idempotency_key=p_idempotency_key)
  limit 1;
  if found then
    return jsonb_build_object('callId',v_existing.call_id,'attemptId',v_existing.attempt_id,
      'status',v_existing.attempt_status,'idempotentReplay',true);
  end if;

  if not exists(select 1 from public.tenants where id=v_tenant and status in ('trial','active')) then raise exception 'tenant_not_active'; end if;
  if not exists(select 1 from public.tenant_features where tenant_id=v_tenant and feature_key='outbound_calls' and enabled)
    then raise exception 'outbound_calls_feature_disabled'; end if;
  select * into v_policy from public.telephony_policies where tenant_id=v_tenant;
  if not found or not v_policy.telephony_enabled then raise exception 'TELEPHONY_DISABLED'; end if;
  if not v_policy.manual_dialer_enabled then raise exception 'manual_dialer_disabled'; end if;
  v_local:=now() at time zone v_policy.timezone;
  if not (extract(isodow from v_local)::integer=any(v_policy.allowed_days)
    and v_local::time>=v_policy.allowed_start_time and v_local::time<v_policy.allowed_end_time)
    then raise exception 'TELEPHONY_OUTSIDE_ALLOWED_TIME'; end if;

  select * into v_customer from public.customers
  where tenant_id=v_tenant and id=p_customer_id and deleted_at is null for share;
  if not found then raise exception 'customer_not_found'; end if;
  if v_customer.do_not_call then raise exception 'customer_do_not_call'; end if;
  if p_contact_person_id is null then
    if p_target_phone is distinct from v_customer.phone_e164 and p_target_phone is distinct from v_customer.alternate_phone_e164
      then raise exception 'target_phone_customer_mismatch'; end if;
  else
    select * into v_contact from public.contact_people
      where tenant_id=v_tenant and id=p_contact_person_id and customer_id=p_customer_id;
    if not found then raise exception 'contact_person_not_found'; end if;
    if p_target_phone is distinct from v_contact.phone_e164 and p_target_phone is distinct from v_contact.alternate_phone_e164
      then raise exception 'target_phone_contact_mismatch'; end if;
  end if;
  if exists(
    select 1 from public.compliance_blocks b where b.tenant_id=v_tenant
      and (b.customer_id=p_customer_id or b.phone_e164=p_target_phone)
      and 'call'=any(b.channels) and b.active and (b.expires_at is null or b.expires_at>now())
  ) then raise exception 'contact_not_allowed'; end if;
  if p_purpose in ('direct_marketing','automation_marketing') then
    select result into v_nix from public.nix_checks where tenant_id=v_tenant
      and phone_e164=p_target_phone and valid_until>now() order by checked_at desc limit 1;
    if v_nix is null or v_nix in ('unknown','error') then raise exception 'target_nix_check_required'; end if;
    if v_nix<>'not_listed' then raise exception 'target_nix_%',v_nix; end if;
  end if;

  if p_session_id is not null or p_list_member_id is not null then
    if p_session_id is null or p_list_member_id is null then raise exception 'list_call_context_incomplete'; end if;
    select ds.list_id,(ds.mode='automatic') into v_list_id,v_is_automatic
    from public.dialer_sessions ds
    join public.customer_list_members lm on lm.tenant_id=ds.tenant_id and lm.list_id=ds.list_id
      and lm.id=p_list_member_id and lm.customer_id=p_customer_id
      and lm.claimed_by=v_user and lm.claim_expires_at>now()
    join public.customer_lists l on l.tenant_id=ds.tenant_id and l.id=ds.list_id and l.status='active'
    where ds.tenant_id=v_tenant and ds.id=p_session_id and ds.user_id=v_user and ds.state in ('active','after_call')
    for update of ds,lm;
    if not found then raise exception 'dialer_session_or_claim_not_active'; end if;
    if v_is_automatic and not v_policy.automatic_dialer_enabled then raise exception 'automatic_dialer_disabled'; end if;
  elsif p_callback_activity_id is not null and not exists(
    select 1 from public.activities a where a.tenant_id=v_tenant and a.id=p_callback_activity_id
      and a.customer_id=p_customer_id and a.type='callback' and a.status in ('open','in_progress')
      and (a.assigned_user_id=v_user or (a.callback_scope='global' and a.claimed_by=v_user))
  ) then raise exception 'callback_not_available'; end if;

  select m.id mapping_id,m.rinkel_user_allocation_id,m.default_number_allocation_id,
    pi.id platform_integration_id,pu.id rinkel_user_id,pu.external_user_id,pu.external_device_id,
    pn.id rinkel_number_id,pn.external_number_id,pn.phone_number_e164
  into v_mapping
  from public.rinkel_user_mappings_v2 m
  join public.rinkel_user_allocations ua on ua.id=m.rinkel_user_allocation_id
    and ua.tenant_id=m.tenant_id and ua.status='active' and ua.valid_to is null
  join public.platform_rinkel_users pu on pu.id=ua.rinkel_user_id and pu.active and pu.external_device_id is not null
  join public.rinkel_number_allocations na on na.id=m.default_number_allocation_id
    and na.tenant_id=m.tenant_id and na.status='active' and na.valid_to is null
  join public.platform_rinkel_numbers pn on pn.id=na.rinkel_number_id and pn.active
  join public.platform_integrations pi on pi.id=pu.platform_integration_id
    and pi.id=pn.platform_integration_id and pi.provider='rinkel'
    and pi.disabled_at is null and pi.status in ('connected','degraded')
  where m.tenant_id=v_tenant and m.kundexa_user_id=v_user and m.active
    and exists(
      select 1 from public.rinkel_number_grants g
      where g.tenant_id=v_tenant and g.number_allocation_id=na.id and g.active
        and (g.user_id=v_user or g.team_id in(
          select team_id from public.team_members where tenant_id=v_tenant and user_id=v_user
        ) or (g.user_id is null and g.team_id is null))
    );
  if not found then raise exception 'RINKEL_USER_MAPPING_MISSING_OR_NUMBER_ACCESS_DENIED'; end if;
  if v_is_automatic and not exists(
    select 1 from public.platform_integrations pi
    where pi.id=v_mapping.platform_integration_id and pi.webhook_status='active'
      and coalesce((pi.capabilities->>'webhooks')::boolean,false)
      and pi.webhook_last_received_at>now()-interval '24 hours'
  ) then raise exception 'RINKEL_WEBHOOKS_NOT_READY'; end if;

  perform pg_advisory_xact_lock(hashtextextended(v_tenant::text||':'||v_user::text,0));
  if exists(select 1 from public.rinkel_call_attempts_v2 where
    (tenant_id=v_tenant and seller_user_id=v_user or
     platform_integration_id=v_mapping.platform_integration_id and rinkel_device_id=v_mapping.external_device_id)
    and status in ('requested','dial_requested','awaiting_provider_event','matched','provider_outcome_unknown','reconciliation_required')
  ) then raise exception 'active_call_already_exists'; end if;

  insert into public.calls(
    tenant_id,provider,customer_id,contact_person_id,user_id,team_id,direction,from_number,to_number,status,
    provider_user_id,provider_device_id,recording_enabled,recording_status,transcription_status,insights_status,
    idempotency_key,purpose,list_id,list_member_id,dialer_session_id,callback_activity_id,callback_token_hash,metadata
  ) values(
    v_tenant,'rinkel',p_customer_id,p_contact_person_id,v_user,v_customer.assigned_team_id,'outbound',
    v_mapping.phone_number_e164,p_target_phone,'requested',v_mapping.external_user_id,v_mapping.external_device_id,
    v_policy.recording_enabled,case when v_policy.recording_enabled then 'pending' else 'not_expected' end,
    case when v_policy.transcription_enabled then 'pending' else 'disabled' end,
    case when v_policy.ai_analysis_enabled then 'pending' else 'disabled' end,
    p_idempotency_key,p_purpose,v_list_id,p_list_member_id,p_session_id,p_callback_activity_id,
    encode(digest(p_idempotency_key,'sha256'),'hex'),
    jsonb_build_object(
      'platform_integration_id',v_mapping.platform_integration_id,
      'mapping_id',v_mapping.mapping_id,'user_allocation_id',v_mapping.rinkel_user_allocation_id,
      'number_allocation_id',v_mapping.default_number_allocation_id,
      'rinkel_user_id',v_mapping.rinkel_user_id,'rinkel_number_id',v_mapping.rinkel_number_id,
      'external_rinkel_user_id',v_mapping.external_user_id,
      'external_rinkel_number_id',v_mapping.external_number_id
    )
  ) returning id into v_call;

  insert into public.rinkel_call_attempts_v2(
    tenant_id,call_id,seller_user_id,platform_integration_id,mapping_id,user_allocation_id,number_allocation_id,
    rinkel_user_id,rinkel_number_id,external_rinkel_user_id,external_rinkel_number_id,rinkel_device_id,
    source_number_e164,destination_number_e164,client_request_id,idempotency_key
  ) values(
    v_tenant,v_call,v_user,v_mapping.platform_integration_id,v_mapping.mapping_id,
    v_mapping.rinkel_user_allocation_id,v_mapping.default_number_allocation_id,
    v_mapping.rinkel_user_id,v_mapping.rinkel_number_id,v_mapping.external_user_id,
    v_mapping.external_number_id,v_mapping.external_device_id,v_mapping.phone_number_e164,
    p_target_phone,p_client_request_id,p_idempotency_key
  ) returning id into v_attempt;
  if p_session_id is not null then
    update public.customer_list_members set state='dialing',attempts=attempts+1,last_call_id=v_call,
      last_contacted_at=now(),claim_expires_at=now()+interval '2 hours'
      where tenant_id=v_tenant and id=p_list_member_id;
    update public.dialer_sessions set state='calling',current_call_id=v_call,last_seen_at=now()
      where tenant_id=v_tenant and id=p_session_id;
  end if;
  if p_callback_activity_id is not null then
    update public.activities set status='in_progress',claimed_by=v_user,claim_expires_at=now()+interval '2 hours',call_id=v_call
      where tenant_id=v_tenant and id=p_callback_activity_id;
  end if;
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
  values(v_tenant,v_user,'rinkel.call_reserved','call',v_call::text,
    jsonb_build_object('attempt_id',v_attempt,'customer_id',p_customer_id,'destination_suffix',right(p_target_phone,4)));
  return jsonb_build_object(
    'callId',v_call,'attemptId',v_attempt,'deviceId',v_mapping.external_device_id,
    'numberId',v_mapping.external_number_id,'to',p_target_phone,'status','requested','idempotentReplay',false
  );
end $$;
revoke all on function public.rinkel_reserve_platform_outbound_call(uuid,uuid,text,uuid,uuid,uuid,uuid,text,text) from public,anon;
grant execute on function public.rinkel_reserve_platform_outbound_call(uuid,uuid,text,uuid,uuid,uuid,uuid,text,text) to authenticated;

create or replace function public.rinkel_finalize_platform_dial(
  p_call_id uuid,p_attempt_id uuid,p_outcome text,p_error_code text default null,p_error_message text default null
) returns void
language plpgsql security definer set search_path=public as $$
declare v_tenant uuid; v_now timestamptz:=now();
begin
  if auth.role()<>'service_role' then raise exception 'service_role_required'; end if;
  if p_outcome not in ('accepted','failed','unknown') then raise exception 'invalid_dial_outcome'; end if;
  select tenant_id into v_tenant from public.calls where id=p_call_id and provider='rinkel' for update;
  if v_tenant is null or not exists(
    select 1 from public.rinkel_call_attempts_v2 where id=p_attempt_id and call_id=p_call_id and tenant_id=v_tenant
  ) then raise exception 'rinkel_attempt_not_found'; end if;
  update public.rinkel_call_attempts_v2 set
    status=case p_outcome when 'accepted' then 'awaiting_provider_event' when 'unknown' then 'provider_outcome_unknown' else 'failed' end,
    provider_request_finished_at=v_now,error_code=p_error_code,error_message=left(p_error_message,500),updated_at=v_now
  where id=p_attempt_id;
  update public.calls set
    status=case p_outcome when 'accepted' then 'dial_requested' when 'unknown' then 'provider_outcome_unknown' else 'failed' end,
    initiated_at=case when p_outcome='accepted' then coalesce(initiated_at,v_now) else initiated_at end,
    ended_at=case when p_outcome='failed' then coalesce(ended_at,v_now) else ended_at end,
    end_cause=case when p_outcome='failed' then coalesce(p_error_code,'RINKEL_DIAL_FAILED') else end_cause end
  where id=p_call_id and tenant_id=v_tenant
    and status not in ('completed','unanswered','blocked','voicemail','outside_business_hours','cancelled');
  if p_outcome='unknown' then
    insert into public.platform_rinkel_jobs(job_type,aggregate_id,idempotency_key,payload)
    values('rinkel.reconcile_unknown_dial',p_attempt_id,'rinkel.reconcile_unknown_dial:'||p_attempt_id,
      jsonb_build_object('attempt_id',p_attempt_id,'call_id',p_call_id))
    on conflict(idempotency_key) do nothing;
  end if;
end $$;
revoke all on function public.rinkel_finalize_platform_dial(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.rinkel_finalize_platform_dial(uuid,uuid,text,text,text) to service_role;

alter table public.platform_integrations enable row level security;
alter table public.platform_rinkel_users enable row level security;
alter table public.platform_rinkel_numbers enable row level security;
alter table public.rinkel_user_allocations enable row level security;
alter table public.rinkel_number_allocations enable row level security;
alter table public.rinkel_number_grants enable row level security;
alter table public.rinkel_user_mappings_v2 enable row level security;
alter table public.platform_rinkel_capabilities enable row level security;
alter table public.platform_rinkel_webhook_subscriptions enable row level security;
alter table public.platform_rinkel_conflicts enable row level security;
alter table public.platform_rinkel_webhook_events enable row level security;
alter table public.platform_rinkel_jobs enable row level security;
alter table public.rinkel_call_attempts_v2 enable row level security;

create policy rinkel_user_allocations_tenant_read on public.rinkel_user_allocations for select to authenticated
  using(tenant_id=public.current_tenant_id() and public.is_tenant_admin(tenant_id));
create policy rinkel_number_allocations_tenant_read on public.rinkel_number_allocations for select to authenticated
  using(tenant_id=public.current_tenant_id() and public.is_tenant_member(tenant_id));
create policy rinkel_number_grants_tenant_read on public.rinkel_number_grants for select to authenticated
  using(tenant_id=public.current_tenant_id() and (
    public.is_tenant_admin(tenant_id) or user_id=auth.uid() or
    team_id in(select team_id from public.team_members where tenant_id=rinkel_number_grants.tenant_id and user_id=auth.uid())
  ));
create policy rinkel_user_mappings_v2_tenant_read on public.rinkel_user_mappings_v2 for select to authenticated
  using(tenant_id=public.current_tenant_id() and (
    public.is_tenant_admin(tenant_id) or kundexa_user_id=auth.uid()
  ));
create policy rinkel_call_attempts_v2_call_read on public.rinkel_call_attempts_v2 for select to authenticated
  using(tenant_id=public.current_tenant_id() and public.can_access_call(call_id));

revoke all on public.platform_integrations,public.platform_rinkel_users,public.platform_rinkel_numbers,
  public.platform_rinkel_capabilities,public.platform_rinkel_webhook_subscriptions,
  public.platform_rinkel_conflicts,public.platform_rinkel_webhook_events,public.platform_rinkel_jobs
from public,anon,authenticated;
grant select on public.rinkel_user_allocations,public.rinkel_number_allocations,
  public.rinkel_number_grants,public.rinkel_user_mappings_v2,public.rinkel_call_attempts_v2
to authenticated;

create trigger platform_integrations_touch before update on public.platform_integrations
  for each row execute function public.touch_updated_at();
create trigger platform_rinkel_users_touch before update on public.platform_rinkel_users
  for each row execute function public.touch_updated_at();
create trigger platform_rinkel_numbers_touch before update on public.platform_rinkel_numbers
  for each row execute function public.touch_updated_at();
create trigger rinkel_user_allocations_touch before update on public.rinkel_user_allocations
  for each row execute function public.touch_updated_at();
create trigger rinkel_number_allocations_touch before update on public.rinkel_number_allocations
  for each row execute function public.touch_updated_at();
create trigger rinkel_number_grants_touch before update on public.rinkel_number_grants
  for each row execute function public.touch_updated_at();
create trigger rinkel_user_mappings_v2_touch before update on public.rinkel_user_mappings_v2
  for each row execute function public.touch_updated_at();

commit;
