begin;

-- Organization structure and legal sender identity are explicit tenant-owned records.
create table public.tenant_legal_entities (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  legal_name text not null,
  organization_number text,
  country_code text not null default 'SE',
  address_line1 text,
  postal_code text,
  city text,
  email citext,
  phone_e164 text,
  website text,
  branding jsonb not null default '{}'::jsonb,
  legal_metadata jsonb not null default '{}'::jsonb,
  is_default boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id,id)
);
create unique index tenant_legal_entities_one_default_idx
  on public.tenant_legal_entities(tenant_id) where is_default and active;

create table public.offices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  address_line1 text,
  postal_code text,
  city text,
  country_code text not null default 'SE',
  timezone text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id,name),
  unique (tenant_id,id)
);

create table public.departments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  office_id uuid,
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id,name),
  unique (tenant_id,id),
  foreign key (tenant_id,office_id) references public.offices(tenant_id,id) on delete set null
);

alter table public.teams
  add column if not exists office_id uuid,
  add column if not exists department_id uuid;
alter table public.teams add constraint teams_office_tenant_fk
  foreign key (tenant_id,office_id) references public.offices(tenant_id,id) on delete set null;
alter table public.teams add constraint teams_department_tenant_fk
  foreign key (tenant_id,department_id) references public.departments(tenant_id,id) on delete set null;

alter table public.contract_templates
  add column if not exists legal_entity_id uuid,
  add column if not exists current_version_id uuid,
  add column if not exists description text;

alter table public.contract_template_versions
  add column if not exists status text not null default 'draft'
    check (status in ('draft','approved','retired')),
  add column if not exists variables_schema jsonb not null default '{}'::jsonb,
  add column if not exists approved_by uuid references auth.users(id) on delete set null,
  add column if not exists approved_at timestamptz;

alter table public.contract_templates add constraint contract_templates_legal_entity_tenant_fk
  foreign key (tenant_id,legal_entity_id) references public.tenant_legal_entities(tenant_id,id) on delete set null;
alter table public.contract_templates add constraint contract_templates_current_version_tenant_fk
  foreign key (tenant_id,current_version_id) references public.contract_template_versions(tenant_id,id)
  deferrable initially deferred;

alter table public.contracts
  add column if not exists legal_entity_id uuid,
  add column if not exists seller_snapshot jsonb not null default '{}'::jsonb,
  add column if not exists counterparty_snapshot jsonb not null default '{}'::jsonb;
alter table public.contracts add constraint contracts_legal_entity_tenant_fk
  foreign key (tenant_id,legal_entity_id) references public.tenant_legal_entities(tenant_id,id) on delete restrict;

-- These columns are required by the workers and make every channel request idempotent.
alter table public.sms_messages
  add column if not exists idempotency_key text,
  add column if not exists purpose text not null default 'direct_marketing';
alter table public.email_messages
  add column if not exists idempotency_key text,
  add column if not exists purpose text not null default 'direct_marketing';
alter table public.calls
  add column if not exists idempotency_key text,
  add column if not exists purpose text not null default 'direct_marketing';
alter table public.contract_deliveries add column if not exists idempotency_key text;

create unique index if not exists sms_messages_tenant_idempotency_uidx on public.sms_messages(tenant_id,idempotency_key) where idempotency_key is not null;
create unique index if not exists email_messages_tenant_idempotency_uidx on public.email_messages(tenant_id,idempotency_key) where idempotency_key is not null;
create unique index if not exists calls_tenant_idempotency_uidx on public.calls(tenant_id,idempotency_key) where idempotency_key is not null;
create unique index if not exists contract_deliveries_tenant_idempotency_uidx on public.contract_deliveries(tenant_id,idempotency_key) where idempotency_key is not null;

-- Existing tenants receive an explicit default legal entity and explicit feature switches.
insert into public.tenant_legal_entities(
  tenant_id,legal_name,organization_number,country_code,is_default,active
)
select id,legal_name,organization_number,country_code,true,true from public.tenants
on conflict do nothing;

insert into public.tenant_features(tenant_id,feature_key,enabled,configuration)
select t.id,f.feature_key,false,'{}'::jsonb
from public.tenants t
cross join (values
  ('outbound_calls'),('outbound_sms'),('outbound_email'),
  ('contract_delivery_sms'),('contract_delivery_email'),
  ('call_recording'),('data_enrichment'),('mass_campaigns'),('exports')
) as f(feature_key)
on conflict (tenant_id,feature_key) do nothing;

