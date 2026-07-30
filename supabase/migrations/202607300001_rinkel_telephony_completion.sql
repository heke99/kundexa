begin;

-- Rinkel is a tenant-owned telephony provider. Existing calls, call_events and
-- call_recordings remain canonical; this migration adds provider lifecycle,
-- correlation and enrichment data without creating a second CRM call model.

alter table public.tenant_integrations
  add column if not exists public_id uuid not null default gen_random_uuid(),
  add column if not exists api_key_last_four text,
  add column if not exists webhook_secret_hash text,
  add column if not exists webhook_status text not null default 'not_configured',
  add column if not exists webhook_last_received_at timestamptz,
  add column if not exists last_connection_test_at timestamptz,
  add column if not exists last_successful_sync_at timestamptz,
  add column if not exists last_reconciled_at timestamptz,
  add column if not exists last_failed_sync_at timestamptz,
  add column if not exists last_error_code text,
  add column if not exists last_error_message text,
  add column if not exists disabled_at timestamptz;

create unique index if not exists tenant_integrations_public_id_uidx
  on public.tenant_integrations(public_id);
create unique index if not exists tenant_integrations_one_live_rinkel_uidx
  on public.tenant_integrations(tenant_id)
  where provider='rinkel' and disabled_at is null and status <> 'disabled';

alter table public.tenant_integrations drop constraint if exists tenant_integrations_status_check;
alter table public.tenant_integrations add constraint tenant_integrations_status_check check (
  status in (
    'inactive','pending','active','error','revoked',
    'not_configured','testing','connected','authentication_failed',
    'plan_unsupported','degraded','disabled','unknown_error'
  )
);
alter table public.tenant_integrations drop constraint if exists tenant_integrations_webhook_status_check;
alter table public.tenant_integrations add constraint tenant_integrations_webhook_status_check check (
  webhook_status in ('not_configured','pending','active','degraded','disabled','error')
);

create table public.rinkel_users (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  connection_id uuid not null,
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
  unique(tenant_id,id),
  unique(connection_id,external_user_id),
  foreign key(tenant_id,connection_id) references public.tenant_integrations(tenant_id,id) on delete cascade
);

create table public.rinkel_numbers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  connection_id uuid not null,
  phone_number_id uuid,
  external_number_id text not null,
  phone_number_e164 text not null,
  display_name text,
  country_code text,
  active boolean not null default true,
  recording_enabled boolean not null default false,
  raw_provider_data jsonb not null default '{}'::jsonb,
  last_synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(tenant_id,id),
  unique(connection_id,external_number_id),
  foreign key(tenant_id,connection_id) references public.tenant_integrations(tenant_id,id) on delete cascade,
  foreign key(tenant_id,phone_number_id) references public.phone_numbers(tenant_id,id) on delete set null
);

create table public.rinkel_user_mappings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  connection_id uuid not null,
  kundexa_user_id uuid not null,
  rinkel_user_id uuid not null,
  default_number_id uuid not null,
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(tenant_id,id),
  foreign key(tenant_id,connection_id) references public.tenant_integrations(tenant_id,id) on delete cascade,
  foreign key(tenant_id,kundexa_user_id) references public.tenant_memberships(tenant_id,user_id) on delete cascade,
  foreign key(tenant_id,rinkel_user_id) references public.rinkel_users(tenant_id,id) on delete restrict,
  foreign key(tenant_id,default_number_id) references public.rinkel_numbers(tenant_id,id) on delete restrict
);
create unique index rinkel_user_mappings_user_uidx
  on public.rinkel_user_mappings(tenant_id,kundexa_user_id) where active;
create unique index rinkel_user_mappings_provider_user_uidx
  on public.rinkel_user_mappings(connection_id,rinkel_user_id) where active;

create table public.telephony_policies (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  recording_enabled boolean not null default false,
  recording_storage_mode text not null default 'provider_only'
    check(recording_storage_mode in ('provider_only','kundexa_private_copy')),
  recording_retention_days integer not null default 90 check(recording_retention_days between 1 and 3650),
  raw_event_retention_days integer not null default 30 check(raw_event_retention_days between 1 and 365),
  allow_seller_playback boolean not null default false,
  allow_team_leader_playback boolean not null default false,
  allow_tenant_admin_playback boolean not null default true,
  transcription_enabled boolean not null default false,
  ai_analysis_enabled boolean not null default false,
  sync_notes_to_rinkel boolean not null default false,
  disposition_required boolean not null default true,
  allowed_days integer[] not null default '{1,2,3,4,5}',
  allowed_start_time time not null default '09:00',
  allowed_end_time time not null default '18:00',
  timezone text not null default 'Europe/Stockholm',
  delete_provider_recording_on_retention boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.telephony_policies(tenant_id,timezone)
select id,coalesce(timezone,'Europe/Stockholm') from public.tenants
on conflict (tenant_id) do nothing;

create or replace function public.seed_telephony_policy()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  insert into public.telephony_policies(tenant_id,timezone)
  values(new.id,coalesce(new.timezone,'Europe/Stockholm'))
  on conflict (tenant_id) do nothing;
  return new;
end
$$;
drop trigger if exists tenants_seed_telephony_policy on public.tenants;
create trigger tenants_seed_telephony_policy after insert on public.tenants
  for each row execute function public.seed_telephony_policy();

create table public.rinkel_capabilities (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  connection_id uuid not null,
  api_access boolean not null default false,
  dial boolean not null default false,
  webhooks boolean not null default false,
  recordings boolean not null default false,
  transcription boolean not null default false,
  ai_insights boolean not null default false,
  detected_at timestamptz not null default now(),
  details jsonb not null default '{}'::jsonb,
  primary key(connection_id),
  foreign key(tenant_id,connection_id) references public.tenant_integrations(tenant_id,id) on delete cascade
);

create table public.rinkel_webhook_subscriptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  connection_id uuid not null,
  event_type text not null check(event_type in ('incomingCall','outgoingCall','callStart','callEnd','callInsights')),
  target_url_hash text not null,
  status text not null default 'pending' check(status in ('pending','active','disabled','error','unsupported')),
  last_verified_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(connection_id,event_type),
  unique(tenant_id,id),
  foreign key(tenant_id,connection_id) references public.tenant_integrations(tenant_id,id) on delete cascade
);

