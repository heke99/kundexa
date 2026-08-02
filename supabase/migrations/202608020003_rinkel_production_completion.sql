begin;

-- Canonical integration identity. Historical disabled rows may remain for audit,
-- but every runtime query must resolve exactly one canonical Rinkel row.
alter table public.platform_integrations
  add column if not exists is_canonical boolean not null default false,
  add column if not exists last_error_at timestamptz,
  add column if not exists last_error_operation text;

insert into public.platform_integrations(provider,provider_type,name,status,configuration,is_canonical)
select 'rinkel','telephony','Rinkel','not_configured','{"account_mode":"platform_managed","api_version":"v1"}'::jsonb,false
where not exists(select 1 from public.platform_integrations where provider='rinkel');

with canonical as (
  select id
  from public.platform_integrations
  where provider='rinkel'
  order by
    (disabled_at is null and status <> 'disabled') desc,
    coalesce(last_verified_at,last_connection_test_at,updated_at,created_at) desc,
    created_at desc,
    id
  limit 1
)
update public.platform_integrations pi
set is_canonical=(pi.id=(select id from canonical))
where pi.provider='rinkel';

-- Preserve historical duplicate rows but remove them from every active runtime
-- path before the canonical constraint is installed.
with disabled_duplicates as (
  update public.platform_integrations
  set status='disabled',
      disabled_at=coalesce(disabled_at,now()),
      last_error_code='RINKEL_DUPLICATE_INTEGRATION_DISABLED',
      last_error_message='Raden avaktiverades av den kanoniska Rinkel-migreringen.',
      last_error_at=now(),
      last_error_operation='canonicalization',
      updated_at=now()
  where provider='rinkel' and not is_canonical
    and (disabled_at is null or status<>'disabled')
  returning id
)
insert into public.platform_audit_logs(actor_user_id,action,entity_type,entity_id,reason,metadata)
select null,'rinkel.duplicate_integration_disabled','platform_integration',id::text,
  'Forward migration retained one canonical central Rinkel integration','{}'::jsonb
from disabled_duplicates;

create unique index if not exists platform_integrations_one_canonical_rinkel_uidx
  on public.platform_integrations((provider))
  where provider='rinkel' and is_canonical;
alter table public.platform_integrations drop constraint if exists platform_integrations_canonical_provider_check;
alter table public.platform_integrations add constraint platform_integrations_canonical_provider_check
  check(not is_canonical or provider='rinkel');
alter table public.platform_integrations drop constraint if exists platform_integrations_active_rinkel_is_canonical_check;
alter table public.platform_integrations add constraint platform_integrations_active_rinkel_is_canonical_check
  check(provider<>'rinkel' or disabled_at is not null or status='disabled' or is_canonical);

-- Truthful, separately verified provider capabilities.
alter table public.platform_rinkel_capabilities
  add column if not exists users_catalog boolean not null default false,
  add column if not exists numbers_catalog boolean not null default false,
  add column if not exists dial_endpoint_reachable boolean not null default false,
  add column if not exists dial_configured boolean not null default false,
  add column if not exists dial_test_succeeded boolean not null default false,
  add column if not exists dial_tested_at timestamptz,
  add column if not exists webhooks_registration boolean not null default false,
  add column if not exists core_webhooks_verified boolean not null default false,
  add column if not exists recording_detected boolean not null default false,
  add column if not exists transcription_supported boolean not null default false,
  add column if not exists insights_supported boolean not null default false,
  add column if not exists note_sync_supported boolean not null default false;

-- A Rinkel user can expose more than one device. Mappings point to a concrete,
-- active device instead of relying on a mutable legacy scalar on the user row.
create table if not exists public.platform_rinkel_devices (
  id uuid primary key default gen_random_uuid(),
  platform_integration_id uuid not null references public.platform_integrations(id) on delete restrict,
  platform_rinkel_user_id uuid not null references public.platform_rinkel_users(id) on delete cascade,
  provider_device_id text not null,
  display_name text,
  device_type text,
  provider_status text not null default 'unknown',
  active boolean not null default true,
  last_seen_at timestamptz,
  last_synced_at timestamptz not null default now(),
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(platform_rinkel_user_id,provider_device_id)
);
create index if not exists platform_rinkel_devices_active_user_idx
  on public.platform_rinkel_devices(platform_rinkel_user_id,active,last_synced_at desc);

insert into public.platform_rinkel_devices(
  platform_integration_id,platform_rinkel_user_id,provider_device_id,display_name,
  provider_status,active,last_seen_at,last_synced_at,raw_payload
)
select u.platform_integration_id,u.id,u.external_device_id,'Legacy standardenhet',
  case when u.active then 'active' else 'inactive' end,u.active,u.last_synced_at,u.last_synced_at,
  jsonb_build_object('source','legacy_external_device_id')
from public.platform_rinkel_users u
where u.external_device_id is not null
on conflict(platform_rinkel_user_id,provider_device_id) do nothing;

alter table public.rinkel_user_mappings_v2
  add column if not exists selected_device_id uuid references public.platform_rinkel_devices(id) on delete restrict;

update public.rinkel_user_mappings_v2 m
set selected_device_id=(
  select d.id
  from public.rinkel_user_allocations a
  join public.platform_rinkel_devices d
    on d.platform_rinkel_user_id=a.rinkel_user_id
   and d.active
  where a.id=m.rinkel_user_allocation_id
  order by d.last_synced_at desc,d.id
  limit 1
)
where m.selected_device_id is null
  and exists (
    select 1
    from public.rinkel_user_allocations a
    join public.platform_rinkel_devices d
      on d.platform_rinkel_user_id=a.rinkel_user_id
     and d.active
    where a.id=m.rinkel_user_allocation_id
  );

alter table public.rinkel_call_attempts_v2
  add column if not exists selected_device_id uuid references public.platform_rinkel_devices(id) on delete restrict,
  add column if not exists caller_id_source text,
  add column if not exists caller_id_allocation_id uuid references public.rinkel_number_allocations(id) on delete restrict;

alter table public.calls drop constraint if exists calls_transcription_status_check;
alter table public.calls add constraint calls_transcription_status_check check(transcription_status in (
  'disabled','pending','pending_provider','processing','available','not_available','failed','deleted'
));
alter table public.call_transcripts drop constraint if exists call_transcripts_status_check;
alter table public.call_transcripts add constraint call_transcripts_status_check check(status in (
  'disabled','pending','pending_provider','processing','available','not_available','failed','deleted'
));

-- Canonical caller-ID defaults. Each scoped default references an allocation,
-- never a free-form visible number, so the provider-internal numberId remains authoritative.
create unique index if not exists rinkel_number_allocations_tenant_id_uidx
  on public.rinkel_number_allocations(tenant_id,id);
alter table public.customer_lists
  add column if not exists rinkel_number_allocation_id uuid;
alter table public.campaigns
  add column if not exists rinkel_number_allocation_id uuid;
alter table public.teams
  add column if not exists rinkel_number_allocation_id uuid;
alter table public.telephony_policies
  add column if not exists default_number_allocation_id uuid;
alter table public.platform_rinkel_numbers
  add column if not exists is_platform_default boolean not null default false;

