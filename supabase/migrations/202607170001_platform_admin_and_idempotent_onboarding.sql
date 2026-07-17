begin;

-- Platform administration is deliberately separate from tenant roles.
do $$
begin
  create type public.platform_role as enum (
    'platform_owner',
    'platform_admin',
    'platform_support',
    'platform_auditor'
  );
exception
  when duplicate_object then null;
end
$$;

create table if not exists public.platform_memberships (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role public.platform_role not null,
  status text not null default 'active' check (status in ('active','suspended','removed')),
  permissions jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.platform_audit_logs (
  id bigint generated always as identity primary key,
  actor_user_id uuid references auth.users(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id text,
  tenant_id uuid references public.tenants(id) on delete set null,
  reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists platform_memberships_role_status_idx
  on public.platform_memberships(role,status);
create index if not exists platform_audit_logs_created_idx
  on public.platform_audit_logs(created_at desc);
create index if not exists platform_audit_logs_tenant_idx
  on public.platform_audit_logs(tenant_id,created_at desc)
  where tenant_id is not null;

alter table public.platform_memberships enable row level security;
alter table public.platform_memberships force row level security;
alter table public.platform_audit_logs enable row level security;
alter table public.platform_audit_logs force row level security;

create or replace function public.is_platform_role(
  p_roles public.platform_role[] default array[
    'platform_owner'::public.platform_role,
    'platform_admin'::public.platform_role
  ]
)
returns boolean
language sql
stable
security definer
set search_path=public
as $$
  select exists (
    select 1
    from public.platform_memberships pm
    where pm.user_id=auth.uid()
      and pm.status='active'
      and (p_roles is null or pm.role=any(p_roles))
  )
$$;

revoke all on function public.is_platform_role(public.platform_role[]) from public,anon;
grant execute on function public.is_platform_role(public.platform_role[]) to authenticated,service_role;

create policy platform_memberships_read
on public.platform_memberships
for select
to authenticated
using (
  user_id=auth.uid()
  or public.is_platform_role(array[
    'platform_owner'::public.platform_role,
    'platform_admin'::public.platform_role,
    'platform_auditor'::public.platform_role
  ])
);

create policy platform_audit_logs_read
on public.platform_audit_logs
for select
to authenticated
using (
  public.is_platform_role(array[
    'platform_owner'::public.platform_role,
    'platform_admin'::public.platform_role,
    'platform_auditor'::public.platform_role
  ])
);

-- Platform role changes are only possible through this audited RPC.
create or replace function public.set_platform_membership(
  p_user_id uuid,
  p_role public.platform_role,
  p_status text default 'active',
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path=public
as $$
declare
  v_actor uuid:=auth.uid();
  v_before jsonb;
  v_active_owner_count integer;
begin
  if v_actor is null then raise exception 'authentication_required'; end if;
  if not public.is_platform_role(array['platform_owner'::public.platform_role]) then
    raise exception 'platform_owner_required';
  end if;
  if p_status not in ('active','suspended','removed') then raise exception 'invalid_platform_status'; end if;
  if nullif(trim(coalesce(p_reason,'')),'') is null then raise exception 'reason_required'; end if;
  if not exists(select 1 from auth.users where id=p_user_id) then raise exception 'user_not_found'; end if;

  select to_jsonb(pm) into v_before from public.platform_memberships pm where pm.user_id=p_user_id;

  if v_before is not null
     and (v_before->>'role')='platform_owner'
     and (v_before->>'status')='active'
     and (p_role<>'platform_owner'::public.platform_role or p_status<>'active') then
    select count(*) into v_active_owner_count
    from public.platform_memberships
    where role='platform_owner' and status='active' and user_id<>p_user_id;
    if v_active_owner_count=0 then raise exception 'last_platform_owner_cannot_be_removed'; end if;
  end if;

  insert into public.platform_memberships(user_id,role,status,created_by,updated_at)
  values(p_user_id,p_role,p_status,v_actor,now())
  on conflict(user_id) do update set
    role=excluded.role,
    status=excluded.status,
    updated_at=now();

  insert into public.platform_audit_logs(actor_user_id,action,entity_type,entity_id,reason,metadata)
  values(
    v_actor,
    'platform_membership.changed',
    'platform_membership',
    p_user_id::text,
    p_reason,
    jsonb_build_object('before',v_before,'role',p_role,'status',p_status)
  );
end
$$;

revoke all on function public.set_platform_membership(uuid,public.platform_role,text,text) from public,anon;
grant execute on function public.set_platform_membership(uuid,public.platform_role,text,text) to authenticated;

create or replace function public.set_tenant_platform_status(
  p_tenant_id uuid,
  p_status text,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path=public
as $$
declare
  v_actor uuid:=auth.uid();
  v_before text;
begin
  if v_actor is null then raise exception 'authentication_required'; end if;
  if not public.is_platform_role(array[
    'platform_owner'::public.platform_role,
    'platform_admin'::public.platform_role
  ]) then raise exception 'platform_admin_required'; end if;
  if p_status not in ('trial','active','suspended','cancelled') then raise exception 'invalid_tenant_status'; end if;
  if nullif(trim(coalesce(p_reason,'')),'') is null then raise exception 'reason_required'; end if;

  select status into v_before from public.tenants where id=p_tenant_id for update;
  if not found then raise exception 'tenant_not_found'; end if;

  update public.tenants set status=p_status,updated_at=now() where id=p_tenant_id;
  insert into public.platform_audit_logs(actor_user_id,action,entity_type,entity_id,tenant_id,reason,metadata)
  values(
    v_actor,
    'tenant.status_changed',
    'tenant',
    p_tenant_id::text,
    p_tenant_id,
    p_reason,
    jsonb_build_object('before',v_before,'after',p_status)
  );
end
$$;

revoke all on function public.set_tenant_platform_status(uuid,text,text) from public,anon;
grant execute on function public.set_tenant_platform_status(uuid,text,text) to authenticated;

-- Make the tenant trigger itself safe if it is ever retried or installed twice.
create or replace function public.bootstrap_tenant_defaults()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
declare
  v_pipeline uuid;
begin
  insert into public.customer_statuses(tenant_id,key,label,color,sort_order,is_system)
  values
    (new.id,'new','Nytt prospekt','#64748b',10,true),
    (new.id,'assigned','Tilldelad','#6366f1',20,true),
    (new.id,'contacting','Kontaktförsök','#f59e0b',30,true),
    (new.id,'qualified','Kvalificerad','#06b6d4',40,true),
    (new.id,'interested','Intresserad','#8b5cf6',50,true),
    (new.id,'contract_sent','Avtal skickat','#3b82f6',60,true),
    (new.id,'signed','Signerat','#10b981',70,true),
    (new.id,'lost','Förlorad','#ef4444',80,true),
    (new.id,'blocked','Spärrad','#111827',90,true)
  on conflict(tenant_id,key) do update set
    label=excluded.label,
    color=excluded.color,
    sort_order=excluded.sort_order,
    is_system=true;

  insert into public.pipelines(tenant_id,name,pipeline_type,active)
  values(new.id,'Nyförsäljning','new_sales',true)
  on conflict(tenant_id,name) do update set active=true
  returning id into v_pipeline;

  insert into public.pipeline_stages(tenant_id,pipeline_id,name,sort_order,probability,color,is_won,is_lost)
  values
    (new.id,v_pipeline,'Nytt lead',10,5,'#64748b',false,false),
    (new.id,v_pipeline,'Kontaktförsök',20,15,'#f59e0b',false,false),
    (new.id,v_pipeline,'Kontaktad',30,25,'#06b6d4',false,false),
    (new.id,v_pipeline,'Kvalificerad',40,45,'#8b5cf6',false,false),
    (new.id,v_pipeline,'Offert',50,65,'#3b82f6',false,false),
    (new.id,v_pipeline,'Avtal skickat',60,80,'#2563eb',false,false),
    (new.id,v_pipeline,'Signerat',70,100,'#10b981',true,false),
    (new.id,v_pipeline,'Förlorad',80,0,'#ef4444',false,true)
  on conflict(pipeline_id,sort_order) do update set
    name=excluded.name,
    probability=excluded.probability,
    color=excluded.color,
    is_won=excluded.is_won,
    is_lost=excluded.is_lost;

  return new;
end
$$;

-- Full idempotent repair for tenants created by older code or interrupted onboarding.
create or replace function public.ensure_tenant_defaults(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path=public
as $$
declare
  v_tenant public.tenants%rowtype;
  v_pipeline uuid;
begin
  if not (
    public.is_tenant_admin(p_tenant_id)
    or public.is_platform_role(array[
      'platform_owner'::public.platform_role,
      'platform_admin'::public.platform_role
    ])
  ) then raise exception 'admin_required'; end if;

  select * into v_tenant from public.tenants where id=p_tenant_id;
  if not found then raise exception 'tenant_not_found'; end if;

  insert into public.tenant_settings(tenant_id) values(p_tenant_id)
  on conflict(tenant_id) do nothing;

  insert into public.tenant_legal_entities(
    tenant_id,legal_name,organization_number,country_code,is_default,active
  ) values(
    p_tenant_id,v_tenant.legal_name,v_tenant.organization_number,v_tenant.country_code,true,true
  ) on conflict do nothing;

  insert into public.tenant_features(tenant_id,feature_key,enabled,configuration)
  select p_tenant_id,v.feature_key,v.enabled,'{}'::jsonb
  from (values
    ('crm',true),('contracts',true),('automations',true),
    ('outbound_calls',false),('inbound_calls',false),
    ('outbound_sms',false),('inbound_sms',false),
    ('outbound_email',false),('call_recording',false),
    ('web_acceptance',true),('sms_acceptance',false),
    ('contract_delivery_sms',false),('contract_delivery_email',false),
    ('data_enrichment',false),('mass_campaigns',false),('exports',false)
  ) as v(feature_key,enabled)
  on conflict(tenant_id,feature_key) do nothing;

  insert into public.customer_statuses(tenant_id,key,label,color,sort_order,is_system)
  values
    (p_tenant_id,'new','Nytt prospekt','#64748b',10,true),
    (p_tenant_id,'assigned','Tilldelad','#6366f1',20,true),
    (p_tenant_id,'contacting','Kontaktförsök','#f59e0b',30,true),
    (p_tenant_id,'qualified','Kvalificerad','#06b6d4',40,true),
    (p_tenant_id,'interested','Intresserad','#8b5cf6',50,true),
    (p_tenant_id,'contract_sent','Avtal skickat','#3b82f6',60,true),
    (p_tenant_id,'signed','Signerat','#10b981',70,true),
    (p_tenant_id,'lost','Förlorad','#ef4444',80,true),
    (p_tenant_id,'blocked','Spärrad','#111827',90,true)
  on conflict(tenant_id,key) do nothing;

  insert into public.pipelines(tenant_id,name,pipeline_type,active)
  values(p_tenant_id,'Nyförsäljning','new_sales',true)
  on conflict(tenant_id,name) do update set active=true
  returning id into v_pipeline;

  insert into public.pipeline_stages(tenant_id,pipeline_id,name,sort_order,probability,color,is_won,is_lost)
  values
    (p_tenant_id,v_pipeline,'Nytt lead',10,5,'#64748b',false,false),
    (p_tenant_id,v_pipeline,'Kontaktförsök',20,15,'#f59e0b',false,false),
    (p_tenant_id,v_pipeline,'Kontaktad',30,25,'#06b6d4',false,false),
    (p_tenant_id,v_pipeline,'Kvalificerad',40,45,'#8b5cf6',false,false),
    (p_tenant_id,v_pipeline,'Offert',50,65,'#3b82f6',false,false),
    (p_tenant_id,v_pipeline,'Avtal skickat',60,80,'#2563eb',false,false),
    (p_tenant_id,v_pipeline,'Signerat',70,100,'#10b981',true,false),
    (p_tenant_id,v_pipeline,'Förlorad',80,0,'#ef4444',false,true)
  on conflict(pipeline_id,sort_order) do nothing;
end
$$;

revoke all on function public.ensure_tenant_defaults(uuid) from public,anon;
grant execute on function public.ensure_tenant_defaults(uuid) to authenticated;

-- Onboarding is serialized per user and safe to replay after a network timeout.
create or replace function public.create_tenant_with_owner(
  p_name text,
  p_legal_name text,
  p_organization_number text default null
)
returns uuid
language plpgsql
security definer
set search_path=public
as $$
declare
  v_user uuid:=auth.uid();
  v_tenant uuid;
  v_team uuid;
  v_slug text;
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  if nullif(trim(coalesce(p_name,'')),'') is null then raise exception 'tenant_name_required'; end if;
  if nullif(trim(coalesce(p_legal_name,'')),'') is null then raise exception 'legal_name_required'; end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user::text,0));

  select p.active_tenant_id into v_tenant
  from public.profiles p
  join public.tenant_memberships m
    on m.tenant_id=p.active_tenant_id
   and m.user_id=p.id
   and m.status='active'
  where p.id=v_user
    and p.active_tenant_id is not null
  limit 1;

  if v_tenant is not null then
    perform public.ensure_tenant_defaults(v_tenant);
    return v_tenant;
  end if;

  v_slug:=trim(both '-' from regexp_replace(lower(trim(p_name)),'[^a-z0-9]+','-','g'))
    || '-' || substr(replace(gen_random_uuid()::text,'-',''),1,6);

  insert into public.tenants(slug,name,legal_name,organization_number)
  values(v_slug,trim(p_name),trim(p_legal_name),nullif(trim(coalesce(p_organization_number,'')),''))
  returning id into v_tenant;

  insert into public.tenant_memberships(tenant_id,user_id,role,status,joined_at)
  values(v_tenant,v_user,'owner','active',now())
  on conflict(tenant_id,user_id) do update set
    role='owner',status='active',joined_at=coalesce(public.tenant_memberships.joined_at,now()),updated_at=now();

  insert into public.teams(tenant_id,name,is_default)
  values(v_tenant,'Huvudteam',true)
  on conflict(tenant_id,name) do update set is_default=true
  returning id into v_team;

  insert into public.team_members(tenant_id,team_id,user_id,role)
  values(v_tenant,v_team,v_user,'manager')
  on conflict(team_id,user_id) do update set role='manager';

  insert into public.tenant_settings(tenant_id)
  values(v_tenant)
  on conflict(tenant_id) do nothing;

  insert into public.tenant_features(tenant_id,feature_key,enabled,configuration)
  select v_tenant,v.feature_key,v.enabled,'{}'::jsonb
  from (values
    ('crm',true),('contracts',true),('automations',true),
    ('outbound_calls',false),('inbound_calls',false),
    ('outbound_sms',false),('inbound_sms',false),
    ('outbound_email',false),('call_recording',false),
    ('web_acceptance',true),('sms_acceptance',false),
    ('contract_delivery_sms',false),('contract_delivery_email',false),
    ('data_enrichment',false),('mass_campaigns',false),('exports',false)
  ) as v(feature_key,enabled)
  on conflict(tenant_id,feature_key) do nothing;

  update public.profiles set active_tenant_id=v_tenant,updated_at=now() where id=v_user;

  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
  values(v_tenant,v_user,'tenant.created','tenant',v_tenant::text,jsonb_build_object('name',trim(p_name),'legal_name',trim(p_legal_name)));

  return v_tenant;
end
$$;

revoke all on function public.create_tenant_with_owner(text,text,text) from public,anon;
grant execute on function public.create_tenant_with_owner(text,text,text) to authenticated;

commit;