alter table public.calls
  add column if not exists provider text not null default '46elks',
  add column if not exists provider_connection_id uuid,
  add column if not exists external_call_id text,
  add column if not exists end_cause text,
  add column if not exists team_id uuid,
  add column if not exists answered_by_user_id uuid references auth.users(id) on delete set null,
  add column if not exists provider_user_id text,
  add column if not exists provider_device_id text,
  add column if not exists ring_duration_seconds integer,
  add column if not exists recording_status text not null default 'not_expected',
  add column if not exists transcription_status text not null default 'disabled',
  add column if not exists insights_status text not null default 'disabled',
  add column if not exists follow_up_required boolean not null default false,
  add column if not exists follow_up_at timestamptz,
  add column if not exists initiated_at timestamptz;

do $$ begin
  alter table public.calls add constraint calls_provider_connection_tenant_fk
    foreign key(tenant_id,provider_connection_id) references public.tenant_integrations(tenant_id,id) on delete restrict;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.calls add constraint calls_team_tenant_fk
    foreign key(tenant_id,team_id) references public.teams(tenant_id,id) on delete set null;
exception when duplicate_object then null; end $$;
alter table public.calls drop constraint if exists calls_status_check;
alter table public.calls add constraint calls_status_check check(status in (
  'queued','initiating','ringing','answered','busy','no_answer',
  'requested','dial_requested','awaiting_provider_event','initiated','in_progress',
  'completed','unanswered','failed','blocked','voicemail','outside_business_hours',
  'provider_outcome_unknown','reconciliation_required','cancelled'
));
alter table public.calls drop constraint if exists calls_recording_status_check;
alter table public.calls add constraint calls_recording_status_check check(recording_status in (
  'not_expected','pending','available_at_provider','copy_pending','stored_privately','unavailable','deleted','failed'
));
alter table public.calls drop constraint if exists calls_transcription_status_check;
alter table public.calls add constraint calls_transcription_status_check check(transcription_status in (
  'disabled','pending','processing','available','not_available','failed','deleted'
));
alter table public.calls drop constraint if exists calls_insights_status_check;
alter table public.calls add constraint calls_insights_status_check check(insights_status in (
  'disabled','pending','processing','available','not_available','failed','deleted'
));
create unique index if not exists calls_provider_external_uidx
  on public.calls(provider_connection_id,external_call_id)
  where provider_connection_id is not null and external_call_id is not null;
create index if not exists calls_tenant_seller_time_idx on public.calls(tenant_id,user_id,created_at desc);
create index if not exists calls_tenant_team_time_idx on public.calls(tenant_id,team_id,created_at desc);
create index if not exists calls_tenant_status_time_idx on public.calls(tenant_id,status,created_at desc);
create index if not exists calls_tenant_direction_time_idx on public.calls(tenant_id,direction,created_at desc);
create index if not exists calls_tenant_external_idx on public.calls(tenant_id,external_call_id);
create index if not exists calls_tenant_from_idx on public.calls(tenant_id,from_number);
create index if not exists calls_tenant_to_idx on public.calls(tenant_id,to_number);

create table public.call_attempts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  connection_id uuid not null,
  call_id uuid not null,
  seller_user_id uuid not null,
  rinkel_user_id uuid not null,
  rinkel_number_id uuid not null,
  rinkel_device_id text not null,
  destination_number_e164 text not null,
  source_number_e164 text not null,
  client_request_id uuid not null,
  idempotency_key text not null,
  status text not null default 'requested' check(status in (
    'requested','dial_requested','awaiting_provider_event','matched','failed',
    'provider_outcome_unknown','reconciliation_required','completed','expired'
  )),
  requested_at timestamptz not null default now(),
  provider_request_started_at timestamptz,
  provider_request_finished_at timestamptz,
  matched_at timestamptz,
  external_call_id text,
  error_code text,
  error_message text,
  expires_at timestamptz not null default now()+interval '15 minutes',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(tenant_id,id),
  unique(tenant_id,client_request_id),
  unique(tenant_id,idempotency_key),
  foreign key(tenant_id,connection_id) references public.tenant_integrations(tenant_id,id) on delete restrict,
  foreign key(tenant_id,call_id) references public.calls(tenant_id,id) on delete cascade,
  foreign key(tenant_id,seller_user_id) references public.tenant_memberships(tenant_id,user_id) on delete restrict,
  foreign key(tenant_id,rinkel_user_id) references public.rinkel_users(tenant_id,id) on delete restrict,
  foreign key(tenant_id,rinkel_number_id) references public.rinkel_numbers(tenant_id,id) on delete restrict
);
create unique index call_attempts_one_active_user_uidx
  on public.call_attempts(tenant_id,seller_user_id)
  where status in ('requested','dial_requested','awaiting_provider_event','matched','provider_outcome_unknown','reconciliation_required');
create unique index call_attempts_one_active_device_uidx
  on public.call_attempts(connection_id,rinkel_device_id)
  where status in ('requested','dial_requested','awaiting_provider_event','matched','provider_outcome_unknown','reconciliation_required');
