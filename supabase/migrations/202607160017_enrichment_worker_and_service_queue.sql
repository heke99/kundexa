begin;

-- Enrichment jobs need durable retries, worker ownership and a raw-payload parent.
alter table public.enrichment_jobs
  add column if not exists attempts integer not null default 0,
  add column if not exists max_attempts integer not null default 6 check (max_attempts between 1 and 20),
  add column if not exists next_attempt_at timestamptz not null default now(),
  add column if not exists locked_at timestamptz,
  add column if not exists locked_by text,
  add column if not exists result_summary jsonb not null default '{}'::jsonb;
create index if not exists enrichment_jobs_ready_idx
  on public.enrichment_jobs(status,next_attempt_at,created_at)
  where status='queued';

alter table public.raw_payloads alter column ingestion_run_id drop not null;
alter table public.raw_payloads add column if not exists enrichment_job_id uuid;
alter table public.raw_payloads drop constraint if exists raw_payloads_enrichment_job_tenant_fk;
alter table public.raw_payloads add constraint raw_payloads_enrichment_job_tenant_fk
  foreign key (tenant_id,enrichment_job_id) references public.enrichment_jobs(tenant_id,id) on delete cascade;
alter table public.raw_payloads drop constraint if exists raw_payloads_exactly_one_parent_check;
alter table public.raw_payloads add constraint raw_payloads_exactly_one_parent_check
  check (num_nonnulls(ingestion_run_id,enrichment_job_id)=1);

-- PostgreSQL unique constraints treat NULL account ids as distinct. This closes the
-- duplicate source-entity gap for account-less providers.
create unique index if not exists source_entities_without_account_uidx
  on public.source_entities(data_provider_id,entity_type,external_identifier)
  where provider_account_id is null;

create table public.enrichment_errors (
  id bigint generated always as identity primary key,
  tenant_id uuid not null,
  enrichment_job_id uuid not null,
  stage text not null,
  error_code text,
  message text not null,
  retryable boolean not null default false,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (tenant_id,enrichment_job_id) references public.enrichment_jobs(tenant_id,id) on delete cascade
);
create index enrichment_errors_job_idx on public.enrichment_errors(tenant_id,enrichment_job_id,created_at desc);
alter table public.enrichment_errors enable row level security;

-- Claiming is atomic, concurrency-limited, quota-reserving and protected by one
-- distributed refresh lock per provider/entity/enrichment type.
create or replace function public.claim_enrichment_jobs(p_worker text,p_limit integer default 10)
returns setof public.enrichment_jobs
language plpgsql security definer set search_path=public
as $$
declare
  v_job public.enrichment_jobs%rowtype;
  v_permission public.provider_permissions%rowtype;
  v_account public.provider_accounts%rowtype;
  v_rate public.provider_rate_limits%rowtype;
  v_window timestamptz;
  v_used integer;
  v_running integer;
  v_lock_key text;
  v_acquired uuid;
  v_claimed uuid[] := '{}'::uuid[];