-- New tenants receive the same defaults. Existing bootstrap data remains untouched.
create or replace function public.bootstrap_operational_defaults() returns trigger
language plpgsql security definer set search_path=public
as $$
begin
  insert into public.tenant_legal_entities(
    tenant_id,legal_name,organization_number,country_code,is_default,active
  ) values (new.id,new.legal_name,new.organization_number,new.country_code,true,true)
  on conflict do nothing;

  insert into public.tenant_features(tenant_id,feature_key,enabled,configuration)
  select new.id,v.feature_key,false,'{}'::jsonb
  from (values
    ('outbound_calls'),('outbound_sms'),('outbound_email'),
    ('contract_delivery_sms'),('contract_delivery_email'),
    ('call_recording'),('data_enrichment'),('mass_campaigns'),('exports')
  ) as v(feature_key)
  on conflict (tenant_id,feature_key) do nothing;
  return new;
end
$$;
create trigger tenant_operational_defaults after insert on public.tenants
  for each row execute function public.bootstrap_operational_defaults();

-- Central policy evaluator. Explicit tenant is service-only; browser-facing callers use
-- queue RPCs that derive the tenant from the authenticated profile.
create or replace function public.evaluate_contact_policy_for_tenant(
  p_tenant_id uuid,
  p_customer_id uuid,
  p_channel text,
  p_purpose text default 'direct_marketing'
)
returns jsonb
language plpgsql stable security definer set search_path=public
as $$
declare
  v_customer public.customers%rowtype;
  v_feature text;
  v_permission_status text;
  v_nix_result text;
  v_timezone text := 'Europe/Stockholm';
  v_compliance jsonb := '{}'::jsonb;
  v_local timestamp;
  v_days jsonb;
  v_start time;
  v_end time;
  v_has_legal_basis boolean := false;
begin
  if p_channel not in ('call','sms','email') then
    return jsonb_build_object('allowed',false,'reason','invalid_channel');
  end if;

  select * into v_customer from public.customers
  where tenant_id=p_tenant_id and id=p_customer_id and deleted_at is null;
  if not found then return jsonb_build_object('allowed',false,'reason','customer_not_found'); end if;

  v_feature := case
    when p_purpose in ('contract_delivery','contract_confirmation') and p_channel='sms' then 'contract_delivery_sms'
    when p_purpose in ('contract_delivery','contract_confirmation') and p_channel='email' then 'contract_delivery_email'
    when p_channel='call' then 'outbound_calls'
    when p_channel='sms' then 'outbound_sms'
    else 'outbound_email'
  end;

  if not exists(
    select 1 from public.tenant_features
    where tenant_id=p_tenant_id and feature_key=v_feature and enabled
  ) then return jsonb_build_object('allowed',false,'reason','feature_disabled','feature',v_feature); end if;

  if (p_channel='call' and v_customer.do_not_call)
     or (p_channel='sms' and v_customer.do_not_sms)
     or (p_channel='email' and v_customer.do_not_email) then
    return jsonb_build_object('allowed',false,'reason','customer_channel_block');
  end if;

  if exists(
    select 1 from public.compliance_blocks b
    where b.tenant_id=p_tenant_id and b.active
      and (b.expires_at is null or b.expires_at>now())
      and p_channel=any(b.channels)
      and (
        b.customer_id=v_customer.id
        or (b.phone_e164 is not null and b.phone_e164 in (v_customer.phone_e164,v_customer.alternate_phone_e164))
        or (b.email is not null and b.email=v_customer.email)
      )
  ) then return jsonb_build_object('allowed',false,'reason','compliance_block'); end if;

  select cp.status into v_permission_status
  from public.contact_permissions cp
  where cp.tenant_id=p_tenant_id and cp.customer_id=p_customer_id and cp.channel=p_channel
    and cp.purpose=p_purpose and cp.valid_from<=now()
    and (cp.valid_until is null or cp.valid_until>now())
  order by cp.created_at desc limit 1;

  if v_permission_status in ('denied','objected','expired') then
    return jsonb_build_object('allowed',false,'reason','contact_permission_'||v_permission_status);
  end if;

  if p_purpose in ('direct_marketing','automation_marketing') then
    if v_customer.marketing_allowed is false then
      return jsonb_build_object('allowed',false,'reason','marketing_not_allowed');
    end if;
    v_has_legal_basis := nullif(trim(coalesce(v_customer.legal_basis,'')),'') is not null
      or v_permission_status='allowed';
    if v_customer.customer_type='person' and not v_has_legal_basis then
      return jsonb_build_object('allowed',false,'reason','legal_basis_required');
    end if;
  end if;

  if p_channel='call' and p_purpose in ('direct_marketing','automation_marketing') then
    select coalesce(t.timezone,'Europe/Stockholm'),coalesce(ts.compliance,'{}'::jsonb)
      into v_timezone,v_compliance
    from public.tenants t left join public.tenant_settings ts on ts.tenant_id=t.id
    where t.id=p_tenant_id;
    v_local := now() at time zone v_timezone;
    v_days := coalesce(v_compliance->'allowed_call_isodow','[1,2,3,4,5]'::jsonb);
    v_start := coalesce(nullif(v_compliance->>'call_start_local','')::time,'08:00'::time);
    v_end := coalesce(nullif(v_compliance->>'call_end_local','')::time,'21:00'::time);
    if not (v_days @> to_jsonb(array[extract(isodow from v_local)::integer]))
       or v_local::time < v_start or v_local::time >= v_end then
      return jsonb_build_object('allowed',false,'reason','outside_contact_hours','timezone',v_timezone);
    end if;

    if v_customer.customer_type='person' then
      select n.result into v_nix_result
      from public.nix_checks n
      where n.tenant_id=p_tenant_id and n.phone_e164=v_customer.phone_e164
        and n.valid_until>now()
      order by n.checked_at desc limit 1;
      if v_nix_result is null then return jsonb_build_object('allowed',false,'reason','nix_check_required'); end if;
      if v_nix_result<>'not_listed' then return jsonb_build_object('allowed',false,'reason','nix_'||v_nix_result); end if;
    end if;
  end if;

  return jsonb_build_object('allowed',true,'reason','allowed','feature',v_feature);