create index call_attempts_correlation_idx
  on public.call_attempts(connection_id,destination_number_e164,source_number_e164,requested_at desc)
  where status in ('requested','dial_requested','awaiting_provider_event','provider_outcome_unknown');

alter table public.call_events
  add column if not exists connection_id uuid,
  add column if not exists external_call_id text,
  add column if not exists payload_hash text,
  add column if not exists processing_status text not null default 'processed',
  add column if not exists processing_attempts integer not null default 0,
  add column if not exists processed_at timestamptz,
  add column if not exists last_processing_error text,
  add column if not exists created_at timestamptz not null default now();
create unique index if not exists call_events_rinkel_idempotency_uidx
  on public.call_events(connection_id,external_call_id,event_type,occurred_at,payload_hash)
  where connection_id is not null and external_call_id is not null and payload_hash is not null;

alter table public.provider_webhook_events
  add column if not exists connection_id uuid,
  add column if not exists payload_hash text,
  add column if not exists content_type text,
  add column if not exists source_ip inet,
  add column if not exists processing_started_at timestamptz,
  add column if not exists dead_lettered_at timestamptz;
create index if not exists provider_webhook_events_rinkel_queue_idx
  on public.provider_webhook_events(provider,status,received_at)
  where provider='rinkel' and status in ('received','failed');

alter table public.call_recordings
  add column if not exists connection_id uuid,
  add column if not exists provider text not null default '46elks',
  add column if not exists provider_reference text,
  add column if not exists storage_mode text not null default 'provider_only',
  add column if not exists available_at timestamptz,
  add column if not exists last_checked_at timestamptz,
  add column if not exists expires_at timestamptz,
  add column if not exists retention_delete_at timestamptz,
  add column if not exists deleted_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();
alter table public.call_recordings drop constraint if exists call_recordings_storage_mode_check;
alter table public.call_recordings add constraint call_recordings_storage_mode_check
  check(storage_mode in ('provider_only','kundexa_private_copy'));
do $$ begin
  alter table public.call_recordings add constraint call_recordings_connection_tenant_fk
    foreign key(tenant_id,connection_id) references public.tenant_integrations(tenant_id,id) on delete restrict;
exception when duplicate_object then null; end $$;

create table public.call_transcripts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  call_id uuid not null,
  provider text not null,
  language text,
  status text not null default 'pending' check(status in (
    'disabled','pending','processing','available','not_available','failed','deleted'
  )),
  raw_transcript text,
  structured_transcript jsonb,
  provider_payload jsonb not null default '{}'::jsonb,
  generated_at timestamptz,
  last_checked_at timestamptz,
  retry_count integer not null default 0,
  next_retry_at timestamptz,
  retention_delete_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(tenant_id,id),
  unique(call_id,provider),
  foreign key(tenant_id,call_id) references public.calls(tenant_id,id) on delete cascade
);

create table public.call_insights (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  call_id uuid not null,
  source text not null check(source in ('rinkel','kundexa')),
  status text not null default 'pending' check(status in ('pending','processing','available','failed','deleted')),
  sentiment text,
  topics text[] not null default '{}',
  summary text,
  analysis jsonb not null default '{}'::jsonb,
  generated_at timestamptz,
  retention_delete_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(tenant_id,id),
  unique(call_id,source),
  foreign key(tenant_id,call_id) references public.calls(tenant_id,id) on delete cascade
);

create table public.call_correlation_conflicts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  connection_id uuid not null,
  external_call_id text not null,
  event_id uuid,
  candidate_attempt_ids uuid[] not null default '{}',
  status text not null default 'open' check(status in ('open','resolved','ignored')),
  resolution text,
  resolved_by uuid references auth.users(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  unique(connection_id,external_call_id),
  foreign key(tenant_id,connection_id) references public.tenant_integrations(tenant_id,id) on delete restrict,
  foreign key(event_id) references public.provider_webhook_events(id) on delete set null
);