do $$ begin
  alter table public.customer_lists add constraint customer_lists_rinkel_number_allocation_fk
    foreign key(tenant_id,rinkel_number_allocation_id)
    references public.rinkel_number_allocations(tenant_id,id) on delete restrict;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.campaigns add constraint campaigns_rinkel_number_allocation_fk
    foreign key(tenant_id,rinkel_number_allocation_id)
    references public.rinkel_number_allocations(tenant_id,id) on delete restrict;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.teams add constraint teams_rinkel_number_allocation_fk
    foreign key(tenant_id,rinkel_number_allocation_id)
    references public.rinkel_number_allocations(tenant_id,id) on delete restrict;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.telephony_policies add constraint telephony_policies_default_rinkel_number_allocation_fk
    foreign key(tenant_id,default_number_allocation_id)
    references public.rinkel_number_allocations(tenant_id,id) on delete restrict;
exception when duplicate_object then null; end $$;

create unique index if not exists platform_rinkel_numbers_one_platform_default_uidx
  on public.platform_rinkel_numbers(platform_integration_id)
  where is_platform_default and active;

-- Existing databases may contain several historical defaults because team and
-- tenant uniqueness did not previously exist. Keep the newest active grant and
-- demote older defaults before installing the constraints; preserve an audit row.
with ranked as (
  select id,tenant_id,team_id,
    row_number() over(partition by tenant_id,team_id order by updated_at desc,created_at desc,id) as rn
  from public.rinkel_number_grants
  where active and is_default and team_id is not null and user_id is null
), demoted as (
  update public.rinkel_number_grants g
  set is_default=false,updated_at=now()
  from ranked r
  where g.id=r.id and r.rn>1
  returning g.id,g.tenant_id,g.team_id
)
insert into public.platform_audit_logs(actor_user_id,action,entity_type,entity_id,tenant_id,reason,metadata)
select null,'rinkel.default_grant_deduplicated','rinkel_number_grant',null,tenant_id,
  'Forward migration retained one team default per scope',
  jsonb_build_object('scope','team','team_id',team_id,'demoted_count',count(*))
from demoted
group by tenant_id,team_id;

with ranked as (
  select id,tenant_id,
    row_number() over(partition by tenant_id order by updated_at desc,created_at desc,id) as rn
  from public.rinkel_number_grants
  where active and is_default and team_id is null and user_id is null
), demoted as (
  update public.rinkel_number_grants g
  set is_default=false,updated_at=now()
  from ranked r
  where g.id=r.id and r.rn>1
  returning g.id,g.tenant_id
)
insert into public.platform_audit_logs(actor_user_id,action,entity_type,entity_id,tenant_id,reason,metadata)
select null,'rinkel.default_grant_deduplicated','rinkel_number_grant',null,tenant_id,
  'Forward migration retained one tenant default per scope',
  jsonb_build_object('scope','tenant','demoted_count',count(*))
from demoted
group by tenant_id;

create unique index if not exists rinkel_number_grants_team_default_uidx
  on public.rinkel_number_grants(tenant_id,team_id)
  where active and is_default and team_id is not null and user_id is null;
create unique index if not exists rinkel_number_grants_tenant_default_uidx
  on public.rinkel_number_grants(tenant_id)
  where active and is_default and team_id is null and user_id is null;

-- Webhook registration, provider verification and local receipt are separate states.
-- Convert legacy values before installing the stricter forward-only constraints.
alter table public.platform_integrations drop constraint if exists platform_integrations_webhook_status_check;
update public.platform_integrations
set webhook_status=case webhook_status
  when 'pending' then 'registering'
  when 'active' then 'registered'
  else webhook_status
end
where webhook_status in ('pending','active');
alter table public.platform_integrations add constraint platform_integrations_webhook_status_check
  check (webhook_status in ('not_configured','registering','registered','test_pending','verified','degraded','failed','disabled','error'));

alter table public.platform_rinkel_webhook_subscriptions drop constraint if exists platform_rinkel_webhook_subscriptions_status_check;
update public.platform_rinkel_webhook_subscriptions
set status=case status
  when 'active' then 'registered'
  when 'pending' then 'registering'
  else status
end
where status in ('active','pending');
alter table public.platform_rinkel_webhook_subscriptions add constraint platform_rinkel_webhook_subscriptions_status_check
  check (status in ('not_configured','registering','registered','test_pending','verified','degraded','failed','disabled','unsupported','error'));

alter table public.platform_rinkel_webhook_subscriptions
  add column if not exists required boolean not null default true,
  add column if not exists target_url_redacted text,
  add column if not exists provider_active boolean,
  add column if not exists registered_at timestamptz,
  add column if not exists test_requested_at timestamptz,
  add column if not exists test_received_at timestamptz,
  add column if not exists last_processed_at timestamptz,
  add column if not exists last_http_status integer,
  add column if not exists received_count bigint not null default 0,
  add column if not exists processed_count bigint not null default 0,
  add column if not exists failed_count bigint not null default 0,
  add column if not exists last_error_code text,
  add column if not exists last_error_message text;

update public.platform_rinkel_webhook_subscriptions
set required=(event_type in ('incomingCall','outgoingCall','callStart','callEnd')),
    registered_at=coalesce(registered_at,last_verified_at,created_at),
    provider_active=case when status in ('registered','verified') then true else provider_active end;

-- Webhook counters and verification transitions must be atomic. Route handlers and
-- workers call these service-only functions instead of read-modify-write counters.
create or replace function public.record_platform_rinkel_webhook_receipt(
  p_platform_integration_id uuid,
  p_event_type text,
  p_received_at timestamptz,
  p_http_status integer,
  p_is_test_receipt boolean default false
) returns void
language plpgsql
security definer
set search_path=public
as $$
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception 'service_role_required';
  end if;

  update public.platform_integrations
  set webhook_last_received_at=greatest(coalesce(webhook_last_received_at,'-infinity'::timestamptz),p_received_at),
      updated_at=now()
  where id=p_platform_integration_id and provider='rinkel' and is_canonical;
  if not found then raise exception 'canonical_rinkel_integration_not_found'; end if;

  update public.platform_rinkel_webhook_subscriptions
  set last_received_at=greatest(coalesce(last_received_at,'-infinity'::timestamptz),p_received_at),
      test_received_at=case when p_is_test_receipt then p_received_at else test_received_at end,
      received_count=received_count+1,
      last_http_status=p_http_status,
      last_error=null,
      last_error_code=null,
      last_error_message=null,
      updated_at=now()
  where platform_integration_id=p_platform_integration_id and event_type=p_event_type;
  if not found then raise exception 'rinkel_webhook_subscription_not_found'; end if;
end $$;
revoke all on function public.record_platform_rinkel_webhook_receipt(uuid,text,timestamptz,integer,boolean) from public,anon,authenticated;
grant execute on function public.record_platform_rinkel_webhook_receipt(uuid,text,timestamptz,integer,boolean) to service_role;

