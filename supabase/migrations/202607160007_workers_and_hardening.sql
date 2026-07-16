begin;

alter table public.phone_numbers add column if not exists webhook_token_ciphertext text;
alter table public.phone_numbers add column if not exists routing_config jsonb not null default '{}'::jsonb;

create table public.rate_limit_counters (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  bucket_key text not null,
  window_started_at timestamptz not null,
  request_count integer not null default 0,
  primary key(tenant_id,bucket_key,window_started_at)
);
alter table public.rate_limit_counters enable row level security;

create or replace function public.claim_outbox_jobs(p_worker text, p_limit integer default 25)
returns setof public.outbox_jobs
language plpgsql security definer set search_path=public
as $$
begin
  return query
  with picked as (
    select id from public.outbox_jobs
    where status in ('pending','failed') and available_at <= now() and attempts < max_attempts
    order by priority asc, created_at asc
    for update skip locked
    limit greatest(1,least(p_limit,100))
  )
  update public.outbox_jobs j
  set status='processing', locked_at=now(), locked_by=p_worker, attempts=j.attempts+1
  from picked
  where j.id=picked.id
  returning j.*;
end $$;

create or replace function public.complete_outbox_job(p_job_id uuid)
returns void language sql security definer set search_path=public
as $$ update public.outbox_jobs set status='completed',completed_at=now(),locked_at=null,locked_by=null,last_error=null where id=p_job_id $$;

create or replace function public.fail_outbox_job(p_job_id uuid,p_error text,p_delay_seconds integer default 60)
returns void language plpgsql security definer set search_path=public
as $$
begin
 update public.outbox_jobs set
   status=case when attempts>=max_attempts then 'dead_letter'::public.job_status else 'failed'::public.job_status end,
   last_error=left(p_error,4000), available_at=now()+make_interval(secs=>greatest(1,p_delay_seconds)), locked_at=null,locked_by=null
 where id=p_job_id;
end $$;

create or replace function public.increment_usage(p_tenant_id uuid,p_metric text,p_amount numeric default 1)
returns void language plpgsql security definer set search_path=public
as $$
declare v_limit numeric; v_current numeric;
begin
  insert into public.usage_limits(tenant_id,metric,period,current_value,period_started_at)
  values(p_tenant_id,p_metric,'month',0,date_trunc('month',now()))
  on conflict(tenant_id,metric,period) do update set
    current_value=case when public.usage_limits.period_started_at<date_trunc('month',now()) then 0 else public.usage_limits.current_value end,
    period_started_at=date_trunc('month',now());
  select hard_limit,current_value into v_limit,v_current from public.usage_limits where tenant_id=p_tenant_id and metric=p_metric and period='month' for update;
  if v_limit is not null and v_current+p_amount>v_limit then raise exception 'usage_limit_exceeded:%',p_metric; end if;
  update public.usage_limits set current_value=current_value+p_amount,updated_at=now() where tenant_id=p_tenant_id and metric=p_metric and period='month';
end $$;

create or replace function public.consume_rate_limit(p_tenant_id uuid,p_bucket text,p_limit integer,p_window_seconds integer default 60)
returns boolean language plpgsql security definer set search_path=public
as $$
declare v_window timestamptz; v_count integer;
begin
 v_window:=to_timestamp(floor(extract(epoch from now())/p_window_seconds)*p_window_seconds);
 insert into public.rate_limit_counters(tenant_id,bucket_key,window_started_at,request_count) values(p_tenant_id,p_bucket,v_window,1)
 on conflict(tenant_id,bucket_key,window_started_at) do update set request_count=public.rate_limit_counters.request_count+1
 returning request_count into v_count;
 return v_count<=p_limit;
end $$;

create index if not exists contracts_tenant_status_idx on public.contracts(tenant_id,status,created_at desc);
create index if not exists acceptance_pending_idx on public.contract_acceptance_requests(tenant_id,status,expires_at);
create index if not exists compliance_phone_idx on public.compliance_blocks(tenant_id,phone_e164) where active;
create index if not exists campaigns_status_idx on public.campaigns(tenant_id,status,starts_at);
create index if not exists deals_stage_idx on public.deals(tenant_id,pipeline_id,stage_id,status);

commit;