create or replace function public.rinkel_reserve_outbound_call(
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
  v_tenant_status text;
  v_customer public.customers%rowtype;
  v_contact public.contact_people%rowtype;
  v_mapping record;
  v_call uuid;
  v_attempt uuid;
  v_existing record;
  v_list public.customer_lists%rowtype;
  v_member public.customer_list_members%rowtype;
  v_session public.dialer_sessions%rowtype;
  v_local timestamp;
  v_dow integer;
  v_policy public.telephony_policies%rowtype;
  v_nix text;
begin
  if v_user is null or v_tenant is null then raise exception 'authentication_required'; end if;
  if not public.has_current_role(array['owner','admin','team_lead','sales']) then raise exception 'call_create_permission_required'; end if;
  if p_client_request_id is null or nullif(trim(p_idempotency_key),'') is null then raise exception 'idempotency_required'; end if;
  if p_target_phone !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'target_phone_invalid'; end if;

  select c.id call_id,a.id attempt_id,a.status attempt_status into v_existing
  from public.calls c join public.call_attempts a on a.tenant_id=c.tenant_id and a.call_id=c.id
  where c.tenant_id=v_tenant and (a.client_request_id=p_client_request_id or a.idempotency_key=p_idempotency_key)
  limit 1;
  if found then
    return jsonb_build_object(
      'callId',v_existing.call_id,'attemptId',v_existing.attempt_id,
      'status',v_existing.attempt_status,'idempotentReplay',true
    );
  end if;

  select status into v_tenant_status from public.tenants where id=v_tenant;
  if v_tenant_status not in ('trial','active') then raise exception 'tenant_not_active'; end if;
  if not exists(select 1 from public.tenant_features where tenant_id=v_tenant and feature_key='outbound_calls' and enabled) then
    raise exception 'outbound_calls_feature_disabled';
  end if;

  select * into v_policy from public.telephony_policies where tenant_id=v_tenant;
  if not found then raise exception 'telephony_policy_missing'; end if;
  v_local:=now() at time zone v_policy.timezone;
  v_dow:=extract(isodow from v_local);
  if not (v_dow=any(v_policy.allowed_days) and v_local::time>=v_policy.allowed_start_time and v_local::time<v_policy.allowed_end_time) then
    raise exception 'outside_allowed_calling_hours';
  end if;

  select * into v_customer from public.customers
  where tenant_id=v_tenant and id=p_customer_id and deleted_at is null for share;
  if not found then raise exception 'customer_not_found'; end if;
  if v_customer.do_not_call then raise exception 'customer_do_not_call'; end if;
  if p_contact_person_id is null then
    if p_target_phone is distinct from v_customer.phone_e164 and p_target_phone is distinct from v_customer.alternate_phone_e164 then
      raise exception 'target_phone_customer_mismatch';
    end if;
  else
    select * into v_contact from public.contact_people
      where tenant_id=v_tenant and id=p_contact_person_id and customer_id=p_customer_id;
    if not found then raise exception 'contact_person_not_found'; end if;
    if p_target_phone is distinct from v_contact.phone_e164 and p_target_phone is distinct from v_contact.alternate_phone_e164 then
      raise exception 'target_phone_contact_mismatch';
    end if;
  end if;
  if exists(
    select 1 from public.compliance_blocks b where b.tenant_id=v_tenant
      and (b.customer_id=p_customer_id or b.phone_e164=p_target_phone)
      and 'call'=any(b.channels) and b.active and (b.expires_at is null or b.expires_at>now())
  ) then raise exception 'contact_not_allowed'; end if;
  if p_purpose in ('direct_marketing','automation_marketing') then
    select result into v_nix from public.nix_checks
      where tenant_id=v_tenant and phone_e164=p_target_phone and valid_until>now()
      order by checked_at desc limit 1;
    if v_nix is null or v_nix in ('unknown','error') then raise exception 'target_nix_check_required'; end if;
    if v_nix<>'not_listed' then raise exception 'target_nix_%',v_nix; end if;
  end if;

  if p_session_id is not null or p_list_member_id is not null then
    if p_session_id is null or p_list_member_id is null then raise exception 'list_call_context_incomplete'; end if;
    select * into v_session from public.dialer_sessions
      where tenant_id=v_tenant and id=p_session_id and user_id=v_user and state in ('active','after_call') for update;
    if not found then raise exception 'dialer_session_not_active'; end if;
    select * into v_member from public.customer_list_members
      where tenant_id=v_tenant and id=p_list_member_id and list_id=v_session.list_id
        and customer_id=p_customer_id and claimed_by=v_user and claim_expires_at>now() for update;
    if not found then raise exception 'list_member_claim_expired'; end if;
    if p_callback_activity_id is distinct from v_session.current_callback_activity_id then raise exception 'callback_claim_mismatch'; end if;
    select * into v_list from public.customer_lists where tenant_id=v_tenant and id=v_session.list_id and status='active';
    if not found then raise exception 'list_not_active'; end if;
    v_local:=now() at time zone v_list.timezone;
    if not (extract(isodow from v_local)::integer=any(v_list.allowed_days)
      and v_local::time>=v_list.allowed_start_time and v_local::time<v_list.allowed_end_time) then
      raise exception 'outside_list_calling_hours';
    end if;
  elsif p_callback_activity_id is not null then
    if not exists(
      select 1 from public.activities a where a.tenant_id=v_tenant and a.id=p_callback_activity_id
        and a.customer_id=p_customer_id and a.type='callback' and a.status in ('open','in_progress')
        and (a.assigned_user_id=v_user or (a.callback_scope='global' and a.claimed_by=v_user))
    ) then raise exception 'callback_not_available'; end if;
  end if;

  select m.connection_id,m.rinkel_user_id,m.default_number_id,
         ru.external_user_id,ru.external_device_id,
         rn.external_number_id,rn.phone_number_e164,rn.phone_number_id,
         ti.status connection_status
    into v_mapping
  from public.rinkel_user_mappings m
  join public.rinkel_users ru on ru.tenant_id=m.tenant_id and ru.id=m.rinkel_user_id and ru.active
  join public.rinkel_numbers rn on rn.tenant_id=m.tenant_id and rn.id=m.default_number_id and rn.active
  join public.tenant_integrations ti on ti.tenant_id=m.tenant_id and ti.id=m.connection_id
  where m.tenant_id=v_tenant and m.kundexa_user_id=v_user and m.active
    and ti.provider='rinkel' and ti.disabled_at is null and ti.status in ('connected','degraded','active');
  if not found then raise exception 'rinkel_seller_mapping_missing'; end if;
  if v_mapping.external_device_id is null then raise exception 'rinkel_device_missing'; end if;
  if p_session_id is not null and v_session.mode='automatic' and not exists(
    select 1
    from public.rinkel_capabilities rc
    join public.tenant_integrations ti
      on ti.tenant_id=rc.tenant_id and ti.id=rc.connection_id
    where rc.tenant_id=v_tenant
      and rc.connection_id=v_mapping.connection_id
      and rc.dial
      and rc.webhooks
      and ti.webhook_status='active'
      and ti.disabled_at is null
  ) then
    raise exception 'automatic_dialer_requires_healthy_rinkel_webhooks';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_tenant::text||':'||v_user::text,0));
  if exists(
    select 1 from public.call_attempts where tenant_id=v_tenant
      and (seller_user_id=v_user or (connection_id=v_mapping.connection_id and rinkel_device_id=v_mapping.external_device_id))
      and status in ('requested','dial_requested','awaiting_provider_event','matched','provider_outcome_unknown','reconciliation_required')
  ) then raise exception 'active_call_already_exists'; end if;

  insert into public.calls(
    tenant_id,provider,provider_connection_id,customer_id,contact_person_id,
    phone_number_id,user_id,team_id,direction,from_number,to_number,status,
    provider_user_id,provider_device_id,recording_enabled,recording_status,
    transcription_status,insights_status,idempotency_key,purpose,
    list_id,list_member_id,dialer_session_id,callback_activity_id,callback_token_hash,metadata
  ) values (
    v_tenant,'rinkel',v_mapping.connection_id,p_customer_id,p_contact_person_id,
    v_mapping.phone_number_id,v_user,(select assigned_team_id from public.customers where tenant_id=v_tenant and id=p_customer_id),
    'outbound',v_mapping.phone_number_e164,p_target_phone,'requested',
    v_mapping.external_user_id,v_mapping.external_device_id,v_policy.recording_enabled,
    case when v_policy.recording_enabled then 'pending' else 'not_expected' end,
    case when v_policy.transcription_enabled then 'pending' else 'disabled' end,
    'pending',p_idempotency_key,p_purpose,
    case when p_session_id is null then null else v_session.list_id end,p_list_member_id,p_session_id,p_callback_activity_id,
    encode(digest(p_idempotency_key,'sha256'),'hex'),
    jsonb_build_object('mode',case when p_session_id is null then 'click_to_call' else 'list_dialer' end)
  ) returning id into v_call;

  insert into public.call_attempts(
    tenant_id,connection_id,call_id,seller_user_id,rinkel_user_id,rinkel_number_id,rinkel_device_id,
    destination_number_e164,source_number_e164,client_request_id,idempotency_key,status
  ) values (
    v_tenant,v_mapping.connection_id,v_call,v_user,v_mapping.rinkel_user_id,v_mapping.default_number_id,
    v_mapping.external_device_id,p_target_phone,v_mapping.phone_number_e164,p_client_request_id,p_idempotency_key,'requested'
  ) returning id into v_attempt;

  if p_session_id is not null then
    update public.customer_list_members set state='dialing',attempts=attempts+1,last_call_id=v_call,
      last_contacted_at=now(),claim_expires_at=now()+interval '2 hours' where tenant_id=v_tenant and id=p_list_member_id;
    update public.dialer_sessions set state='calling',current_call_id=v_call,last_seen_at=now()
      where tenant_id=v_tenant and id=p_session_id;
  end if;
  if p_callback_activity_id is not null then
    update public.activities set status='in_progress',claimed_by=v_user,claim_expires_at=now()+interval '2 hours',call_id=v_call
      where tenant_id=v_tenant and id=p_callback_activity_id;
  end if;
  insert into public.activities(tenant_id,customer_id,type,status,title,assigned_user_id,created_by,call_id,metadata)
  values(v_tenant,p_customer_id,'call','in_progress','Utgående samtal via Rinkel',v_user,v_user,v_call,
    jsonb_build_object('provider','rinkel','call_id',v_call));
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
  values(v_tenant,v_user,'rinkel.call_reserved','call',v_call::text,
    jsonb_build_object('attempt_id',v_attempt,'customer_id',p_customer_id,'destination_suffix',right(p_target_phone,4)));
  return jsonb_build_object(
    'callId',v_call,'attemptId',v_attempt,'connectionId',v_mapping.connection_id,
    'deviceId',v_mapping.external_device_id,'numberId',v_mapping.external_number_id,
    'to',p_target_phone,'status','requested','idempotentReplay',false
  );