end
$$;

create or replace function public.reserve_usage_for_tenant(
  p_tenant_id uuid,
  p_metric text,
  p_amount numeric default 1
)
returns void
language plpgsql security definer set search_path=public
as $$
declare
  v_limit public.usage_limits%rowtype;
  v_period_start timestamptz;
  v_current numeric;
begin
  if p_amount<=0 then raise exception 'usage_amount_must_be_positive'; end if;
  for v_limit in
    select * from public.usage_limits
    where tenant_id=p_tenant_id and metric=p_metric
    for update
  loop
    v_period_start := case v_limit.period
      when 'day' then date_trunc('day',now())
      when 'month' then date_trunc('month',now())
      else v_limit.period_started_at
    end;
    v_current := case when v_limit.period in ('day','month') and v_limit.period_started_at<v_period_start
      then 0 else v_limit.current_value end;
    if v_limit.hard_limit is not null and v_current+p_amount>v_limit.hard_limit then
      raise exception 'usage_hard_limit_exceeded:%',p_metric;
    end if;
    update public.usage_limits set
      current_value=v_current+p_amount,
      period_started_at=v_period_start,
      updated_at=now()
    where tenant_id=v_limit.tenant_id and metric=v_limit.metric and period=v_limit.period;
  end loop;
end
$$;

create or replace function public.enforce_outbound_contact_policy() returns trigger
language plpgsql security definer set search_path=public
as $$
declare
  v_channel text;
  v_policy jsonb;
  v_amount numeric := 1;
begin
  if tg_table_name='calls' then
    if new.direction<>'outbound' or new.status<>'queued' then return new; end if;
    v_channel := 'call';
  elsif tg_table_name='sms_messages' then
    if new.direction<>'outbound' or new.status<>'queued' then return new; end if;
    v_channel := 'sms';
    v_amount := greatest(1,ceil(length(new.body)::numeric/160));
  elsif tg_table_name='email_messages' then
    if new.direction<>'outbound' or new.status<>'queued' then return new; end if;
    v_channel := 'email';
  else
    raise exception 'unsupported_contact_policy_table';
  end if;

  if tg_table_name in ('sms_messages','email_messages') and new.contract_id is not null and new.purpose='direct_marketing' then
    new.purpose := 'contract_delivery';
  end if;
  if new.customer_id is null then raise exception 'outbound_customer_required'; end if;
  v_policy := public.evaluate_contact_policy_for_tenant(new.tenant_id,new.customer_id,v_channel,new.purpose);
  if not coalesce((v_policy->>'allowed')::boolean,false) then
    raise exception 'contact_not_allowed:%',coalesce(v_policy->>'reason','unknown');
  end if;
  perform public.reserve_usage_for_tenant(
    new.tenant_id,
    case v_channel when 'call' then 'calls_started' when 'sms' then 'sms_parts' else 'emails_sent' end,
    v_amount
  );
  return new;
end
$$;

create trigger calls_contact_policy before insert on public.calls
  for each row execute function public.enforce_outbound_contact_policy();