create or replace function public.record_platform_rinkel_webhook_processed(
  p_platform_integration_id uuid,
  p_event_type text,
  p_processed_at timestamptz
) returns boolean
language plpgsql
security definer
set search_path=public
as $$
declare v_core_verified boolean;
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception 'service_role_required';
  end if;

  update public.platform_rinkel_webhook_subscriptions
  set status=case when test_received_at is not null then 'verified' else status end,
      last_processed_at=greatest(coalesce(last_processed_at,'-infinity'::timestamptz),p_processed_at),
      last_verified_at=case when test_received_at is not null then p_processed_at else last_verified_at end,
      processed_count=processed_count+1,
      last_error=null,
      last_error_code=null,
      last_error_message=null,
      updated_at=now()
  where platform_integration_id=p_platform_integration_id and event_type=p_event_type;
  if not found then raise exception 'rinkel_webhook_subscription_not_found'; end if;

  select count(*)=4 into v_core_verified
  from public.platform_rinkel_webhook_subscriptions
  where platform_integration_id=p_platform_integration_id
    and event_type in ('incomingCall','outgoingCall','callStart','callEnd')
    and status='verified';

  if v_core_verified then
    update public.platform_integrations
    set webhook_status='verified',
        capabilities=coalesce(capabilities,'{}'::jsonb)||jsonb_build_object(
          'webhooks',true,'webhooks_registration',true,'core_webhooks_verified',true
        ),
        last_error_code=case when last_error_operation in ('webhook_registration','webhook_worker') then null else last_error_code end,
        last_error_message=case when last_error_operation in ('webhook_registration','webhook_worker') then null else last_error_message end,
        last_error_at=case when last_error_operation in ('webhook_registration','webhook_worker') then null else last_error_at end,
        last_error_operation=case when last_error_operation in ('webhook_registration','webhook_worker') then null else last_error_operation end,
        updated_at=now()
    where id=p_platform_integration_id and provider='rinkel' and is_canonical;

    insert into public.platform_rinkel_capabilities(
      platform_integration_id,webhooks,webhooks_registration,core_webhooks_verified,detected_at
    ) values(p_platform_integration_id,true,true,true,p_processed_at)
    on conflict(platform_integration_id) do update set
      webhooks=true,
      webhooks_registration=true,
      core_webhooks_verified=true,
      detected_at=excluded.detected_at;
  end if;
  return v_core_verified;
end $$;
revoke all on function public.record_platform_rinkel_webhook_processed(uuid,text,timestamptz) from public,anon,authenticated;
grant execute on function public.record_platform_rinkel_webhook_processed(uuid,text,timestamptz) to service_role;

create or replace function public.record_platform_rinkel_webhook_failure(
  p_event_id uuid,
  p_error_code text,
  p_error_message text,
  p_retry_at timestamptz
) returns void
language plpgsql
security definer
set search_path=public
as $$
declare v_event public.platform_rinkel_webhook_events%rowtype; v_required boolean;
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception 'service_role_required';
  end if;
  select * into v_event from public.platform_rinkel_webhook_events where id=p_event_id for update;
  if not found then raise exception 'rinkel_webhook_event_not_found'; end if;

  update public.platform_rinkel_webhook_events
  set status='failed',
      next_retry_at=p_retry_at,
      last_error=left(coalesce(p_error_code,'WORKER_JOB_FAILED')||': '||coalesce(p_error_message,'unknown_error'),500),
      processed_at=null
  where id=p_event_id;

  update public.platform_rinkel_webhook_subscriptions
  set status=case when required then 'degraded' else status end,
      failed_count=failed_count+1,
      last_error=left(coalesce(p_error_message,p_error_code,'unknown_error'),500),
      last_error_code=left(coalesce(p_error_code,'WORKER_JOB_FAILED'),100),
      last_error_message=left(coalesce(p_error_message,'unknown_error'),500),
      updated_at=now()
  where platform_integration_id=v_event.platform_integration_id and event_type=v_event.event_type
  returning required into v_required;

  if coalesce(v_required,false) then
    update public.platform_integrations
    set webhook_status='degraded',
        status=case when status='connected' then 'degraded' else status end,
        last_error_code=left(coalesce(p_error_code,'WORKER_JOB_FAILED'),100),
        last_error_message=left(coalesce(p_error_message,'unknown_error'),500),
        last_error_at=now(),
        last_error_operation='webhook_worker',
        updated_at=now()
    where id=v_event.platform_integration_id and provider='rinkel' and is_canonical;
  end if;