end
$$;

create or replace function public.rinkel_finalize_dial_request(
  p_call_id uuid,p_attempt_id uuid,p_outcome text,p_error_code text default null,p_error_message text default null
) returns void
language plpgsql security definer set search_path=public as $$
declare v_call public.calls%rowtype; v_now timestamptz:=now();
begin
  if auth.role()<>'service_role' then raise exception 'service_role_required'; end if;
  if p_outcome not in ('accepted','failed','unknown') then raise exception 'invalid_dial_outcome'; end if;
  select * into v_call from public.calls where id=p_call_id and provider='rinkel' for update;
  if not found then raise exception 'rinkel_call_not_found'; end if;
  if not exists(select 1 from public.call_attempts where tenant_id=v_call.tenant_id and id=p_attempt_id and call_id=p_call_id) then
    raise exception 'rinkel_attempt_not_found';
  end if;
  if p_outcome='accepted' then
    update public.call_attempts set status='awaiting_provider_event',provider_request_finished_at=v_now,
      error_code=null,error_message=null where tenant_id=v_call.tenant_id and id=p_attempt_id;
    update public.calls set status='dial_requested',initiated_at=coalesce(initiated_at,v_now)
      where tenant_id=v_call.tenant_id and id=p_call_id and status in ('requested','dial_requested');
  elsif p_outcome='unknown' then
    update public.call_attempts set status='provider_outcome_unknown',provider_request_finished_at=v_now,
      error_code=p_error_code,error_message=left(p_error_message,500) where tenant_id=v_call.tenant_id and id=p_attempt_id;
    update public.calls set status='provider_outcome_unknown'
      where tenant_id=v_call.tenant_id and id=p_call_id and status not in ('completed','unanswered','failed','blocked','voicemail','outside_business_hours','cancelled');
  else
    update public.call_attempts set status='failed',provider_request_finished_at=v_now,
      error_code=p_error_code,error_message=left(p_error_message,500) where tenant_id=v_call.tenant_id and id=p_attempt_id;
    update public.calls set status='failed',ended_at=coalesce(ended_at,v_now),end_cause=coalesce(p_error_code,'RINKEL_DIAL_FAILED')
      where tenant_id=v_call.tenant_id and id=p_call_id and status not in ('completed','unanswered','cancelled');
    if v_call.list_member_id is not null then
      update public.customer_list_members set state='retry',next_attempt_at=now()+interval '1 day',
        claimed_by=null,claim_expires_at=null where tenant_id=v_call.tenant_id and id=v_call.list_member_id;
    end if;
    if v_call.dialer_session_id is not null then
      update public.dialer_sessions set state='active',current_call_id=null,last_seen_at=now()
        where tenant_id=v_call.tenant_id and id=v_call.dialer_session_id;
    end if;
  end if;
  insert into public.audit_logs(tenant_id,action,entity_type,entity_id,after_data)
  values(v_call.tenant_id,'rinkel.dial_'||p_outcome,'call',p_call_id::text,
    jsonb_build_object('attempt_id',p_attempt_id,'error_code',p_error_code));