create trigger sms_contact_policy before insert on public.sms_messages
  for each row execute function public.enforce_outbound_contact_policy();
create trigger email_contact_policy before insert on public.email_messages
  for each row execute function public.enforce_outbound_contact_policy();

-- Atomic manual channel queueing. The row, usage reservation, activity and outbox
-- are committed together or not at all.
create or replace function public.queue_sms_message(
  p_customer_id uuid,
  p_body text,
  p_idempotency_key text,
  p_purpose text default 'direct_marketing'
)
returns uuid
language plpgsql security definer set search_path=public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_user uuid := auth.uid();
  v_customer public.customers%rowtype;
  v_number text;
  v_message uuid;
begin
  if v_user is null or v_tenant is null then raise exception 'authentication_required'; end if;
  if not public.has_current_role(array['owner','admin','team_lead','sales','contract_manager','backoffice']) then raise exception 'message_send_permission_required'; end if;
  if nullif(trim(p_body),'') is null then raise exception 'sms_body_required'; end if;
  if nullif(trim(p_idempotency_key),'') is null then raise exception 'idempotency_key_required'; end if;
  select id into v_message from public.sms_messages where tenant_id=v_tenant and idempotency_key=p_idempotency_key;
  if v_message is not null then return v_message; end if;
  select * into v_customer from public.customers where tenant_id=v_tenant and id=p_customer_id and deleted_at is null;
  if not found or v_customer.phone_e164 is null then raise exception 'customer_phone_missing'; end if;
  if v_customer.phone_e164 !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'customer_phone_invalid'; end if;
  select number_e164 into v_number from public.phone_numbers
    where tenant_id=v_tenant and supports_sms and status='active'
    order by created_at,id limit 1;
  if v_number is null then raise exception 'sms_sender_missing'; end if;
  insert into public.sms_messages(
    tenant_id,customer_id,direction,from_number,to_number,body,status,created_by,idempotency_key,purpose
  ) values (
    v_tenant,p_customer_id,'outbound',v_number,v_customer.phone_e164,p_body,'queued',v_user,p_idempotency_key,p_purpose
  ) returning id into v_message;
  insert into public.outbox_jobs(tenant_id,job_type,aggregate_type,aggregate_id,payload,idempotency_key)
    values(v_tenant,'sms.send','sms_message',v_message,jsonb_build_object('sms_message_id',v_message),'sms.send:'||v_message::text);
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
    values(v_tenant,v_user,'sms.queued','sms_message',v_message::text,jsonb_build_object('customer_id',p_customer_id,'purpose',p_purpose));
  return v_message;
end
$$;

create or replace function public.queue_email_message(
  p_customer_id uuid,
  p_subject text,
  p_body text,
  p_idempotency_key text,
  p_purpose text default 'direct_marketing'
)
returns uuid
language plpgsql security definer set search_path=public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_user uuid := auth.uid();
  v_customer public.customers%rowtype;
  v_message uuid;
begin
  if v_user is null or v_tenant is null then raise exception 'authentication_required'; end if;
  if not public.has_current_role(array['owner','admin','team_lead','sales','contract_manager','backoffice']) then raise exception 'message_send_permission_required'; end if;
  if nullif(trim(p_subject),'') is null or nullif(trim(p_body),'') is null then raise exception 'email_content_required'; end if;
  if nullif(trim(p_idempotency_key),'') is null then raise exception 'idempotency_key_required'; end if;
  select id into v_message from public.email_messages where tenant_id=v_tenant and idempotency_key=p_idempotency_key;
  if v_message is not null then return v_message; end if;
  select * into v_customer from public.customers where tenant_id=v_tenant and id=p_customer_id and deleted_at is null;
  if not found or v_customer.email is null then raise exception 'customer_email_missing'; end if;
  insert into public.email_messages(
    tenant_id,customer_id,direction,from_address,to_addresses,subject,body_text,status,created_by,idempotency_key,purpose
  ) values (
    v_tenant,p_customer_id,'outbound','pending@kundexa.local',array[v_customer.email]::citext[],p_subject,p_body,'queued',v_user,p_idempotency_key,p_purpose
  ) returning id into v_message;
  insert into public.outbox_jobs(tenant_id,job_type,aggregate_type,aggregate_id,payload,idempotency_key)
    values(v_tenant,'email.send','email_message',v_message,jsonb_build_object('email_message_id',v_message),'email.send:'||v_message::text);
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
    values(v_tenant,v_user,'email.queued','email_message',v_message::text,jsonb_build_object('customer_id',p_customer_id,'purpose',p_purpose));
  return v_message;
end
$$;