begin
  if nullif(trim(p_worker),'') is null then raise exception 'worker_id_required'; end if;

  for v_job in
    select ej.*
    from public.enrichment_jobs ej
    where ej.status='queued'
      and ej.next_attempt_at<=now()
      and ej.attempts<ej.max_attempts
    order by ej.created_at
    for update skip locked
    limit greatest(1,least(p_limit,50))*5
  loop
    exit when cardinality(v_claimed)>=greatest(1,least(p_limit,50));

    select * into v_permission from public.provider_permissions
      where tenant_id=v_job.tenant_id and id=v_job.permission_id;
    if not found or v_permission.status<>'active'
       or (v_permission.starts_at is not null and v_permission.starts_at>now())
       or (v_permission.expires_at is not null and v_permission.expires_at<=now()) then
      update public.enrichment_jobs set status='failed',completed_at=now(),last_error='provider_permission_inactive'
        where id=v_job.id;
      continue;
    end if;

    select * into v_account from public.provider_accounts
      where tenant_id=v_job.tenant_id and id=v_job.provider_account_id;
    if not found or v_account.status<>'active' then
      update public.enrichment_jobs set status='failed',completed_at=now(),last_error='provider_account_inactive'
        where id=v_job.id;
      continue;
    end if;

    select * into v_rate from public.provider_rate_limits
      where tenant_id=v_job.tenant_id and provider_account_id=v_job.provider_account_id
      order by case when quota_key='enrichment' then 0 else 1 end,created_at
      limit 1;

    select count(*) into v_running from public.enrichment_jobs
      where tenant_id=v_job.tenant_id and provider_account_id=v_job.provider_account_id
        and status='running' and id<>v_job.id;
    if v_running>=coalesce(v_rate.max_concurrency,1) then continue; end if;

    if v_rate.id is not null then
      v_window := to_timestamp(floor(extract(epoch from now())/v_rate.window_seconds)*v_rate.window_seconds);
      insert into public.provider_usage_counters(tenant_id,provider_account_id,quota_key,window_started_at,used_units)
        values(v_job.tenant_id,v_job.provider_account_id,v_rate.quota_key,v_window,0)
      on conflict(provider_account_id,quota_key,window_started_at) do nothing;
      select used_units into v_used from public.provider_usage_counters
        where provider_account_id=v_job.provider_account_id and quota_key=v_rate.quota_key and window_started_at=v_window
        for update;
      if v_used+greatest(1,v_job.estimated_external_calls)>v_rate.max_units then
        update public.enrichment_jobs set next_attempt_at=v_window+make_interval(secs=>v_rate.window_seconds),last_error='provider_quota_wait'
          where id=v_job.id;
        continue;
      end if;
    end if;

    v_lock_key := concat_ws(':',v_job.data_provider_id::text,v_job.master_entity_id::text,v_job.enrichment_type);
    v_acquired := null;
    insert into public.refresh_locks(lock_key,tenant_id,enrichment_job_id,locked_until,locked_by)
      values(v_lock_key,v_job.tenant_id,v_job.id,now()+interval '10 minutes',p_worker)
    on conflict(lock_key) do update set
      tenant_id=excluded.tenant_id,enrichment_job_id=excluded.enrichment_job_id,
      locked_until=excluded.locked_until,locked_by=excluded.locked_by,created_at=now()
    where public.refresh_locks.locked_until<=now()
    returning enrichment_job_id into v_acquired;
    if v_acquired is null or v_acquired<>v_job.id then continue; end if;

    if v_rate.id is not null then
      update public.provider_usage_counters set
        used_units=used_units+greatest(1,v_job.estimated_external_calls),updated_at=now()
      where provider_account_id=v_job.provider_account_id and quota_key=v_rate.quota_key and window_started_at=v_window;
    end if;

    update public.enrichment_jobs set
      status='running',attempts=attempts+1,started_at=coalesce(started_at,now()),
      locked_at=now(),locked_by=p_worker,last_error=null
    where id=v_job.id;
    update public.entity_freshness set
      state='refreshing',last_refresh_started_at=now(),last_error=null,updated_at=now()
    where master_entity_id=v_job.master_entity_id;
    if not found then
      insert into public.entity_freshness(master_entity_id,state,last_refresh_started_at)
        values(v_job.master_entity_id,'refreshing',now());
    end if;
    v_claimed := array_append(v_claimed,v_job.id);
  end loop;

  return query select ej.* from public.enrichment_jobs ej where ej.id=any(v_claimed) order by ej.created_at;
end
$$;