end
$$;

create or replace function public.complete_manual_call_work_v2(
  p_call_id uuid,p_disposition text,p_notes text,p_callback_scope text,p_callback_due_at timestamptz
) returns jsonb
language plpgsql security definer set search_path=public as $$
declare
  v_tenant uuid:=public.current_tenant_id();
  v_user uuid:=auth.uid();
  v_provider text;
  v_status text;
  v_result jsonb;
begin
  select provider,status into v_provider,v_status from public.calls
    where tenant_id=v_tenant and id=p_call_id and user_id=v_user for update;
  if not found then raise exception 'manual_call_not_found'; end if;
  if v_provider='rinkel' then
    if v_status not in ('completed','unanswered','failed','blocked','voicemail','outside_business_hours','cancelled') then
      raise exception 'call_not_finished';
    end if;
    update public.calls set status=case
      when v_status='unanswered' then 'no_answer'
      when v_status in ('blocked','outside_business_hours') then 'failed'
      when v_status='voicemail' then 'completed'
      else v_status end
    where tenant_id=v_tenant and id=p_call_id;
  end if;
  v_result:=public.complete_manual_call_work(p_call_id,p_disposition,p_notes,p_callback_scope,p_callback_due_at);
  if v_provider='rinkel' then
    update public.calls set status=v_status where tenant_id=v_tenant and id=p_call_id;
  end if;
  return v_result;
end
$$;

create or replace function public.complete_dialer_work_v2(
  p_call_id uuid,p_disposition_key text,p_notes text,p_callback_scope text,p_callback_due_at timestamptz,
  p_create_order boolean,p_product_id uuid,p_quantity numeric,p_unit_price numeric,p_idempotency_key text
) returns jsonb
language plpgsql security definer set search_path=public as $$
declare
  v_tenant uuid:=public.current_tenant_id();
  v_user uuid:=auth.uid();
  v_provider text;
  v_status text;
  v_result jsonb;
begin
  select provider,status into v_provider,v_status from public.calls
    where tenant_id=v_tenant and id=p_call_id and user_id=v_user for update;
  if not found then raise exception 'list_call_not_found'; end if;
  if v_provider='rinkel' then
    if v_status not in ('completed','unanswered','failed','blocked','voicemail','outside_business_hours','cancelled') then
      raise exception 'call_not_finished';
    end if;
    update public.calls set status=case
      when v_status='unanswered' then 'no_answer'
      when v_status in ('blocked','outside_business_hours') then 'failed'
      when v_status='voicemail' then 'completed'
      else v_status end
    where tenant_id=v_tenant and id=p_call_id;
  end if;
  v_result:=public.complete_dialer_work(
    p_call_id,p_disposition_key,p_notes,p_callback_scope,p_callback_due_at,
    p_create_order,p_product_id,p_quantity,p_unit_price,p_idempotency_key
  );
  if v_provider='rinkel' then
    update public.calls set status=v_status where tenant_id=v_tenant and id=p_call_id;
  end if;
  return v_result;
end
$$;

create or replace function public.replace_rinkel_user_mapping(
  p_kundexa_user_id uuid,
  p_rinkel_user_id uuid,
  p_default_number_id uuid
) returns uuid
language plpgsql security definer set search_path=public as $$
declare
  v_tenant uuid:=public.current_tenant_id();
  v_actor uuid:=auth.uid();
  v_role text:=public.current_membership_role();
  v_connection uuid;
  v_mapping uuid;
  v_existing_user uuid;