create or replace function public.queue_outbound_call(
  p_customer_id uuid,
  p_callback_token_hash text,
  p_callback_token text,
  p_voice_client_number text,
  p_idempotency_key text,
  p_purpose text default 'direct_marketing'
)
returns uuid
language plpgsql security definer set search_path=public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_user uuid := auth.uid();
  v_customer public.customers%rowtype;
  v_number public.phone_numbers%rowtype;
  v_call uuid;
begin
  if v_user is null or v_tenant is null then raise exception 'authentication_required'; end if;
  if not public.has_current_role(array['owner','admin','team_lead','sales']) then raise exception 'call_create_permission_required'; end if;
  if nullif(trim(p_callback_token_hash),'') is null or nullif(trim(p_callback_token),'') is null then raise exception 'callback_token_required'; end if;
  if p_voice_client_number !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'voice_client_number_invalid'; end if;
  if nullif(trim(p_idempotency_key),'') is null then raise exception 'idempotency_key_required'; end if;
  select id into v_call from public.calls where tenant_id=v_tenant and idempotency_key=p_idempotency_key;
  if v_call is not null then return v_call; end if;
  select * into v_customer from public.customers where tenant_id=v_tenant and id=p_customer_id and deleted_at is null;
  if not found or v_customer.phone_e164 is null then raise exception 'customer_phone_missing'; end if;
  if v_customer.phone_e164 !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'customer_phone_invalid'; end if;
  select * into v_number from public.phone_numbers
    where tenant_id=v_tenant and supports_voice and status='active'
    order by created_at,id limit 1;
  if not found then raise exception 'voice_number_missing'; end if;
  insert into public.calls(
    tenant_id,customer_id,phone_number_id,user_id,direction,from_number,to_number,status,
    callback_token_hash,metadata,idempotency_key,purpose
  ) values (
    v_tenant,p_customer_id,v_number.id,v_user,'outbound',v_number.number_e164,v_customer.phone_e164,'queued',
    p_callback_token_hash,jsonb_build_object('mode','webrtc_bridge'),p_idempotency_key,p_purpose
  ) returning id into v_call;
  insert into public.outbox_jobs(tenant_id,job_type,aggregate_type,aggregate_id,payload,idempotency_key)
    values(v_tenant,'call.start','call',v_call,jsonb_build_object(
      'call_id',v_call,'callback_token',p_callback_token,'voice_client_number',p_voice_client_number
    ),'call.start:'||v_call::text);
  insert into public.activities(tenant_id,customer_id,type,status,title,assigned_user_id,created_by,metadata)
    values(v_tenant,p_customer_id,'call','in_progress','Utgående samtal',v_user,v_user,jsonb_build_object('call_id',v_call));
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
    values(v_tenant,v_user,'call.queued','call',v_call::text,jsonb_build_object('customer_id',p_customer_id,'purpose',p_purpose));
  return v_call;
end
$$;

create or replace function public.upsert_tenant_legal_entity(
  p_id uuid,
  p_legal_name text,
  p_organization_number text,
  p_address_line1 text,
  p_postal_code text,
  p_city text,
  p_country_code text,
  p_email text,
  p_phone_e164 text,
  p_website text,
  p_is_default boolean
)
returns uuid
language plpgsql security definer set search_path=public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_user uuid := auth.uid();
  v_id uuid := p_id;
begin
  if v_user is null or v_tenant is null then raise exception 'authentication_required'; end if;
  if not public.is_tenant_admin(v_tenant) then raise exception 'admin_required'; end if;
  if nullif(trim(p_legal_name),'') is null then raise exception 'legal_name_required'; end if;
  if p_phone_e164 is not null and p_phone_e164<>'' and p_phone_e164 !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'phone_must_be_e164'; end if;
  if p_is_default then update public.tenant_legal_entities set is_default=false where tenant_id=v_tenant and is_default; end if;
  if v_id is null then
    insert into public.tenant_legal_entities(
      tenant_id,legal_name,organization_number,address_line1,postal_code,city,country_code,email,phone_e164,website,is_default,active
    ) values (
      v_tenant,p_legal_name,nullif(p_organization_number,''),nullif(p_address_line1,''),nullif(p_postal_code,''),nullif(p_city,''),
      coalesce(nullif(p_country_code,''),'SE'),nullif(p_email,'')::citext,nullif(p_phone_e164,''),nullif(p_website,''),p_is_default,true
    ) returning id into v_id;
  else
    update public.tenant_legal_entities set
      legal_name=p_legal_name,organization_number=nullif(p_organization_number,''),address_line1=nullif(p_address_line1,''),
      postal_code=nullif(p_postal_code,''),city=nullif(p_city,''),country_code=coalesce(nullif(p_country_code,''),'SE'),
      email=nullif(p_email,'')::citext,phone_e164=nullif(p_phone_e164,''),website=nullif(p_website,''),is_default=p_is_default,active=true
    where tenant_id=v_tenant and id=v_id;
    if not found then raise exception 'legal_entity_not_found'; end if;
  end if;
  if not exists(select 1 from public.tenant_legal_entities where tenant_id=v_tenant and is_default and active) then
    update public.tenant_legal_entities set is_default=true where tenant_id=v_tenant and id=v_id;
  end if;
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
    values(v_tenant,v_user,'legal_entity.saved','tenant_legal_entity',v_id::text,jsonb_build_object('legal_name',p_legal_name,'is_default',p_is_default));
  return v_id;