end $$;
revoke all on function public.record_platform_rinkel_webhook_failure(uuid,text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.record_platform_rinkel_webhook_failure(uuid,text,text,timestamptz) to service_role;

-- Durable worker leases, structured errors and a heartbeat are database state,
-- not process memory.
alter table public.platform_rinkel_jobs
  add column if not exists last_error_code text,
  add column if not exists last_error_message text,
  add column if not exists dead_lettered_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

create index if not exists platform_rinkel_jobs_claim_idx
  on public.platform_rinkel_jobs(status,available_at,created_at)
  where status in ('pending','failed');
create index if not exists platform_rinkel_jobs_stale_lock_idx
  on public.platform_rinkel_jobs(locked_at)
  where status='processing';

create table if not exists public.platform_worker_heartbeats (
  worker_key text primary key,
  worker_id text,
  status text not null default 'unknown' check(status in ('unknown','running','healthy','degraded','failed')),
  started_at timestamptz,
  finished_at timestamptz,
  last_success_at timestamptz,
  fetched_count integer not null default 0,
  processed_count integer not null default 0,
  failed_count integer not null default 0,
  requeued_count integer not null default 0,
  last_error_code text,
  last_error_message text,
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create or replace function public.claim_platform_rinkel_jobs(
  p_worker_id text,
  p_limit integer default 25,
  p_lease_timeout interval default interval '5 minutes'
) returns setof public.platform_rinkel_jobs
language plpgsql
security definer
set search_path=public
as $$
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception 'service_role_required';
  end if;
  if nullif(trim(p_worker_id),'') is null then raise exception 'worker_id_required'; end if;

  update public.platform_rinkel_jobs
  set status=case when attempts>=max_attempts then 'dead_letter' else 'failed' end,
      available_at=now(),
      locked_at=null,
      locked_by=null,
      last_error='WORKER_LEASE_EXPIRED',
      last_error_code='WORKER_LEASE_EXPIRED',
      last_error_message='Jobbet återställdes efter att worker-leasen löpte ut.',
      dead_lettered_at=case when attempts>=max_attempts then now() else null end,
      updated_at=now()
  where status='processing'
    and locked_at < now()-p_lease_timeout;

  return query
  with candidates as (
    select id
    from public.platform_rinkel_jobs
    where status in ('pending','failed')
      and available_at <= now()
      and attempts < max_attempts
    order by available_at,created_at,id
    for update skip locked
    limit greatest(1,least(coalesce(p_limit,25),100))
  )
  update public.platform_rinkel_jobs j
  set status='processing',
      attempts=j.attempts+1,
      locked_at=now(),
      locked_by=left(p_worker_id,200),
      updated_at=now()
  from candidates c
  where j.id=c.id
  returning j.*;
end $$;
revoke all on function public.claim_platform_rinkel_jobs(text,integer,interval) from public,anon,authenticated;
grant execute on function public.claim_platform_rinkel_jobs(text,integer,interval) to service_role;

create or replace function public.finish_platform_rinkel_job(
  p_job_id uuid,
  p_worker_id text,
  p_succeeded boolean,
  p_error_code text default null,
  p_error_message text default null,
  p_retry_at timestamptz default null
) returns text
language plpgsql
security definer
set search_path=public
as $$
declare v_job public.platform_rinkel_jobs%rowtype; v_status text;
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then raise exception 'service_role_required'; end if;
  select * into v_job from public.platform_rinkel_jobs
  where id=p_job_id and status='processing' and locked_by=p_worker_id
  for update;
  if not found then raise exception 'worker_job_lease_not_owned'; end if;

  if p_succeeded then
    v_status:='completed';
  elsif v_job.attempts >= v_job.max_attempts then
    v_status:='dead_letter';
  else
    v_status:='failed';
  end if;

  update public.platform_rinkel_jobs
  set status=v_status,
      available_at=case when v_status='failed' then coalesce(p_retry_at,now()+interval '1 minute') else available_at end,
      completed_at=case when v_status='completed' then now() else null end,
      dead_lettered_at=case when v_status='dead_letter' then now() else null end,
      locked_at=null,
      locked_by=null,
      last_error=case when p_succeeded then null else left(coalesce(p_error_message,p_error_code,'unknown_error'),500) end,
      last_error_code=case when p_succeeded then null else left(p_error_code,100) end,
      last_error_message=case when p_succeeded then null else left(p_error_message,500) end,
      updated_at=now()
  where id=p_job_id;
  return v_status;
end $$;
revoke all on function public.finish_platform_rinkel_job(uuid,text,boolean,text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.finish_platform_rinkel_job(uuid,text,boolean,text,text,timestamptz) to service_role;

create or replace function public.record_platform_worker_heartbeat(
  p_worker_key text,
  p_worker_id text,
  p_status text,
  p_started_at timestamptz,
  p_finished_at timestamptz,
  p_fetched_count integer,
  p_processed_count integer,
  p_failed_count integer,
  p_requeued_count integer,
  p_error_code text default null,
  p_error_message text default null,
  p_metadata jsonb default '{}'::jsonb
) returns void
language plpgsql
security definer
set search_path=public
as $$
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then raise exception 'service_role_required'; end if;
  insert into public.platform_worker_heartbeats(
    worker_key,worker_id,status,started_at,finished_at,last_success_at,
    fetched_count,processed_count,failed_count,requeued_count,
    last_error_code,last_error_message,metadata,updated_at
  ) values(
    p_worker_key,left(p_worker_id,200),p_status,p_started_at,p_finished_at,
    case when p_status='healthy' then p_finished_at else null end,
    greatest(coalesce(p_fetched_count,0),0),greatest(coalesce(p_processed_count,0),0),
    greatest(coalesce(p_failed_count,0),0),greatest(coalesce(p_requeued_count,0),0),
    left(p_error_code,100),left(p_error_message,500),coalesce(p_metadata,'{}'::jsonb),now()
  )
  on conflict(worker_key) do update set
    worker_id=excluded.worker_id,status=excluded.status,started_at=excluded.started_at,
    finished_at=excluded.finished_at,
    last_success_at=coalesce(excluded.last_success_at,public.platform_worker_heartbeats.last_success_at),
    fetched_count=excluded.fetched_count,processed_count=excluded.processed_count,
    failed_count=excluded.failed_count,requeued_count=excluded.requeued_count,
    last_error_code=excluded.last_error_code,last_error_message=excluded.last_error_message,
    metadata=excluded.metadata,updated_at=now();
end $$;
revoke all on function public.record_platform_worker_heartbeat(text,text,text,timestamptz,timestamptz,integer,integer,integer,integer,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.record_platform_worker_heartbeat(text,text,text,timestamptz,timestamptz,integer,integer,integer,integer,text,text,jsonb) to service_role;

create or replace function public.requeue_platform_rinkel_job(p_job_id uuid,p_reason text)
returns void
language plpgsql
security definer
set search_path=public
as $$
declare v_actor uuid:=auth.uid();
begin
  if v_actor is null or not public.is_platform_role(array['platform_owner'::public.platform_role,'platform_admin'::public.platform_role]) then raise exception 'platform_admin_required'; end if;
  update public.platform_rinkel_jobs
  set status='pending',available_at=now(),attempts=0,locked_at=null,locked_by=null,
      dead_lettered_at=null,last_error_code=null,last_error_message=null,last_error=null,completed_at=null,updated_at=now()
  where id=p_job_id and status in ('failed','dead_letter');
  if not found then raise exception 'rinkel_job_not_requeueable'; end if;
  insert into public.platform_audit_logs(actor_user_id,action,entity_type,entity_id,reason,metadata)
  values(v_actor,'rinkel.job_requeued','platform_rinkel_job',p_job_id::text,p_reason,'{}'::jsonb);
end $$;
revoke all on function public.requeue_platform_rinkel_job(uuid,text) from public,anon;
grant execute on function public.requeue_platform_rinkel_job(uuid,text) to authenticated;

-- Mapping with an explicit active device. The old v2 RPC remains for backward
-- compatibility but all current UI writes use v3.
create or replace function public.replace_rinkel_user_mapping_v3(
  p_kundexa_user_id uuid,
  p_rinkel_user_allocation_id uuid,
  p_default_number_allocation_id uuid,
  p_selected_device_id uuid
) returns uuid
language plpgsql
security definer
set search_path=public
as $$
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
    select 1
    from public.rinkel_user_allocations a
    join public.platform_rinkel_users u on u.id=a.rinkel_user_id and u.active
    join public.platform_rinkel_devices d on d.platform_rinkel_user_id=u.id and d.id=p_selected_device_id and d.active
    where a.id=p_rinkel_user_allocation_id and a.tenant_id=v_tenant and a.status='active' and a.valid_to is null
  ) then raise exception 'DEVICE_MISSING'; end if;
  if not exists(
    select 1 from public.rinkel_number_allocations a join public.platform_rinkel_numbers n on n.id=a.rinkel_number_id
    where a.id=p_default_number_allocation_id and a.tenant_id=v_tenant and a.status='active' and a.valid_to is null and n.active
  ) then raise exception 'NUMBER_ALLOCATION_MISSING'; end if;

  perform pg_advisory_xact_lock(hashtextextended(v_tenant::text||':rinkel-mapping:'||p_kundexa_user_id::text,0));
  update public.rinkel_user_mappings_v2 set active=false,updated_at=now()
    where active and ((tenant_id=v_tenant and kundexa_user_id=p_kundexa_user_id)
      or rinkel_user_allocation_id=p_rinkel_user_allocation_id);
  insert into public.rinkel_user_mappings_v2(
    tenant_id,kundexa_user_id,rinkel_user_allocation_id,default_number_allocation_id,selected_device_id,created_by
  ) values(v_tenant,p_kundexa_user_id,p_rinkel_user_allocation_id,p_default_number_allocation_id,p_selected_device_id,v_actor)
  returning id into v_id;
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
  values(v_tenant,v_actor,'rinkel.user_mapping_saved','rinkel_user_mapping',v_id::text,
    jsonb_build_object('kundexa_user_id',p_kundexa_user_id,'selected_device_id',p_selected_device_id));
  return v_id;
end $$;
revoke all on function public.replace_rinkel_user_mapping_v3(uuid,uuid,uuid,uuid) from public,anon;
grant execute on function public.replace_rinkel_user_mapping_v3(uuid,uuid,uuid,uuid) to authenticated;

create or replace function public.resolve_rinkel_caller_id(
  p_tenant_id uuid,
  p_user_id uuid,
  p_team_id uuid,
  p_list_id uuid,
  p_campaign_id uuid,
  p_explicit_number_allocation_id uuid,
  p_mapping_default_number_allocation_id uuid
) returns table(
  number_allocation_id uuid,
  rinkel_number_id uuid,
  provider_number_id text,
  phone_number_e164 text,
  allocation_source text,
  grant_id uuid
)
language sql
stable
security definer
set search_path=public
as $$
with requested(priority,source,allocation_id) as (
  select 1,'explicit',p_explicit_number_allocation_id where p_explicit_number_allocation_id is not null
  union all
  select 2,'list_default',l.rinkel_number_allocation_id
  from public.customer_lists l
  where l.tenant_id=p_tenant_id and l.id=p_list_id and l.rinkel_number_allocation_id is not null
  union all
  select 3,'campaign_default',c.rinkel_number_allocation_id
  from public.campaigns c
  where c.tenant_id=p_tenant_id and c.id=p_campaign_id and c.rinkel_number_allocation_id is not null
  union all
  select 4,'team_default',t.rinkel_number_allocation_id
  from public.teams t
  where t.tenant_id=p_tenant_id and t.id=p_team_id and t.rinkel_number_allocation_id is not null
  union all
  select 5,'tenant_default',p.default_number_allocation_id
  from public.telephony_policies p
  where p.tenant_id=p_tenant_id and p.default_number_allocation_id is not null
  union all
  select 6,'platform_default',a.id
  from public.rinkel_number_allocations a
  join public.platform_rinkel_numbers n on n.id=a.rinkel_number_id and n.is_platform_default and n.active
  where a.tenant_id=p_tenant_id and a.status='active' and a.valid_to is null
  union all
  select 7,'seller_default',p_mapping_default_number_allocation_id
  where p_mapping_default_number_allocation_id is not null
), valid as (
  select r.priority,r.source,a.id allocation_id,a.rinkel_number_id,
    n.external_number_id,n.phone_number_e164,
    (
      select g.id
      from public.rinkel_number_grants g
      where g.tenant_id=p_tenant_id and g.number_allocation_id=a.id and g.active
        and (
          g.user_id=p_user_id
          or g.team_id in(
            select tm.team_id from public.team_members tm
            where tm.tenant_id=p_tenant_id and tm.user_id=p_user_id
          )
          or (g.user_id is null and g.team_id is null)
        )
      order by
        case when g.user_id=p_user_id then 1 when g.team_id=p_team_id then 2 else 3 end,
        g.created_at,g.id
      limit 1
    ) access_grant_id
  from requested r
  join public.rinkel_number_allocations a on a.id=r.allocation_id
    and a.tenant_id=p_tenant_id and a.status='active' and a.valid_to is null
  join public.platform_rinkel_numbers n on n.id=a.rinkel_number_id and n.active
)
select v.allocation_id,v.rinkel_number_id,v.external_number_id,v.phone_number_e164,
  v.source,v.access_grant_id
from valid v
where v.access_grant_id is not null
order by v.priority,v.allocation_id
limit 1
$$;
revoke all on function public.resolve_rinkel_caller_id(uuid,uuid,uuid,uuid,uuid,uuid,uuid) from public,anon,authenticated;

create or replace function public.set_platform_rinkel_default_number(p_number_id uuid)
returns void
language plpgsql
security definer
set search_path=public
as $$
declare v_integration uuid;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'service_role_required'; end if;
  select n.platform_integration_id into v_integration
  from public.platform_rinkel_numbers n
  join public.platform_integrations pi on pi.id=n.platform_integration_id
    and pi.provider='rinkel' and pi.is_canonical
  where n.id=p_number_id and n.active;
  if v_integration is null then raise exception 'active_canonical_rinkel_number_required'; end if;
  update public.platform_rinkel_numbers set is_platform_default=(id=p_number_id)
  where platform_integration_id=v_integration and (is_platform_default or id=p_number_id);
end $$;
revoke all on function public.set_platform_rinkel_default_number(uuid) from public,anon,authenticated;
grant execute on function public.set_platform_rinkel_default_number(uuid) to service_role;

create or replace function public.get_tenant_rinkel_resources()
returns jsonb
language sql
stable
security definer
set search_path=public
as $$
select jsonb_build_object(
  'users',coalesce((
    select jsonb_agg(jsonb_build_object(
      'allocationId',a.id,'userId',u.id,'displayName',u.display_name,'email',u.email,
      'hasDevice',exists(select 1 from public.platform_rinkel_devices d where d.platform_rinkel_user_id=u.id and d.active),
      'active',u.active,
      'devices',coalesce((select jsonb_agg(jsonb_build_object(
        'id',d.id,'providerDeviceId',d.provider_device_id,'displayName',d.display_name,
        'deviceType',d.device_type,'status',d.provider_status,'active',d.active,'lastSyncedAt',d.last_synced_at
      ) order by d.display_name nulls last,d.provider_device_id)
      from public.platform_rinkel_devices d where d.platform_rinkel_user_id=u.id),'[]'::jsonb)
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
      'numberAllocationId',m.default_number_allocation_id,'selectedDeviceId',m.selected_device_id,'active',m.active
    )) from public.rinkel_user_mappings_v2 m where m.tenant_id=public.current_tenant_id() and m.active
  ),'[]'::jsonb),
  'callerIdDefaults',jsonb_build_object(
    'tenantDefaultAllocationId',(select p.default_number_allocation_id from public.telephony_policies p where p.tenant_id=public.current_tenant_id()),
    'teams',coalesce((select jsonb_agg(jsonb_build_object(
      'id',t.id,'name',t.name,'numberAllocationId',t.rinkel_number_allocation_id
    ) order by t.name) from public.teams t where t.tenant_id=public.current_tenant_id()),'[]'::jsonb),
    'lists',coalesce((select jsonb_agg(jsonb_build_object(
      'id',l.id,'name',l.name,'numberAllocationId',l.rinkel_number_allocation_id
    ) order by l.name) from public.customer_lists l
      where l.tenant_id=public.current_tenant_id() and l.archived_at is null),'[]'::jsonb),
    'campaigns',coalesce((select jsonb_agg(jsonb_build_object(
      'id',c.id,'name',c.name,'numberAllocationId',c.rinkel_number_allocation_id
    ) order by c.name) from public.campaigns c
      where c.tenant_id=public.current_tenant_id() and c.status not in ('completed','archived')),'[]'::jsonb)
  ),
  'capabilities',coalesce((
    select jsonb_build_object(
      'recordingDetected',pc.recording_detected,
      'transcriptionSupported',pc.transcription_supported,
      'insightsSupported',pc.insights_supported,
      'noteSyncSupported',pc.note_sync_supported,
      'privateRecordingCopySupported',false
    )
    from public.platform_integrations pi
    join public.platform_rinkel_capabilities pc on pc.platform_integration_id=pi.id
    where pi.provider='rinkel' and pi.is_canonical
  ),'{}'::jsonb)
)
where public.current_tenant_id() is not null and public.is_tenant_member(public.current_tenant_id())
$$;
revoke all on function public.get_tenant_rinkel_resources() from public,anon;
grant execute on function public.get_tenant_rinkel_resources() to authenticated;

create or replace function public.get_current_user_rinkel_numbers()
returns jsonb
language sql
stable
security definer
set search_path=public
as $$
select coalesce(jsonb_agg(jsonb_build_object(
  'allocationId',a.id,
  'numberId',n.id,
  'providerNumberId',n.external_number_id,
  'number',n.phone_number_e164,
  'displayName',n.display_name,
  'recordingEnabled',n.recording_enabled
) order by n.phone_number_e164),'[]'::jsonb)
from public.rinkel_number_allocations a
join public.platform_rinkel_numbers n on n.id=a.rinkel_number_id and n.active
where a.tenant_id=public.current_tenant_id() and a.status='active' and a.valid_to is null
  and exists(
    select 1 from public.rinkel_number_grants g
    where g.tenant_id=a.tenant_id and g.number_allocation_id=a.id and g.active
      and (g.user_id=auth.uid()
        or g.team_id in(select tm.team_id from public.team_members tm where tm.tenant_id=a.tenant_id and tm.user_id=auth.uid())
        or (g.user_id is null and g.team_id is null))
  )
$$;
revoke all on function public.get_current_user_rinkel_numbers() from public,anon;
grant execute on function public.get_current_user_rinkel_numbers() to authenticated;

-- Readiness is configuration/verification based. A quiet account is not broken
-- merely because no live webhook was received during the last 24 hours.
create or replace function public.telephony_status_for_current_user()
returns jsonb
language plpgsql
stable
security definer
set search_path=public
as $$
declare
  v_tenant uuid:=public.current_tenant_id();
  v_user uuid:=auth.uid();
  v_platform record;
  v_policy public.telephony_policies%rowtype;
  v_mapping record;
  v_tenant_has_number boolean:=false;
  v_number_access boolean:=false;
  v_worker_healthy boolean:=false;
  v_api_verified boolean:=false;
  v_core_webhooks_verified boolean:=false;
  v_dial_configured boolean:=false;
  v_manual_ready boolean:=false;
  v_automatic_ready boolean:=false;
  v_blockers jsonb:='[]'::jsonb;
begin
  select pi.*,pc.api_access,pc.dial_configured,pc.core_webhooks_verified
  into v_platform
  from public.platform_integrations pi
  left join public.platform_rinkel_capabilities pc on pc.platform_integration_id=pi.id
  where pi.provider='rinkel' and pi.is_canonical
  limit 1;

  select * into v_policy from public.telephony_policies where tenant_id=v_tenant;
  select m.id,m.default_number_allocation_id,m.selected_device_id,d.active as device_active
  into v_mapping
  from public.rinkel_user_mappings_v2 m
  join public.rinkel_user_allocations ua on ua.id=m.rinkel_user_allocation_id and ua.tenant_id=m.tenant_id and ua.status='active' and ua.valid_to is null
  left join public.platform_rinkel_devices d on d.id=m.selected_device_id and d.platform_rinkel_user_id=ua.rinkel_user_id
  where m.tenant_id=v_tenant and m.kundexa_user_id=v_user and m.active;

  select exists(select 1 from public.rinkel_number_allocations a where a.tenant_id=v_tenant and a.status='active' and a.valid_to is null)
  into v_tenant_has_number;
  select exists(
    select 1
    from public.rinkel_number_allocations a
    join public.platform_rinkel_numbers n on n.id=a.rinkel_number_id and n.active
    join public.rinkel_number_grants g on g.tenant_id=a.tenant_id
      and g.number_allocation_id=a.id and g.active
    where a.tenant_id=v_tenant and a.status='active' and a.valid_to is null
      and (g.user_id=v_user
        or g.team_id in(select team_id from public.team_members where tenant_id=v_tenant and user_id=v_user)
        or (g.user_id is null and g.team_id is null))
  ) into v_number_access;
  select coalesce(last_success_at > now()-interval '3 minutes',false)
  into v_worker_healthy from public.platform_worker_heartbeats where worker_key='rinkel-platform-worker';

  v_api_verified:=coalesce(v_platform.api_access,false) and v_platform.status in ('connected','degraded');
  v_core_webhooks_verified:=coalesce(v_platform.core_webhooks_verified,false) and v_platform.webhook_status='verified';
  v_dial_configured:=coalesce(v_platform.dial_configured,false);

  if v_platform.id is null then v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object('code','RINKEL_PLATFORM_NOT_CONFIGURED','message','Den centrala Rinkel-integrationen saknas.')); end if;
  if v_platform.id is not null and not v_api_verified then v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object('code','RINKEL_API_NOT_VERIFIED','message','Rinkel API är inte verifierat.')); end if;
  if not coalesce(v_policy.telephony_enabled,false) then v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object('code','TELEPHONY_DISABLED','message','Telefoni är avstängd för företaget.')); end if;
  if coalesce(v_policy.telephony_enabled,false) and not coalesce(v_policy.manual_dialer_enabled,false) then v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object('code','MANUAL_DIALER_DISABLED','message','Manuell dialer är avstängd för företaget.')); end if;
  if not v_tenant_has_number then v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object('code','NUMBER_ALLOCATION_MISSING','message','Företaget saknar ett tilldelat Rinkel-nummer.')); end if;
  if v_mapping.id is null then v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object('code','USER_MAPPING_MISSING','message','Du saknar en Rinkel-användarmappning.')); end if;
  if v_mapping.id is not null and (v_mapping.selected_device_id is null or not coalesce(v_mapping.device_active,false)) then v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object('code','DEVICE_MISSING','message','Din Rinkel-användare saknar en aktiv vald enhet.')); end if;
  if not v_dial_configured then v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object('code','DIAL_CONFIGURATION_INCOMPLETE','message','Rinkel saknar en komplett aktiv användar-, enhets- eller nummerkonfiguration.')); end if;
  if v_mapping.id is not null and not v_number_access then v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object('code','DIAL_PERMISSION_DENIED','message','Du saknar åtkomst till ett aktivt utgående Rinkel-nummer.')); end if;
  if coalesce(v_policy.automatic_dialer_enabled,false) and not v_core_webhooks_verified then v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object('code','CORE_WEBHOOKS_NOT_VERIFIED','message','Auto-dialer kräver fyra verifierade kärnwebhookar.')); end if;
  if coalesce(v_policy.automatic_dialer_enabled,false) and not v_worker_healthy then v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object('code','RINKEL_WORKER_UNHEALTHY','message','Auto-dialer kräver en nyligen lyckad worker-körning.')); end if;

  v_manual_ready:=v_api_verified and v_dial_configured and coalesce(v_policy.telephony_enabled,false)
    and coalesce(v_policy.manual_dialer_enabled,false) and v_tenant_has_number and v_mapping.id is not null
    and v_mapping.selected_device_id is not null and coalesce(v_mapping.device_active,false) and v_number_access;
  v_automatic_ready:=v_manual_ready and coalesce(v_policy.automatic_dialer_enabled,false)
    and v_core_webhooks_verified and v_worker_healthy;

  return jsonb_build_object(
    'platformConfigured',v_platform.id is not null,
    'apiVerified',v_api_verified,
    'coreWebhooksVerified',v_core_webhooks_verified,
    'workerHealthy',v_worker_healthy,
    'tenantEnabled',coalesce(v_policy.telephony_enabled,false),
    'tenantHasNumber',v_tenant_has_number,
    'userMapped',v_mapping.id is not null,
    'userHasActiveDevice',v_mapping.selected_device_id is not null and coalesce(v_mapping.device_active,false),
    'userHasDevice',v_mapping.selected_device_id is not null and coalesce(v_mapping.device_active,false),
    'userHasNumberAccess',v_number_access,
    'manualReady',v_manual_ready,
    'automaticReady',v_automatic_ready,
    'webhookReady',v_core_webhooks_verified,
    'platformReady',v_api_verified and v_dial_configured,
    'status',coalesce(v_platform.status,'not_configured'),
    'errorCode',case when jsonb_array_length(v_blockers)>0 then v_blockers->0->>'code' else null end,
    'errorMessage',case when jsonb_array_length(v_blockers)>0 then v_blockers->0->>'message' else null end,
    'blockers',v_blockers
  );