begin
  if v_tenant is null or v_actor is null then raise exception 'authentication_required'; end if;
  if v_role not in ('owner','admin','team_lead') then raise exception 'rinkel_mapping_permission_required'; end if;
  if not exists(
    select 1 from public.tenant_memberships
    where tenant_id=v_tenant and user_id=p_kundexa_user_id and status='active'
  ) then raise exception 'rinkel_mapping_member_not_active'; end if;
  if v_role='team_lead' and not exists(
    select 1 from public.team_members tm
    where tm.tenant_id=v_tenant
      and tm.user_id=p_kundexa_user_id
      and public.can_manage_team(tm.team_id)
  ) then raise exception 'rinkel_mapping_team_permission_required'; end if;

  select ru.connection_id into v_connection
  from public.rinkel_users ru
  join public.tenant_integrations ti
    on ti.tenant_id=ru.tenant_id and ti.id=ru.connection_id
  where ru.tenant_id=v_tenant
    and ru.id=p_rinkel_user_id
    and ru.active
    and ru.external_device_id is not null
    and ti.provider='rinkel'
    and ti.disabled_at is null;
  if not found then raise exception 'rinkel_mapping_user_not_active'; end if;
  if not exists(
    select 1 from public.rinkel_numbers rn
    where rn.tenant_id=v_tenant
      and rn.connection_id=v_connection
      and rn.id=p_default_number_id
      and rn.active
  ) then raise exception 'rinkel_mapping_number_not_active'; end if;

  select kundexa_user_id into v_existing_user
  from public.rinkel_user_mappings
  where tenant_id=v_tenant
    and connection_id=v_connection
    and rinkel_user_id=p_rinkel_user_id
    and active
  for update;
  if v_role='team_lead'
    and v_existing_user is not null
    and v_existing_user<>p_kundexa_user_id
    and not exists(
      select 1 from public.team_members tm
      where tm.tenant_id=v_tenant
        and tm.user_id=v_existing_user
        and public.can_manage_team(tm.team_id)
    )
  then raise exception 'rinkel_mapping_existing_user_outside_managed_team'; end if;

  perform pg_advisory_xact_lock(hashtextextended(v_tenant::text||':rinkel-mapping:'||p_kundexa_user_id::text,0));
  update public.rinkel_user_mappings
  set active=false
  where tenant_id=v_tenant
    and connection_id=v_connection
    and active
    and (kundexa_user_id=p_kundexa_user_id or rinkel_user_id=p_rinkel_user_id);
  insert into public.rinkel_user_mappings(
    tenant_id,connection_id,kundexa_user_id,rinkel_user_id,default_number_id,active,created_by
  ) values(
    v_tenant,v_connection,p_kundexa_user_id,p_rinkel_user_id,p_default_number_id,true,v_actor
  ) returning id into v_mapping;
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
  values(
    v_tenant,v_actor,'rinkel.user_mapping_saved','rinkel_user_mapping',v_mapping::text,
    jsonb_build_object(
      'kundexa_user_id',p_kundexa_user_id,
      'rinkel_user_id',p_rinkel_user_id,
      'default_number_id',p_default_number_id
    )
  );
  return v_mapping;
end
$$;