create or replace function public.complete_enrichment_job(
  p_job_id uuid,
  p_external_identifier text,
  p_facts jsonb,
  p_canonical jsonb,
  p_payload_sha256 text,
  p_payload_ciphertext text default null,
  p_content_type text default 'application/json',
  p_http_status integer default 200,
  p_response_headers jsonb default '{}'::jsonb,
  p_request_id text default null,
  p_source_timestamp timestamptz default null,
  p_parser_version_id uuid default null,
  p_actual_cost numeric default 0,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql security definer set search_path=public
as $$
declare
  v_job public.enrichment_jobs%rowtype;
  v_permission public.provider_permissions%rowtype;
  v_entity public.master_entities%rowtype;
  v_source_entity uuid;
  v_raw_payload uuid;
  v_fact jsonb;
  v_key text;
  v_value jsonb;
  v_hash text;
  v_source_fact uuid;
  v_existing public.field_values%rowtype;
  v_ttl integer := 20;
  v_fresh_until timestamptz;
  v_displayable jsonb := '{}'::jsonb;
  v_stored integer := 0;
  v_changed integer := 0;
begin
  if jsonb_typeof(p_facts)<>'array' then raise exception 'facts_must_be_array'; end if;
  if jsonb_typeof(p_canonical)<>'object' then raise exception 'canonical_must_be_object'; end if;
  if nullif(trim(p_external_identifier),'') is null then raise exception 'external_identifier_required'; end if;
  if nullif(trim(p_payload_sha256),'') is null then raise exception 'payload_hash_required'; end if;

  select * into v_job from public.enrichment_jobs where id=p_job_id for update;
  if not found then raise exception 'enrichment_job_not_found'; end if;
  if v_job.status='completed' then return v_job.result_summary; end if;
  if v_job.status<>'running' then raise exception 'enrichment_job_not_running:%',v_job.status; end if;

  select * into v_permission from public.provider_permissions
    where tenant_id=v_job.tenant_id and id=v_job.permission_id and status='active';
  if not found then raise exception 'provider_permission_inactive'; end if;
  select * into v_entity from public.master_entities where id=v_job.master_entity_id for update;
  if not found then raise exception 'master_entity_not_found'; end if;

  select coalesce(min(ttl_days),20) into v_ttl
  from public.provider_freshness_policies
  where tenant_id=v_job.tenant_id and data_provider_id=v_job.data_provider_id
    and entity_type=v_entity.entity_type and active
    and (field_key is null or field_key=any(v_job.requested_fields));
  v_ttl := coalesce(v_ttl,20);
  v_fresh_until := now()+make_interval(days=>v_ttl);

  if v_permission.raw_storage_allowed then
    insert into public.raw_payloads(
      tenant_id,enrichment_job_id,permission_id,external_identifier,content_type,http_status,
      request_id,response_headers,source_timestamp,parser_version_id,payload_ciphertext,
      payload_sha256,retention_until,metadata
    ) values (
      v_job.tenant_id,v_job.id,v_job.permission_id,p_external_identifier,p_content_type,p_http_status,
      p_request_id,coalesce(p_response_headers,'{}'::jsonb),p_source_timestamp,p_parser_version_id,p_payload_ciphertext,
      p_payload_sha256,case when v_permission.retention_days is null then null else now()+make_interval(days=>v_permission.retention_days) end,
      coalesce(p_metadata,'{}'::jsonb)
    ) returning id into v_raw_payload;
  end if;

  insert into public.source_entities(
    owner_tenant_id,data_provider_id,provider_account_id,permission_id,entity_type,external_identifier,
    raw_payload_id,last_seen_at,parser_version_id,metadata
  ) values (
    v_job.tenant_id,v_job.data_provider_id,v_job.provider_account_id,v_job.permission_id,v_entity.entity_type,
    p_external_identifier,v_raw_payload,now(),p_parser_version_id,coalesce(p_metadata,'{}'::jsonb)
  )
  on conflict(data_provider_id,provider_account_id,entity_type,external_identifier) do update set
    permission_id=excluded.permission_id,raw_payload_id=excluded.raw_payload_id,last_seen_at=now(),removed_at=null,
    parser_version_id=excluded.parser_version_id,metadata=public.source_entities.metadata||excluded.metadata
  returning id into v_source_entity;

  insert into public.entity_source_links(master_entity_id,source_entity_id,match_method,confidence)
    values(v_entity.id,v_source_entity,'external_identifier',1)
  on conflict(master_entity_id,source_entity_id) do update set confidence=greatest(public.entity_source_links.confidence,excluded.confidence);

  for v_fact in select value from jsonb_array_elements(p_facts)
  loop
    v_key := nullif(trim(v_fact->>'field_key'),'');
    v_value := v_fact->'field_value';
    v_hash := nullif(v_fact->>'value_hash','');
    if v_key is null or v_value is null or v_hash is null then continue; end if;
    if not exists(
      select 1 from public.provider_field_permissions fp
      where fp.tenant_id=v_job.tenant_id and fp.permission_id=v_job.permission_id
        and fp.entity_type=v_entity.entity_type and fp.field_key=v_key and fp.may_store
    ) then continue; end if;

    insert into public.source_facts(
      source_entity_id,field_key,field_value,value_hash,fetched_at,last_seen_at,verified_at,
      confidence,parser_version_id,permission_id
    ) values (
      v_source_entity,v_key,v_value,v_hash,now(),now(),p_source_timestamp,
      coalesce(nullif(v_fact->>'confidence','')::numeric,0.75),p_parser_version_id,v_job.permission_id
    )
    on conflict(source_entity_id,field_key,value_hash) do update set
      last_seen_at=now(),verified_at=coalesce(excluded.verified_at,public.source_facts.verified_at),
      confidence=greatest(public.source_facts.confidence,excluded.confidence),removed_at=null
    returning id into v_source_fact;
    v_stored := v_stored+1;

    select * into v_existing from public.field_values
      where master_entity_id=v_entity.id and field_key=v_key for update;
    if not found then
      insert into public.field_values(
        master_entity_id,field_key,field_value,selected_source_fact_id,source_priority,confidence,verified_at,fresh_until
      ) values (v_entity.id,v_key,v_value,v_source_fact,50,coalesce(nullif(v_fact->>'confidence','')::numeric,0.75),p_source_timestamp,v_fresh_until);
      insert into public.field_value_history(master_entity_id,field_key,new_value,source_fact_id,change_type)
        values(v_entity.id,v_key,v_value,v_source_fact,'created');
      v_changed := v_changed+1;
    elsif not v_existing.manually_verified and v_existing.field_value is distinct from v_value then
      insert into public.field_value_history(master_entity_id,field_key,old_value,new_value,source_fact_id,change_type)
        values(v_entity.id,v_key,v_existing.field_value,v_value,v_source_fact,'changed');
      update public.field_values set
        field_value=v_value,selected_source_fact_id=v_source_fact,source_priority=50,
        confidence=coalesce(nullif(v_fact->>'confidence','')::numeric,0.75),verified_at=p_source_timestamp,
        fresh_until=v_fresh_until,updated_at=now()
      where id=v_existing.id;
      v_changed := v_changed+1;
    elsif not v_existing.manually_verified then
      update public.field_values set
        selected_source_fact_id=v_source_fact,confidence=greatest(confidence,coalesce(nullif(v_fact->>'confidence','')::numeric,0.75)),
        verified_at=coalesce(p_source_timestamp,verified_at),fresh_until=v_fresh_until,updated_at=now()
      where id=v_existing.id;
    end if;

    insert into public.field_freshness(master_entity_id,field_key,verified_at,fresh_until,next_refresh_at,state,updated_at)
      values(v_entity.id,v_key,coalesce(p_source_timestamp,now()),v_fresh_until,v_fresh_until,'fresh',now())
    on conflict(master_entity_id,field_key) do update set
      verified_at=excluded.verified_at,fresh_until=excluded.fresh_until,next_refresh_at=excluded.next_refresh_at,state='fresh',updated_at=now();
  end loop;

  select coalesce(jsonb_object_agg(c.key,c.value),'{}'::jsonb) into v_displayable
  from jsonb_each(p_canonical) c
  where exists(
    select 1 from public.provider_field_permissions fp
    where fp.tenant_id=v_job.tenant_id and fp.permission_id=v_job.permission_id
      and fp.entity_type=v_entity.entity_type and fp.field_key=c.key and fp.may_display
  );

  update public.master_entities set
    canonical_name=coalesce(nullif(v_displayable->>'canonical_name',''),canonical_name),
    organization_number=coalesce(nullif(v_displayable->>'organization_number',''),organization_number),
    legal_form=coalesce(nullif(v_displayable->>'legal_form',''),legal_form),
    organization_status=coalesce(nullif(v_displayable->>'organization_status',''),organization_status),
    address_line1=coalesce(nullif(v_displayable->>'address_line1',''),address_line1),
    postal_code=coalesce(nullif(v_displayable->>'postal_code',''),postal_code),
    city=coalesce(nullif(v_displayable->>'city',''),city),
    municipality=coalesce(nullif(v_displayable->>'municipality',''),municipality),
    municipality_code=coalesce(nullif(v_displayable->>'municipality_code',''),municipality_code),
    county=coalesce(nullif(v_displayable->>'county',''),county),
    county_code=coalesce(nullif(v_displayable->>'county_code',''),county_code),
    country_code=coalesce(nullif(v_displayable->>'country_code',''),country_code),
    latitude=coalesce(nullif(v_displayable->>'latitude','')::numeric,latitude),
    longitude=coalesce(nullif(v_displayable->>'longitude','')::numeric,longitude),
    industry=coalesce(nullif(v_displayable->>'industry',''),industry),
    sni_code=coalesce(nullif(v_displayable->>'sni_code',''),sni_code),
    employee_count=coalesce(nullif(v_displayable->>'employee_count','')::integer,employee_count),
    revenue=coalesce(nullif(v_displayable->>'revenue','')::numeric,revenue),
    result=coalesce(nullif(v_displayable->>'result','')::numeric,result),
    website=coalesce(nullif(v_displayable->>'website',''),website),
    phone_e164=coalesce(nullif(v_displayable->>'phone_e164',''),phone_e164),
    email=coalesce(nullif(v_displayable->>'email','')::citext,email),
    external_primary_id=coalesce(nullif(p_external_identifier,''),external_primary_id),
    current_master=current_master||v_displayable,enriched_at=now(),fresh_until=v_fresh_until,
    next_refresh_at=v_fresh_until,source_removed_at=null,updated_at=now()
  where id=v_entity.id;

  insert into public.entity_freshness(master_entity_id,state,enriched_at,fresh_until,next_refresh_at,last_refresh_completed_at,last_error,updated_at)
    values(v_entity.id,'fresh',now(),v_fresh_until,v_fresh_until,now(),null,now())
  on conflict(master_entity_id) do update set
    state='fresh',enriched_at=now(),fresh_until=excluded.fresh_until,next_refresh_at=excluded.next_refresh_at,
    last_refresh_completed_at=now(),last_error=null,updated_at=now();

  update public.enrichment_jobs set
    status='completed',actual_external_calls=greatest(actual_external_calls,1),actual_cost=coalesce(p_actual_cost,0),
    completed_at=now(),locked_at=null,locked_by=null,last_error=null,
    result_summary=jsonb_build_object('stored_facts',v_stored,'changed_fields',v_changed,'fresh_until',v_fresh_until,'raw_payload_id',v_raw_payload)
  where id=v_job.id;
  delete from public.refresh_locks where enrichment_job_id=v_job.id;
  insert into public.provider_usage_logs(tenant_id,data_provider_id,user_id,action,purpose,units,cost,external_reference,metadata)
    values(v_job.tenant_id,v_job.data_provider_id,v_job.requested_by,'enrichment.completed',v_job.purpose,1,coalesce(p_actual_cost,0),p_external_identifier,
      jsonb_build_object('job_id',v_job.id,'stored_facts',v_stored,'changed_fields',v_changed));

  return jsonb_build_object('stored_facts',v_stored,'changed_fields',v_changed,'fresh_until',v_fresh_until,'raw_payload_id',v_raw_payload);
end
$$;

create or replace function public.fail_enrichment_job(
  p_job_id uuid,
  p_stage text,
  p_error text,
  p_retryable boolean default true,
  p_delay_seconds integer default 60,
  p_details jsonb default '{}'::jsonb
)
returns void
language plpgsql security definer set search_path=public
as $$
declare
  v_job public.enrichment_jobs%rowtype;
  v_terminal boolean;
begin
  select * into v_job from public.enrichment_jobs where id=p_job_id for update;
  if not found then raise exception 'enrichment_job_not_found'; end if;
  v_terminal := not p_retryable or v_job.attempts>=v_job.max_attempts;
  update public.enrichment_jobs set
    status=case when v_terminal then 'failed'::public.enrichment_state else 'queued'::public.enrichment_state end,
    next_attempt_at=case when v_terminal then next_attempt_at else now()+make_interval(secs=>greatest(1,p_delay_seconds)) end,
    completed_at=case when v_terminal then now() else null end,locked_at=null,locked_by=null,last_error=left(p_error,4000)
  where id=p_job_id;
  insert into public.enrichment_errors(tenant_id,enrichment_job_id,stage,message,retryable,details)
    values(v_job.tenant_id,p_job_id,coalesce(nullif(p_stage,''),'worker'),left(p_error,4000),p_retryable,coalesce(p_details,'{}'::jsonb));
  delete from public.refresh_locks where enrichment_job_id=p_job_id;
  insert into public.entity_freshness(master_entity_id,state,last_error,updated_at)
    values(v_job.master_entity_id,case when v_terminal then 'stale' else 'refreshing' end,left(p_error,4000),now())
  on conflict(master_entity_id) do update set
    state=excluded.state,last_error=excluded.last_error,updated_at=now();
end
$$;

-- Service-role queue functions keep automation and confirmation message rows and
-- outbox jobs in one transaction. Browser callers continue to use the session RPCs.
create or replace function public.queue_sms_message_for_tenant(
  p_tenant_id uuid,p_customer_id uuid,p_body text,p_idempotency_key text,
  p_purpose text default 'automation_marketing',p_contract_id uuid default null,
  p_to_number text default null,p_created_by uuid default null,p_payload jsonb default '{}'::jsonb
)
returns uuid
language plpgsql security definer set search_path=public
as $$
declare
  v_customer public.customers%rowtype;
  v_from text;
  v_to text;
  v_message uuid;
begin
  if nullif(trim(p_body),'') is null or nullif(trim(p_idempotency_key),'') is null then raise exception 'sms_content_and_idempotency_required'; end if;
  select id into v_message from public.sms_messages where tenant_id=p_tenant_id and idempotency_key=p_idempotency_key;
  if v_message is not null then return v_message; end if;
  select * into v_customer from public.customers where tenant_id=p_tenant_id and id=p_customer_id and deleted_at is null;
  if not found then raise exception 'customer_not_found'; end if;
  v_to:=coalesce(nullif(p_to_number,''),v_customer.phone_e164);
  if v_to is null or v_to!~ '^\+[1-9][0-9]{7,14}$' then raise exception 'recipient_phone_invalid'; end if;
  select number_e164 into v_from from public.phone_numbers where tenant_id=p_tenant_id and supports_sms and status='active' order by created_at,id limit 1;
  if v_from is null then raise exception 'sms_sender_missing'; end if;
  insert into public.sms_messages(tenant_id,customer_id,contract_id,direction,from_number,to_number,body,status,created_by,idempotency_key,purpose)
    values(p_tenant_id,p_customer_id,p_contract_id,'outbound',v_from,v_to,p_body,'queued',p_created_by,p_idempotency_key,p_purpose)
    returning id into v_message;
  insert into public.outbox_jobs(tenant_id,job_type,aggregate_type,aggregate_id,payload,idempotency_key)
    values(p_tenant_id,'sms.send','sms_message',v_message,coalesce(p_payload,'{}'::jsonb)||jsonb_build_object('sms_message_id',v_message),'sms.send:'||v_message::text);
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
    values(p_tenant_id,p_created_by,'sms.queued','sms_message',v_message::text,jsonb_build_object('customer_id',p_customer_id,'purpose',p_purpose));
  return v_message;
end
$$;

create or replace function public.queue_email_message_for_tenant(
  p_tenant_id uuid,p_customer_id uuid,p_subject text,p_body text,p_idempotency_key text,
  p_purpose text default 'automation_marketing',p_contract_id uuid default null,
  p_to_address text default null,p_created_by uuid default null,p_payload jsonb default '{}'::jsonb
)
returns uuid
language plpgsql security definer set search_path=public
as $$
declare
  v_customer public.customers%rowtype;
  v_to citext;
  v_message uuid;
begin
  if nullif(trim(p_subject),'') is null or nullif(trim(p_body),'') is null or nullif(trim(p_idempotency_key),'') is null then
    raise exception 'email_content_and_idempotency_required';
  end if;
  select id into v_message from public.email_messages where tenant_id=p_tenant_id and idempotency_key=p_idempotency_key;
  if v_message is not null then return v_message; end if;
  select * into v_customer from public.customers where tenant_id=p_tenant_id and id=p_customer_id and deleted_at is null;
  if not found then raise exception 'customer_not_found'; end if;
  v_to:=coalesce(nullif(p_to_address,'')::citext,v_customer.email);
  if v_to is null then raise exception 'recipient_email_missing'; end if;
  insert into public.email_messages(tenant_id,customer_id,contract_id,direction,from_address,to_addresses,subject,body_text,status,created_by,idempotency_key,purpose)
    values(p_tenant_id,p_customer_id,p_contract_id,'outbound','pending@kundexa.local',array[v_to]::citext[],p_subject,p_body,'queued',p_created_by,p_idempotency_key,p_purpose)
    returning id into v_message;
  insert into public.outbox_jobs(tenant_id,job_type,aggregate_type,aggregate_id,payload,idempotency_key)
    values(p_tenant_id,'email.send','email_message',v_message,coalesce(p_payload,'{}'::jsonb)||jsonb_build_object('email_message_id',v_message),'email.send:'||v_message::text);
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
    values(p_tenant_id,p_created_by,'email.queued','email_message',v_message::text,jsonb_build_object('customer_id',p_customer_id,'purpose',p_purpose));
  return v_message;
end
$$;

-- Users may inspect errors for their tenant, but only service workers write them.
create policy enrichment_errors_select on public.enrichment_errors for select to authenticated
  using (tenant_id=public.current_tenant_id() and public.has_current_role(array['owner','admin','backoffice']));

revoke all on function public.claim_enrichment_jobs(text,integer) from public,anon,authenticated;
revoke all on function public.complete_enrichment_job(uuid,text,jsonb,jsonb,text,text,text,integer,jsonb,text,timestamptz,uuid,numeric,jsonb) from public,anon,authenticated;
revoke all on function public.fail_enrichment_job(uuid,text,text,boolean,integer,jsonb) from public,anon,authenticated;
revoke all on function public.queue_sms_message_for_tenant(uuid,uuid,text,text,text,uuid,text,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.queue_email_message_for_tenant(uuid,uuid,text,text,text,text,uuid,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.claim_enrichment_jobs(text,integer) to service_role;
grant execute on function public.complete_enrichment_job(uuid,text,jsonb,jsonb,text,text,text,integer,jsonb,text,timestamptz,uuid,numeric,jsonb) to service_role;
grant execute on function public.fail_enrichment_job(uuid,text,text,boolean,integer,jsonb) to service_role;
grant execute on function public.queue_sms_message_for_tenant(uuid,uuid,text,text,text,uuid,text,uuid,jsonb) to service_role;
grant execute on function public.queue_email_message_for_tenant(uuid,uuid,text,text,text,text,uuid,text,uuid,jsonb) to service_role;

commit;