end $$;
revoke all on function public.telephony_status_for_current_user() from public,anon;
grant execute on function public.telephony_status_for_current_user() to authenticated;


-- Replace the old reservation function to remove the false 24-hour traffic gate,
-- require an explicit active device and return truthful idempotent replay state.
create or replace function public.rinkel_reserve_platform_outbound_call_v2(
  p_customer_id uuid,
  p_contact_person_id uuid,
  p_target_phone text,
  p_session_id uuid,
  p_list_member_id uuid,
  p_callback_activity_id uuid,
  p_client_request_id uuid,
  p_idempotency_key text,
  p_purpose text default 'direct_marketing',
  p_number_allocation_id uuid default null
) returns jsonb
language plpgsql security definer set search_path=public as $$
declare
  v_tenant uuid:=public.current_tenant_id();
  v_user uuid:=auth.uid();
  v_customer public.customers%rowtype;
  v_contact public.contact_people%rowtype;
  v_policy public.telephony_policies%rowtype;
  v_mapping record;
  v_caller record;
  v_existing record;
  v_existing_count integer:=0;
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

  select count(distinct a.id) into v_existing_count
  from public.rinkel_call_attempts_v2 a
  where a.tenant_id=v_tenant and (a.client_request_id=p_client_request_id or a.idempotency_key=p_idempotency_key);
  if v_existing_count>1 then raise exception 'idempotency_identity_conflict'; end if;

  select c.id call_id,a.id attempt_id,a.status attempt_status,c.status call_status,c.provider_status into v_existing
  from public.calls c join public.rinkel_call_attempts_v2 a on a.tenant_id=c.tenant_id and a.call_id=c.id
  where c.tenant_id=v_tenant and (a.client_request_id=p_client_request_id or a.idempotency_key=p_idempotency_key)
  order by a.requested_at desc,a.id
  limit 1;
  if found then
    return jsonb_build_object('callId',v_existing.call_id,'attemptId',v_existing.attempt_id,
      'status',v_existing.call_status,'attemptStatus',v_existing.attempt_status,
      'providerStatus',coalesce(v_existing.provider_status,'unknown'),
      'callActive',v_existing.attempt_status in (
        'requested','dial_requested','awaiting_provider_event','matched',
        'provider_outcome_unknown','reconciliation_required'
      ),
      'message',case
        when v_existing.attempt_status='failed' then 'Det tidigare samtalsförsöket misslyckades.'
        when v_existing.attempt_status in ('provider_outcome_unknown','reconciliation_required')
          then 'Det tidigare samtalsförsökets providerutfall är ännu okänt.'
        when v_existing.attempt_status='completed' or v_existing.call_status in ('completed','failed','cancelled','blocked','unanswered')
          then 'Det tidigare samtalsförsöket är redan avslutat.'
        else 'Det befintliga samtalsförsöket återanvänds.' end,
      'idempotentReplay',true);
  end if;

  if not exists(select 1 from public.tenants where id=v_tenant and status in ('trial','active')) then raise exception 'tenant_not_active'; end if;
  if not exists(select 1 from public.tenant_features where tenant_id=v_tenant and feature_key='outbound_calls' and enabled)
    then raise exception 'outbound_calls_feature_disabled'; end if;
  select * into v_policy from public.telephony_policies where tenant_id=v_tenant;
  if not found or not v_policy.telephony_enabled then raise exception 'TELEPHONY_DISABLED'; end if;
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

  if v_is_automatic then
    if not v_policy.automatic_dialer_enabled then raise exception 'automatic_dialer_disabled'; end if;
  elsif not v_policy.manual_dialer_enabled then
    raise exception 'manual_dialer_disabled';
  end if;

  select m.id mapping_id,m.rinkel_user_allocation_id,m.default_number_allocation_id,
    pi.id platform_integration_id,pi.status integration_status,
    coalesce(pc.api_access,false) api_access,coalesce(pc.dial_configured,false) dial_configured,
    pu.id rinkel_user_id,pu.external_user_id,
    d.id selected_device_id,d.provider_device_id external_device_id
  into v_mapping
  from public.rinkel_user_mappings_v2 m
  join public.rinkel_user_allocations ua on ua.id=m.rinkel_user_allocation_id
    and ua.tenant_id=m.tenant_id and ua.status='active' and ua.valid_to is null
  join public.platform_rinkel_users pu on pu.id=ua.rinkel_user_id and pu.active
  join public.platform_rinkel_devices d on d.id=m.selected_device_id and d.platform_rinkel_user_id=pu.id and d.active
  join public.platform_integrations pi on pi.id=pu.platform_integration_id
    and pi.provider='rinkel' and pi.is_canonical and pi.disabled_at is null
  left join public.platform_rinkel_capabilities pc on pc.platform_integration_id=pi.id
  where m.tenant_id=v_tenant and m.kundexa_user_id=v_user and m.active;
  if not found then raise exception 'USER_MAPPING_MISSING'; end if;
  if v_mapping.integration_status not in ('connected','degraded') or not v_mapping.api_access
    then raise exception 'RINKEL_API_NOT_VERIFIED'; end if;
  if not v_mapping.dial_configured then raise exception 'DIAL_CONFIGURATION_INCOMPLETE'; end if;

  select * into v_caller
  from public.resolve_rinkel_caller_id(
    v_tenant,v_user,v_customer.assigned_team_id,v_list_id,v_customer.campaign_id,
    p_number_allocation_id,v_mapping.default_number_allocation_id
  );
  if not found then
    if p_number_allocation_id is not null then raise exception 'DIAL_PERMISSION_DENIED'; end if;
    raise exception 'NUMBER_ALLOCATION_MISSING';
  end if;
  if p_number_allocation_id is not null and v_caller.number_allocation_id<>p_number_allocation_id
    then raise exception 'DIAL_PERMISSION_DENIED'; end if;
  if v_is_automatic and not exists(
    select 1
    from public.platform_integrations pi
    join public.platform_rinkel_capabilities pc on pc.platform_integration_id=pi.id
    where pi.id=v_mapping.platform_integration_id
      and pi.webhook_status='verified'
      and pc.core_webhooks_verified
      and exists(
        select 1 from public.platform_worker_heartbeats h
        where h.worker_key='rinkel-platform-worker'
          and h.last_success_at>now()-interval '3 minutes'
      )
  ) then raise exception 'RINKEL_AUTODIALER_NOT_READY'; end if;

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
    v_caller.phone_number_e164,p_target_phone,'requested',v_mapping.external_user_id,v_mapping.external_device_id,
    v_policy.recording_enabled,case when v_policy.recording_enabled then 'pending' else 'not_expected' end,
    case when v_policy.transcription_enabled then 'pending' else 'disabled' end,
    case when v_policy.ai_analysis_enabled then 'pending' else 'disabled' end,
    p_idempotency_key,p_purpose,v_list_id,p_list_member_id,p_session_id,p_callback_activity_id,
    encode(digest(p_idempotency_key,'sha256'),'hex'),
    jsonb_build_object(
      'platform_integration_id',v_mapping.platform_integration_id,
      'mapping_id',v_mapping.mapping_id,'user_allocation_id',v_mapping.rinkel_user_allocation_id,
      'number_allocation_id',v_caller.number_allocation_id,
      'caller_id_source',v_caller.allocation_source,
      'rinkel_user_id',v_mapping.rinkel_user_id,'rinkel_number_id',v_caller.rinkel_number_id,
      'external_rinkel_user_id',v_mapping.external_user_id,
      'external_rinkel_number_id',v_caller.provider_number_id
    )
  ) returning id into v_call;

  insert into public.rinkel_call_attempts_v2(
    tenant_id,call_id,seller_user_id,platform_integration_id,mapping_id,user_allocation_id,number_allocation_id,
    rinkel_user_id,rinkel_number_id,external_rinkel_user_id,external_rinkel_number_id,rinkel_device_id,
    selected_device_id,caller_id_source,caller_id_allocation_id,source_number_e164,destination_number_e164,client_request_id,idempotency_key
  ) values(
    v_tenant,v_call,v_user,v_mapping.platform_integration_id,v_mapping.mapping_id,
    v_mapping.rinkel_user_allocation_id,v_caller.number_allocation_id,
    v_mapping.rinkel_user_id,v_caller.rinkel_number_id,v_mapping.external_user_id,
    v_caller.provider_number_id,v_mapping.external_device_id,
    v_mapping.selected_device_id,v_caller.allocation_source,v_caller.number_allocation_id,v_caller.phone_number_e164,
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
    'numberId',v_caller.provider_number_id,'to',p_target_phone,'status','requested',
    'attemptStatus','requested','providerStatus','requesting','callerIdSource',v_caller.allocation_source,
    'callerIdAllocationId',v_caller.number_allocation_id,'idempotentReplay',false
  );
