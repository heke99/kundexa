begin;

-- A physical E.164 number may belong to exactly one tenant in the platform.
create unique index if not exists phone_numbers_global_e164_uidx on public.phone_numbers(number_e164);

-- Business-message idempotency survives retries before provider submission.
alter table public.sms_messages add column if not exists idempotency_key text;
alter table public.email_messages add column if not exists idempotency_key text;
create unique index if not exists sms_messages_tenant_idempotency_uidx
  on public.sms_messages(tenant_id,idempotency_key);
create unique index if not exists email_messages_tenant_idempotency_uidx
  on public.email_messages(tenant_id,idempotency_key);

-- Provider CIDRs are deliberately data, not hard-coded application constants.
create table if not exists public.provider_network_allowlists (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  network cidr not null,
  active boolean not null default true,
  description text,
  valid_from timestamptz,
  valid_until timestamptz,
  created_at timestamptz not null default now(),
  unique(provider,network)
);
alter table public.provider_network_allowlists enable row level security;

create or replace function public.is_provider_ip_allowed(p_provider text,p_ip inet)
returns boolean
language sql stable security definer set search_path=public
as $$
  select exists(
    select 1 from public.provider_network_allowlists a
    where a.provider=p_provider and a.active
      and (a.valid_from is null or a.valid_from<=now())
      and (a.valid_until is null or a.valid_until>now())
      and p_ip <<= a.network
  )
$$;
revoke all on function public.is_provider_ip_allowed(text,inet) from public,anon,authenticated;
grant execute on function public.is_provider_ip_allowed(text,inet) to service_role;

update storage.buckets set allowed_mime_types=array['application/pdf','application/json'] where id='contract-documents';
alter table public.contract_documents drop constraint if exists contract_documents_document_type_check;
alter table public.contract_documents add constraint contract_documents_document_type_check
  check(document_type in ('source_pdf','generated_pdf','accepted_pdf','signed_pdf','terms','attachment','evidence_pdf','manifest'));
create unique index if not exists contract_documents_tenant_storage_uidx on public.contract_documents(tenant_id,storage_path);
create unique index if not exists evidence_packages_tenant_acceptance_uidx on public.evidence_packages(tenant_id,acceptance_id);


-- Scheduling and leasing metadata for automation executions.
alter table public.automation_runs
  add column if not exists available_at timestamptz not null default now(),
  add column if not exists priority integer not null default 100,
  add column if not exists locked_at timestamptz,
  add column if not exists locked_by text;
create index if not exists automation_runs_claim_idx
  on public.automation_runs(status,available_at,priority,created_at)
  where status in ('pending','failed');

create or replace function public.enqueue_automation_event(
  p_tenant_id uuid,
  p_event_key text,
  p_event_id text,
  p_entity_type text,
  p_entity_id uuid,
  p_input jsonb default '{}'::jsonb
)
returns integer
language plpgsql security definer set search_path=public
as $$
declare v_count integer;
begin
  insert into public.automation_runs(
    tenant_id,automation_id,version_id,trigger_event_id,entity_type,entity_id,status,input,available_at,priority
  )
  select
    r.tenant_id,r.id,v.id,p_event_id,p_entity_type,p_entity_id,'pending',
    coalesce(p_input,'{}'::jsonb) || jsonb_build_object('event_key',p_event_key,'automation_depth',coalesce((p_input->>'automation_depth')::integer,0)),
    now() + make_interval(secs => greatest(0,
      coalesce((v.delay_config->>'seconds')::integer,0)
      + coalesce((v.delay_config->>'minutes')::integer,0)*60
      + coalesce((v.delay_config->>'hours')::integer,0)*3600
      + coalesce((v.delay_config->>'days')::integer,0)*86400
    )),
    r.priority
  from public.automation_rules r
  join public.automation_versions v
    on v.tenant_id=r.tenant_id and v.automation_id=r.id and v.version=r.current_version
  where r.tenant_id=p_tenant_id and r.status='active' and r.trigger_key=p_event_key
    and coalesce((p_input->>'automation_depth')::integer,0) < 5
  on conflict(tenant_id,automation_id,trigger_event_id) do nothing;
  get diagnostics v_count=row_count;
  return v_count;
end
$$;

create or replace function public.claim_automation_runs(p_worker text,p_limit integer default 25)
returns setof public.automation_runs
language plpgsql security definer set search_path=public
as $$
begin
  return query
  with picked as (
    select id from public.automation_runs
    where status in ('pending','failed') and available_at<=now() and attempts<10
    order by priority asc,created_at asc
    for update skip locked
    limit greatest(1,least(p_limit,100))
  )
  update public.automation_runs r
  set status='processing',started_at=coalesce(r.started_at,now()),attempts=r.attempts+1,
      locked_at=now(),locked_by=p_worker,error=null
  from picked
  where r.id=picked.id
  returning r.*;
end
$$;

create or replace function public.emit_customer_automation_event()
returns trigger
language plpgsql security definer set search_path=public
as $$
begin
  if tg_op='INSERT' then
    perform public.enqueue_automation_event(new.tenant_id,'customer.created','customer:'||new.id::text||':created','customer',new.id,to_jsonb(new));
  elsif tg_op='UPDATE' and (not old.do_not_call and new.do_not_call or not old.do_not_sms and new.do_not_sms or not old.do_not_email and new.do_not_email) then
    perform public.enqueue_automation_event(new.tenant_id,'customer.blocked','customer:'||new.id::text||':blocked:'||extract(epoch from new.updated_at)::text,'customer',new.id,jsonb_build_object('before',to_jsonb(old),'after',to_jsonb(new)));
  end if;
  return new;
end
$$;
drop trigger if exists customers_automation_events on public.customers;
create trigger customers_automation_events after insert or update on public.customers
for each row execute function public.emit_customer_automation_event();

create or replace function public.emit_call_automation_event()
returns trigger
language plpgsql security definer set search_path=public
as $$
declare v_event text;
begin
  if old.status is not distinct from new.status then return new; end if;
  v_event := case
    when new.status='completed' then 'call.completed'
    when new.status='no_answer' then 'call.no_answer'
    when new.status='busy' then 'call.busy'
    when new.status='answered' then 'call.answered'
    else null
  end;
  if v_event is not null then
    perform public.enqueue_automation_event(new.tenant_id,v_event,'call:'||new.id::text||':'||new.status||':'||extract(epoch from new.updated_at)::text,'customer',new.customer_id,jsonb_build_object('call_id',new.id,'customer_id',new.customer_id,'status',new.status,'disposition',new.disposition));
  end if;
  return new;
end
$$;
drop trigger if exists calls_automation_events on public.calls;
create trigger calls_automation_events after update of status on public.calls
for each row execute function public.emit_call_automation_event();

create or replace function public.emit_contract_automation_event()
returns trigger
language plpgsql security definer set search_path=public
as $$
begin
  perform public.enqueue_automation_event(new.tenant_id,new.event_type,'contract_event:'||new.id::text,'contract',new.contract_id,new.payload||jsonb_build_object('contract_id',new.contract_id));
  return new;
end
$$;
drop trigger if exists contract_events_automation_events on public.contract_events;
create trigger contract_events_automation_events after insert on public.contract_events
for each row execute function public.emit_contract_automation_event();

revoke all on function public.enqueue_automation_event(uuid,text,text,text,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.claim_automation_runs(text,integer) from public,anon,authenticated;
grant execute on function public.enqueue_automation_event(uuid,text,text,text,uuid,jsonb) to service_role;
grant execute on function public.claim_automation_runs(text,integer) to service_role;

commit;