revoke all on function public.rinkel_finalize_dial_request(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.rinkel_finalize_dial_request(uuid,uuid,text,text,text) to service_role;
revoke all on function public.rinkel_reserve_outbound_call(uuid,uuid,text,uuid,uuid,uuid,uuid,text,text) from public,anon;
grant execute on function public.rinkel_reserve_outbound_call(uuid,uuid,text,uuid,uuid,uuid,uuid,text,text) to authenticated;
revoke all on function public.queue_outbound_call(uuid,text,text,text,text,text) from public,anon,authenticated;
revoke all on function public.queue_outbound_call_target(uuid,uuid,text,text,text,text,text,text) from public,anon,authenticated;
revoke all on function public.queue_list_outbound_call(uuid,uuid,uuid,text,text,text,text,text) from public,anon,authenticated;
revoke all on function public.queue_list_outbound_call_target(uuid,uuid,uuid,uuid,text,text,text,text,text,text) from public,anon,authenticated;
revoke all on function public.complete_manual_call_work_v2(uuid,text,text,text,timestamptz) from public,anon;
grant execute on function public.complete_manual_call_work_v2(uuid,text,text,text,timestamptz) to authenticated;
revoke all on function public.complete_dialer_work_v2(uuid,text,text,text,timestamptz,boolean,uuid,numeric,numeric,text) from public,anon;
grant execute on function public.complete_dialer_work_v2(uuid,text,text,text,timestamptz,boolean,uuid,numeric,numeric,text) to authenticated;
revoke all on function public.replace_rinkel_user_mapping(uuid,uuid,uuid) from public,anon;
grant execute on function public.replace_rinkel_user_mapping(uuid,uuid,uuid) to authenticated;

with disabled_jobs as (
  update public.outbox_jobs
  set status='dead_letter',
      last_error='permanent_legacy_46elks_voice_job_disabled_use_rinkel',
      locked_at=null,
      locked_by=null,
      completed_at=now()
  where job_type='call.start'
    and status in ('pending','processing','failed')
  returning tenant_id,aggregate_id
)
update public.calls c
set status='failed',
    ended_at=coalesce(c.ended_at,now()),
    end_cause=coalesce(c.end_cause,'LEGACY_VOICE_PROVIDER_DISABLED'),
    metadata=coalesce(c.metadata,'{}'::jsonb)||jsonb_build_object('legacy_voice_job_disabled',true)
from disabled_jobs j
where c.tenant_id=j.tenant_id
  and c.id=j.aggregate_id
  and c.provider='46elks'
  and c.status in ('queued','initiating');

do $$
declare t text;
begin
  foreach t in array array[
    'rinkel_users','rinkel_numbers','rinkel_user_mappings','rinkel_capabilities',
    'rinkel_webhook_subscriptions','call_attempts','call_transcripts','call_insights',
    'call_correlation_conflicts'
  ] loop
    execute format('alter table public.%I enable row level security',t);
  end loop;
end
$$;

create policy rinkel_users_scoped_select on public.rinkel_users for select to authenticated
  using(
    tenant_id=public.current_tenant_id()
    and (
      public.has_current_role(array['owner','admin','team_lead'])
      or exists(
        select 1 from public.rinkel_user_mappings m
        where m.tenant_id=rinkel_users.tenant_id
          and m.rinkel_user_id=rinkel_users.id
          and m.kundexa_user_id=auth.uid()
          and m.active
      )
    )
  );
create policy rinkel_numbers_scoped_select on public.rinkel_numbers for select to authenticated
  using(
    tenant_id=public.current_tenant_id()
    and (
      public.has_current_role(array['owner','admin','team_lead'])
      or exists(
        select 1 from public.rinkel_user_mappings m
        where m.tenant_id=rinkel_numbers.tenant_id
          and m.default_number_id=rinkel_numbers.id
          and m.kundexa_user_id=auth.uid()
          and m.active
      )
    )
  );
create policy rinkel_user_mappings_scoped_select on public.rinkel_user_mappings for select to authenticated
  using(
    tenant_id=public.current_tenant_id()
    and (
      public.is_tenant_admin(tenant_id)
      or kundexa_user_id=auth.uid()
      or (
        public.has_current_role(array['team_lead'])
        and exists(
          select 1 from public.team_members tm
          where tm.tenant_id=rinkel_user_mappings.tenant_id
            and tm.user_id=rinkel_user_mappings.kundexa_user_id
            and public.can_manage_team(tm.team_id)
        )
      )
    )
  );
create policy rinkel_capabilities_member_select on public.rinkel_capabilities for select to authenticated
  using(tenant_id=public.current_tenant_id() and public.is_tenant_member(tenant_id));
create policy rinkel_webhook_subscriptions_admin_select on public.rinkel_webhook_subscriptions for select to authenticated
  using(tenant_id=public.current_tenant_id() and public.is_tenant_admin(tenant_id));
create policy call_attempts_call_select on public.call_attempts for select to authenticated
  using(tenant_id=public.current_tenant_id() and public.can_access_call(call_id));
create policy call_transcripts_call_select on public.call_transcripts for select to authenticated
  using(tenant_id=public.current_tenant_id() and public.can_access_call(call_id));
create policy call_insights_call_select on public.call_insights for select to authenticated
  using(tenant_id=public.current_tenant_id() and public.can_access_call(call_id));
create policy call_correlation_conflicts_admin_select on public.call_correlation_conflicts for select to authenticated
  using(tenant_id=public.current_tenant_id() and public.is_tenant_admin(tenant_id));

create policy rinkel_users_admin_write on public.rinkel_users for all to authenticated
  using(tenant_id=public.current_tenant_id() and public.is_tenant_admin(tenant_id))
  with check(tenant_id=public.current_tenant_id() and public.is_tenant_admin(tenant_id));
create policy rinkel_numbers_admin_write on public.rinkel_numbers for all to authenticated
  using(tenant_id=public.current_tenant_id() and public.is_tenant_admin(tenant_id))
  with check(tenant_id=public.current_tenant_id() and public.is_tenant_admin(tenant_id));
create policy rinkel_user_mappings_admin_write on public.rinkel_user_mappings for all to authenticated
  using(tenant_id=public.current_tenant_id() and public.is_tenant_admin(tenant_id))
  with check(tenant_id=public.current_tenant_id() and public.is_tenant_admin(tenant_id));
create policy rinkel_capabilities_admin_write on public.rinkel_capabilities for all to authenticated
  using(tenant_id=public.current_tenant_id() and public.is_tenant_admin(tenant_id))
  with check(tenant_id=public.current_tenant_id() and public.is_tenant_admin(tenant_id));
create policy rinkel_webhook_subscriptions_admin_write on public.rinkel_webhook_subscriptions for all to authenticated
  using(tenant_id=public.current_tenant_id() and public.is_tenant_admin(tenant_id))
  with check(tenant_id=public.current_tenant_id() and public.is_tenant_admin(tenant_id));

revoke select on public.rinkel_users,public.rinkel_numbers from authenticated;
grant select(
  id,tenant_id,connection_id,external_user_id,external_device_id,email,display_name,
  active,provider_created_at,last_synced_at,created_at,updated_at
) on public.rinkel_users to authenticated;
grant select(
  id,tenant_id,connection_id,phone_number_id,external_number_id,phone_number_e164,
  display_name,country_code,active,recording_enabled,last_synced_at,created_at,updated_at
) on public.rinkel_numbers to authenticated;

alter table public.telephony_policies enable row level security;
create policy telephony_policies_member_select on public.telephony_policies for select to authenticated
  using(tenant_id=public.current_tenant_id() and public.is_tenant_member(tenant_id));
create policy telephony_policies_admin_write on public.telephony_policies for all to authenticated
  using(tenant_id=public.current_tenant_id() and public.is_tenant_admin(tenant_id))
  with check(tenant_id=public.current_tenant_id() and public.is_tenant_admin(tenant_id));

create trigger rinkel_users_touch before update on public.rinkel_users for each row execute function public.touch_updated_at();
create trigger rinkel_numbers_touch before update on public.rinkel_numbers for each row execute function public.touch_updated_at();
create trigger rinkel_user_mappings_touch before update on public.rinkel_user_mappings for each row execute function public.touch_updated_at();
create trigger rinkel_webhooks_touch before update on public.rinkel_webhook_subscriptions for each row execute function public.touch_updated_at();
create trigger telephony_policies_touch before update on public.telephony_policies for each row execute function public.touch_updated_at();
create trigger call_attempts_touch before update on public.call_attempts for each row execute function public.touch_updated_at();
create trigger call_transcripts_touch before update on public.call_transcripts for each row execute function public.touch_updated_at();
create trigger call_insights_touch before update on public.call_insights for each row execute function public.touch_updated_at();
create trigger call_recordings_rinkel_touch before update on public.call_recordings for each row execute function public.touch_updated_at();

insert into public.provider_network_allowlists(provider,network,active,description)
values
  ('rinkel','82.199.77.220/32',true,'Rinkel documented webhook source'),
  ('rinkel','188.122.73.177/32',true,'Rinkel documented webhook source')
on conflict (provider,network) do update
set active=excluded.active,description=excluded.description;

commit;