end $$;
revoke all on function public.rinkel_reserve_platform_outbound_call_v2(uuid,uuid,text,uuid,uuid,uuid,uuid,text,text,uuid) from public,anon;
grant execute on function public.rinkel_reserve_platform_outbound_call_v2(uuid,uuid,text,uuid,uuid,uuid,uuid,text,text,uuid) to authenticated;

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
language sql
security definer
set search_path=public
as $$
  select public.rinkel_reserve_platform_outbound_call_v2(
    p_customer_id,p_contact_person_id,p_target_phone,p_session_id,p_list_member_id,
    p_callback_activity_id,p_client_request_id,p_idempotency_key,p_purpose,null
  )
$$;
revoke all on function public.rinkel_reserve_platform_outbound_call(uuid,uuid,text,uuid,uuid,uuid,uuid,text,text) from public,anon;
grant execute on function public.rinkel_reserve_platform_outbound_call(uuid,uuid,text,uuid,uuid,uuid,uuid,text,text) to authenticated;

alter table public.platform_rinkel_devices enable row level security;
alter table public.platform_worker_heartbeats enable row level security;
revoke all on public.platform_rinkel_devices,public.platform_worker_heartbeats from public,anon,authenticated;
grant all on public.platform_rinkel_devices,public.platform_worker_heartbeats to service_role;

