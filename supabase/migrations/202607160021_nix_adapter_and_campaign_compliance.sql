begin;

create table public.nix_provider_configurations (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null, status text not null default 'inactive' check(status in ('active','paused','inactive')),
  endpoint_template text not null, method text not null default 'GET' check(method in ('GET','POST')),
  allowed_domains text[] not null default '{}', allowed_paths text[] not null default '{}',
  credentials_ciphertext text, request_configuration jsonb not null default '{}', result_path text not null default 'result',
  result_mapping jsonb not null default '{"listed":"listed","not_listed":"not_listed","unknown":"unknown"}'::jsonb,
  validity_days integer not null default 60 check(validity_days between 1 and 365), timeout_ms integer not null default 15000 check(timeout_ms between 1000 and 120000),
  max_retries integer not null default 5 check(max_retries between 0 and 20), created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(tenant_id,name), unique(tenant_id,id)
);
create table public.nix_check_jobs (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  configuration_id uuid not null, customer_id uuid not null, phone_e164 text not null,
  status text not null default 'queued' check(status in ('queued','running','completed','failed','dead')),
  idempotency_key text not null, attempts integer not null default 0, next_attempt_at timestamptz not null default now(),
  locked_at timestamptz, locked_by text, last_error text, requested_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(), completed_at timestamptz, unique(tenant_id,id), unique(tenant_id,idempotency_key),
  foreign key(tenant_id,configuration_id) references public.nix_provider_configurations(tenant_id,id) on delete cascade,
  foreign key(tenant_id,customer_id) references public.customers(tenant_id,id) on delete cascade
);
create unique index nix_check_jobs_active_phone_idx on public.nix_check_jobs(tenant_id,phone_e164) where status in ('queued','running');
create table public.campaign_contact_candidates (
  tenant_id uuid not null references public.tenants(id) on delete cascade, campaign_id uuid not null, customer_id uuid not null,
  segment_id uuid, status text not null default 'pending' check(status in ('pending','pending_nix','approved','blocked')),
  policy_reason text, evaluated_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  primary key(campaign_id,customer_id), foreign key(tenant_id,campaign_id) references public.campaigns(tenant_id,id) on delete cascade,
  foreign key(tenant_id,customer_id) references public.customers(tenant_id,id) on delete cascade,
  foreign key(tenant_id,segment_id) references public.segments(tenant_id,id) on delete set null
);

alter table public.nix_provider_configurations enable row level security;
alter table public.nix_check_jobs enable row level security;
alter table public.campaign_contact_candidates enable row level security;
create policy nix_provider_configurations_admin on public.nix_provider_configurations for all to authenticated using(tenant_id=public.current_tenant_id() and public.is_tenant_admin(tenant_id)) with check(tenant_id=public.current_tenant_id() and public.is_tenant_admin(tenant_id));
create policy nix_check_jobs_member_select on public.nix_check_jobs for select to authenticated using(tenant_id=public.current_tenant_id() and public.is_tenant_member(tenant_id));
create policy nix_check_jobs_admin_write on public.nix_check_jobs for all to authenticated using(tenant_id=public.current_tenant_id() and public.is_tenant_admin(tenant_id)) with check(tenant_id=public.current_tenant_id() and public.is_tenant_admin(tenant_id));
create policy campaign_contact_candidates_member_select on public.campaign_contact_candidates for select to authenticated using(tenant_id=public.current_tenant_id() and public.is_tenant_member(tenant_id));
create policy campaign_contact_candidates_admin_write on public.campaign_contact_candidates for all to authenticated using(tenant_id=public.current_tenant_id() and public.is_tenant_admin(tenant_id)) with check(tenant_id=public.current_tenant_id() and public.is_tenant_admin(tenant_id));

create trigger nix_provider_configurations_touch before update on public.nix_provider_configurations for each row execute function public.touch_updated_at();
create trigger campaign_contact_candidates_touch before update on public.campaign_contact_candidates for each row execute function public.touch_updated_at();