end
$$;

create or replace function public.set_tenant_feature(p_feature_key text,p_enabled boolean,p_configuration jsonb default '{}'::jsonb)
returns void
language plpgsql security definer set search_path=public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_user uuid := auth.uid();
begin
  if v_user is null or v_tenant is null then raise exception 'authentication_required'; end if;
  if not public.is_tenant_admin(v_tenant) then raise exception 'admin_required'; end if;
  if p_feature_key not in (
    'outbound_calls','outbound_sms','outbound_email','contract_delivery_sms','contract_delivery_email',
    'call_recording','data_enrichment','mass_campaigns','exports'
  ) then raise exception 'unknown_feature_key'; end if;
  insert into public.tenant_features(tenant_id,feature_key,enabled,configuration,updated_at)
    values(v_tenant,p_feature_key,p_enabled,coalesce(p_configuration,'{}'::jsonb),now())
  on conflict(tenant_id,feature_key) do update set enabled=excluded.enabled,configuration=excluded.configuration,updated_at=now();
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
    values(v_tenant,v_user,'tenant_feature.changed','tenant_feature',p_feature_key,jsonb_build_object('enabled',p_enabled));
end
$$;

-- Versioned legal templates: creation is separate from approval, and only an approved
-- version can be used to create a ready contract.
create or replace function public.create_contract_template_version(
  p_template_id uuid,
  p_name text,
  p_contract_type text,
  p_audience text,
  p_description text,
  p_legal_entity_id uuid,
  p_title_template text,
  p_body_template text,
  p_terms_template text,
  p_variables jsonb default '[]'::jsonb,
  p_variables_schema jsonb default '{}'::jsonb,
  p_signing_configuration jsonb default '{}'::jsonb
)
returns uuid
language plpgsql security definer set search_path=public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_user uuid := auth.uid();
  v_template uuid := p_template_id;
  v_version integer;
  v_version_id uuid;
begin
  if v_user is null or v_tenant is null then raise exception 'authentication_required'; end if;
  if not public.has_current_role(array['owner','admin','contract_manager']) then raise exception 'contract_template_permission_required'; end if;
  if p_audience not in ('B2B','B2C','BOTH') then raise exception 'invalid_template_audience'; end if;
  if nullif(trim(p_title_template),'') is null or nullif(trim(p_body_template),'') is null or nullif(trim(p_terms_template),'') is null then
    raise exception 'template_title_body_and_terms_required';
  end if;
  if p_legal_entity_id is not null and not exists(
    select 1 from public.tenant_legal_entities where tenant_id=v_tenant and id=p_legal_entity_id and active
  ) then raise exception 'legal_entity_not_found'; end if;

  if v_template is null then
    insert into public.contract_templates(tenant_id,name,contract_type,audience,description,legal_entity_id,active)
      values(v_tenant,p_name,p_contract_type,p_audience,p_description,p_legal_entity_id,true)
      returning id into v_template;
  else
    perform 1 from public.contract_templates where tenant_id=v_tenant and id=v_template for update;
    if not found then raise exception 'contract_template_not_found'; end if;
    update public.contract_templates set
      name=p_name,contract_type=p_contract_type,audience=p_audience,description=p_description,
      legal_entity_id=p_legal_entity_id,updated_at=now()
    where tenant_id=v_tenant and id=v_template;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_template::text,0));
  select coalesce(max(version),0)+1 into v_version from public.contract_template_versions where template_id=v_template;
  insert into public.contract_template_versions(
    tenant_id,template_id,version,title_template,body_template,terms_template,variables,variables_schema,
    signing_configuration,status,created_by
  ) values (
    v_tenant,v_template,v_version,p_title_template,p_body_template,p_terms_template,coalesce(p_variables,'[]'::jsonb),
    coalesce(p_variables_schema,'{}'::jsonb),coalesce(p_signing_configuration,'{}'::jsonb),'draft',v_user
  ) returning id into v_version_id;
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
    values(v_tenant,v_user,'contract_template.version_created','contract_template',v_template::text,
      jsonb_build_object('version_id',v_version_id,'version',v_version));
  return v_version_id;