create or replace function public.set_platform_rinkel_job_defaults()
returns trigger
language plpgsql
set search_path=public
as $$
declare
  v_event_type text;
begin
  -- Canonicalize legacy enrichment jobs without creating a second worker path.
  if new.job_type='rinkel.enrich_call' then
    new.job_type:='rinkel.transcription.fetch';
    new.idempotency_key:=replace(new.idempotency_key,'rinkel.enrich_call','rinkel.transcription.fetch');
  end if;
  -- Insights arrive through the optional webhook and use an explicit processing job.
  if new.job_type='rinkel.process_event' and new.aggregate_id is not null then
    select event_type into v_event_type
    from public.platform_rinkel_webhook_events
    where id=new.aggregate_id;
    if v_event_type='callInsights' then
      new.job_type:='rinkel.insights.process';
      new.idempotency_key:=replace(new.idempotency_key,'rinkel.process_event','rinkel.insights.process');
    end if;
  end if;
  if new.job_type='rinkel.transcription.fetch' and new.max_attempts=10 then
    new.max_attempts:=96;
  elsif new.job_type='rinkel.insights.process' and new.max_attempts=10 then
    new.max_attempts:=20;
  end if;
  return new;
end $$;
revoke all on function public.set_platform_rinkel_job_defaults() from public,anon,authenticated;