create or replace function public.queue_nix_check_for_customer(p_tenant_id uuid,p_customer_id uuid,p_requested_by uuid default null,p_force boolean default false)
returns uuid language plpgsql security definer set search_path=public as $$
declare c public.customers%rowtype; cfg uuid; jid uuid; idem text;
begin
  select * into c from public.customers where tenant_id=p_tenant_id and id=p_customer_id and deleted_at is null;
  if not found or c.customer_type<>'person' or c.phone_e164 is null then return null; end if;
  if not p_force and exists(select 1 from public.nix_checks where tenant_id=p_tenant_id and phone_e164=c.phone_e164 and valid_until>now() and result<>'error') then return null; end if;
  select id into cfg from public.nix_provider_configurations where tenant_id=p_tenant_id and status='active' order by updated_at desc limit 1;
  if cfg is null then raise exception 'nix_provider_not_configured'; end if;
  idem:='nix:'||c.phone_e164||':'||to_char(current_date,'YYYY-MM');
  insert into public.nix_check_jobs(tenant_id,configuration_id,customer_id,phone_e164,idempotency_key,requested_by)
  values(p_tenant_id,cfg,c.id,c.phone_e164,idem,p_requested_by)
  on conflict(tenant_id,idempotency_key) do update set next_attempt_at=least(public.nix_check_jobs.next_attempt_at,now()) returning id into jid;
  return jid;
end $$;

create or replace function public.queue_due_nix_checks(p_limit integer default 100)
returns integer language plpgsql security definer set search_path=public as $$
declare r record; n integer:=0;
begin
  for r in select c.tenant_id,c.id from public.customers c where c.customer_type='person' and c.phone_e164 is not null and c.deleted_at is null and not c.do_not_call
    and exists(select 1 from public.nix_provider_configurations cfg where cfg.tenant_id=c.tenant_id and cfg.status='active')
    and not exists(select 1 from public.nix_checks nx where nx.tenant_id=c.tenant_id and nx.phone_e164=c.phone_e164 and nx.valid_until>now() and nx.result<>'error')
    and not exists(select 1 from public.nix_check_jobs j where j.tenant_id=c.tenant_id and j.phone_e164=c.phone_e164 and j.status in ('queued','running'))
    order by c.updated_at desc limit greatest(1,least(p_limit,1000))
  loop perform public.queue_nix_check_for_customer(r.tenant_id,r.id,null,false); n:=n+1; end loop;
  return n;
end $$;

create or replace function public.claim_nix_check_jobs(p_worker text,p_limit integer default 20)
returns setof public.nix_check_jobs language plpgsql security definer set search_path=public as $$
begin
 return query with picked as (select id from public.nix_check_jobs where status in ('queued','failed') and next_attempt_at<=now() and (locked_at is null or locked_at<now()-interval '15 minutes') order by created_at limit greatest(1,least(p_limit,100)) for update skip locked)
 update public.nix_check_jobs j set status='running',attempts=attempts+1,locked_at=now(),locked_by=left(p_worker,200) from picked where j.id=picked.id returning j.*;
end $$;

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
    else update public.campaign_contact_candidates set status='blocked',policy_reason=policy->>'reason',evaluated_at=now() where campaign_id=candidate.campaign_id and customer_id=j.customer_id; end if;
  end loop;
end $$;

create or replace function public.fail_nix_check_job(p_job_id uuid,p_error text,p_retryable boolean default true)
returns void language plpgsql security definer set search_path=public as $$
declare j public.nix_check_jobs%rowtype; cfg public.nix_provider_configurations%rowtype; terminal boolean;
begin
 select * into j from public.nix_check_jobs where id=p_job_id for update; if not found then return; end if; select * into cfg from public.nix_provider_configurations where id=j.configuration_id;
 terminal:=not p_retryable or j.attempts>=cfg.max_retries;
 update public.nix_check_jobs set status=case when terminal then 'dead' else 'failed' end,next_attempt_at=case when terminal then next_attempt_at else now()+make_interval(secs=>least(3600,power(2,attempts)::integer*30)) end,locked_at=null,locked_by=null,last_error=left(p_error,4000),completed_at=case when terminal then now() else null end where id=j.id;