end
$$;

create or replace function public.approve_contract_template_version(p_version_id uuid)
returns void
language plpgsql security definer set search_path=public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_user uuid := auth.uid();
  v_template uuid;
begin
  if v_user is null or v_tenant is null then raise exception 'authentication_required'; end if;
  if not public.has_current_role(array['owner','admin']) then raise exception 'contract_template_approval_permission_required'; end if;
  select template_id into v_template from public.contract_template_versions
    where tenant_id=v_tenant and id=p_version_id and status='draft' for update;
  if not found then raise exception 'draft_contract_template_version_not_found'; end if;
  update public.contract_template_versions set status='approved',approved_by=v_user,approved_at=now()
    where tenant_id=v_tenant and id=p_version_id;
  update public.contract_templates set current_version_id=p_version_id,active=true,updated_at=now()
    where tenant_id=v_tenant and id=v_template;
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
    values(v_tenant,v_user,'contract_template.version_approved','contract_template',v_template::text,
      jsonb_build_object('version_id',p_version_id));
end
$$;

create or replace function public.create_contract_draft_v2(
  p_contract_number text,
  p_customer_id uuid,
  p_product_id uuid,
  p_price_version_id uuid,
  p_template_id uuid,
  p_template_version_id uuid,
  p_legal_entity_id uuid,
  p_title text,
  p_rendered_body text,
  p_rendered_terms text,
  p_commercial_terms jsonb,
  p_document_hash text,
  p_sales_channel text,
  p_seller_snapshot jsonb,
  p_counterparty_snapshot jsonb
)
returns uuid
language plpgsql security definer set search_path=public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_contract uuid;
  v_version uuid;
  v_customer_type public.customer_type;
  v_audience text;
begin
  select customer_type into v_customer_type from public.customers
    where tenant_id=v_tenant and id=p_customer_id and deleted_at is null;
  if not found then raise exception 'customer_not_found'; end if;
  v_audience := case when v_customer_type='person' then 'B2C' else 'B2B' end;
  if not exists(
    select 1 from public.contract_templates t
    join public.contract_template_versions tv on tv.tenant_id=t.tenant_id and tv.template_id=t.id
    where t.tenant_id=v_tenant and t.id=p_template_id and t.active
      and t.current_version_id=p_template_version_id and tv.id=p_template_version_id and tv.status='approved'
      and t.audience in (v_audience,'BOTH')
      and (t.legal_entity_id is null or t.legal_entity_id=p_legal_entity_id)
  ) then raise exception 'approved_contract_template_required'; end if;
  if not exists(select 1 from public.tenant_legal_entities where tenant_id=v_tenant and id=p_legal_entity_id and active) then
    raise exception 'active_legal_entity_required';
  end if;

  v_contract := public.create_contract_draft(
    p_contract_number,p_customer_id,p_product_id,p_price_version_id,p_title,p_rendered_body,p_rendered_terms,
    p_commercial_terms,p_document_hash,p_sales_channel
  );
  update public.contracts set
    template_id=p_template_id,legal_entity_id=p_legal_entity_id,
    seller_snapshot=coalesce(p_seller_snapshot,'{}'::jsonb),
    counterparty_snapshot=coalesce(p_counterparty_snapshot,'{}'::jsonb)
  where tenant_id=v_tenant and id=v_contract
  returning active_version_id into v_version;
  update public.contract_versions set template_version_id=p_template_version_id
    where tenant_id=v_tenant and id=v_version;
  insert into public.contract_events(tenant_id,contract_id,event_type,actor_user_id,payload)
    values(v_tenant,v_contract,'contract.template_bound',auth.uid(),jsonb_build_object(
      'template_id',p_template_id,'template_version_id',p_template_version_id,'legal_entity_id',p_legal_entity_id
    ));
  return v_contract;
end
$$;