update public.platform_rinkel_jobs
set job_type='rinkel.transcription.fetch',
    idempotency_key=replace(idempotency_key,'rinkel.enrich_call','rinkel.transcription.fetch'),
    max_attempts=greatest(max_attempts,96)
where job_type='rinkel.enrich_call'
  and not exists(
    select 1 from public.platform_rinkel_jobs existing
    where existing.id<>platform_rinkel_jobs.id
      and existing.idempotency_key=replace(platform_rinkel_jobs.idempotency_key,'rinkel.enrich_call','rinkel.transcription.fetch')
  );

drop trigger if exists platform_rinkel_jobs_defaults on public.platform_rinkel_jobs;
create trigger platform_rinkel_jobs_defaults before insert or update of job_type,idempotency_key on public.platform_rinkel_jobs
for each row execute function public.set_platform_rinkel_job_defaults();

drop trigger if exists platform_rinkel_devices_touch on public.platform_rinkel_devices;
create trigger platform_rinkel_devices_touch before update on public.platform_rinkel_devices
for each row execute function public.touch_updated_at();

drop trigger if exists platform_rinkel_jobs_touch on public.platform_rinkel_jobs;
create trigger platform_rinkel_jobs_touch before update on public.platform_rinkel_jobs
for each row execute function public.touch_updated_at();

drop trigger if exists platform_worker_heartbeats_touch on public.platform_worker_heartbeats;
create trigger platform_worker_heartbeats_touch before update on public.platform_worker_heartbeats
for each row execute function public.touch_updated_at();

commit;