end $$;

create or replace function public.materialize_segment_to_campaign(p_segment_id uuid,p_campaign_id uuid,p_actor uuid default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare s public.segments%rowtype; snap uuid; r record; cust uuid; created_customers integer:=0; added integer:=0; pending_nix integer:=0; blocked integer:=0; policy jsonb;
begin
  select * into s from public.segments where id=p_segment_id; if not found then raise exception 'segment_not_found'; end if;
  if not exists(select 1 from public.campaigns where id=p_campaign_id and tenant_id=s.tenant_id) then raise exception 'campaign_not_found'; end if;
  perform public.refresh_segment_materialization(s.id,p_actor); select id into snap from public.segment_snapshots where segment_id=s.id order by generated_at desc limit 1;
  for r in select me.* from public.segment_memberships sm join public.master_entities me on me.id=sm.master_entity_id where sm.snapshot_id=snap loop
    select customer_id into cust from public.tenant_entities where tenant_id=s.tenant_id and master_entity_id=r.id;
    if cust is null then
      insert into public.customers(tenant_id,customer_type,display_name,organization_number,email,phone_e164,address_line1,postal_code,city,lifecycle,campaign_id,source_name,source_external_id,created_by)
      values(s.tenant_id,case when r.entity_type='person' then 'person'::public.customer_type else 'company'::public.customer_type end,r.canonical_name,r.organization_number,r.email,r.phone_e164,r.address_line1,r.postal_code,r.city,'prospect',p_campaign_id,'Kundexa directory',r.id::text,p_actor) returning id into cust;
      insert into public.tenant_entities(tenant_id,master_entity_id,customer_id,relationship,created_by) values(s.tenant_id,r.id,cust,'prospect',p_actor) on conflict(tenant_id,master_entity_id) do update set customer_id=excluded.customer_id,updated_at=now(); created_customers:=created_customers+1;
    end if;
    policy:=public.evaluate_contact_policy_for_tenant(s.tenant_id,cust,'call','direct_marketing');
    insert into public.campaign_contact_candidates(tenant_id,campaign_id,customer_id,segment_id,status,policy_reason,evaluated_at)
    values(s.tenant_id,p_campaign_id,cust,s.id,case when policy->>'allowed'='true' then 'approved' when policy->>'reason'='nix_check_required' then 'pending_nix' else 'blocked' end,policy->>'reason',now())
    on conflict(campaign_id,customer_id) do update set segment_id=excluded.segment_id,status=excluded.status,policy_reason=excluded.policy_reason,evaluated_at=now(),updated_at=now();
    if policy->>'allowed'='true' then insert into public.campaign_members(tenant_id,campaign_id,customer_id) values(s.tenant_id,p_campaign_id,cust) on conflict do nothing; if found then added:=added+1; end if;
    elsif policy->>'reason'='nix_check_required' then perform public.queue_nix_check_for_customer(s.tenant_id,cust,p_actor,false); pending_nix:=pending_nix+1;
    else blocked:=blocked+1; end if;
  end loop;
  return jsonb_build_object('snapshotId',snap,'createdCustomers',created_customers,'addedToCampaign',added,'pendingNix',pending_nix,'blocked',blocked);
end $$;

revoke all on function public.queue_due_nix_checks(integer),public.claim_nix_check_jobs(text,integer),public.complete_nix_check_job(uuid,text,text,jsonb),public.fail_nix_check_job(uuid,text,boolean) from public,anon,authenticated;
grant execute on function public.queue_due_nix_checks(integer),public.claim_nix_check_jobs(text,integer),public.complete_nix_check_job(uuid,text,text,jsonb),public.fail_nix_check_job(uuid,text,boolean) to service_role;
revoke all on function public.queue_nix_check_for_customer(uuid,uuid,uuid,boolean) from public,anon;
grant execute on function public.queue_nix_check_for_customer(uuid,uuid,uuid,boolean) to authenticated,service_role;
grant execute on function public.materialize_segment_to_campaign(uuid,uuid,uuid) to authenticated,service_role;

commit;