create or replace function public.protect_contract_template_approval() returns trigger
language plpgsql security definer set search_path=public
as $$
begin
  if tg_table_name='contract_template_versions' then
    if tg_op='INSERT' and new.status<>'draft' then raise exception 'new_template_version_must_be_draft'; end if;
    if tg_op='UPDATE' then
      if old.status='approved' and row(new.title_template,new.body_template,new.terms_template,new.variables,new.variables_schema,new.signing_configuration)
        is distinct from row(old.title_template,old.body_template,old.terms_template,old.variables,old.variables_schema,old.signing_configuration) then
        raise exception 'approved_template_version_is_immutable';
      end if;
      if row(new.status,new.approved_by,new.approved_at) is distinct from row(old.status,old.approved_by,old.approved_at)
        and not public.is_tenant_admin(old.tenant_id) then
        raise exception 'template_approval_requires_admin';
      end if;
    end if;
  elsif tg_table_name='contract_templates' and tg_op='UPDATE' then
    if new.current_version_id is distinct from old.current_version_id and not public.is_tenant_admin(old.tenant_id) then
      raise exception 'template_current_version_requires_admin';
    end if;
  end if;
  return new;
end
$$;
create trigger contract_template_versions_approval_guard before insert or update on public.contract_template_versions
  for each row execute function public.protect_contract_template_approval();
create trigger contract_templates_current_version_guard before update on public.contract_templates
  for each row execute function public.protect_contract_template_approval();

-- RLS and immutable tenant boundaries for added tenant tables.
do $$
declare t text;
begin
  foreach t in array array['tenant_legal_entities','offices','departments'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('create policy %I_member_select on public.%I for select to authenticated using (tenant_id=public.current_tenant_id() and public.is_tenant_member(tenant_id))',t,t);
    execute format('create policy %I_admin_write on public.%I for all to authenticated using (tenant_id=public.current_tenant_id() and public.is_tenant_admin(tenant_id)) with check (tenant_id=public.current_tenant_id() and public.is_tenant_admin(tenant_id))',t,t);
    execute format('create trigger %I_tenant_immutable before update of tenant_id on public.%I for each row execute function public.prevent_tenant_move()',t,t);
  end loop;
end $$;

-- Contract managers may author drafts; only owner/admin can approve through the RPC.
drop policy if exists contract_templates_member_select on public.contract_templates;
drop policy if exists contract_templates_admin_write on public.contract_templates;
create policy contract_templates_member_select on public.contract_templates for select to authenticated
  using (tenant_id=public.current_tenant_id() and public.is_tenant_member(tenant_id));
create policy contract_templates_author_write on public.contract_templates for all to authenticated
  using (tenant_id=public.current_tenant_id() and public.has_current_role(array['owner','admin','contract_manager']))
  with check (tenant_id=public.current_tenant_id() and public.has_current_role(array['owner','admin','contract_manager']));
drop policy if exists contract_template_versions_member_select on public.contract_template_versions;
drop policy if exists contract_template_versions_admin_write on public.contract_template_versions;
create policy contract_template_versions_member_select on public.contract_template_versions for select to authenticated
  using (tenant_id=public.current_tenant_id() and public.is_tenant_member(tenant_id));
create policy contract_template_versions_author_write on public.contract_template_versions for all to authenticated
  using (tenant_id=public.current_tenant_id() and public.has_current_role(array['owner','admin','contract_manager']))
  with check (tenant_id=public.current_tenant_id() and public.has_current_role(array['owner','admin','contract_manager']));

create trigger tenant_legal_entities_touch before update on public.tenant_legal_entities for each row execute function public.touch_updated_at();
create trigger offices_touch before update on public.offices for each row execute function public.touch_updated_at();
create trigger departments_touch before update on public.departments for each row execute function public.touch_updated_at();

revoke all on function public.evaluate_contact_policy_for_tenant(uuid,uuid,text,text) from public,anon,authenticated;
revoke all on function public.reserve_usage_for_tenant(uuid,text,numeric) from public,anon,authenticated;
grant execute on function public.evaluate_contact_policy_for_tenant(uuid,uuid,text,text) to service_role;
grant execute on function public.reserve_usage_for_tenant(uuid,text,numeric) to service_role;

grant execute on function public.upsert_tenant_legal_entity(uuid,text,text,text,text,text,text,text,text,text,boolean) to authenticated;
grant execute on function public.set_tenant_feature(text,boolean,jsonb) to authenticated;

grant execute on function public.queue_sms_message(uuid,text,text,text) to authenticated;
grant execute on function public.queue_email_message(uuid,text,text,text,text) to authenticated;
grant execute on function public.queue_outbound_call(uuid,text,text,text,text,text) to authenticated;
grant execute on function public.create_contract_template_version(uuid,text,text,text,text,uuid,text,text,text,jsonb,jsonb,jsonb) to authenticated;
grant execute on function public.approve_contract_template_version(uuid) to authenticated;
grant execute on function public.create_contract_draft_v2(text,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,jsonb,text,text,jsonb,jsonb) to authenticated;

commit;
