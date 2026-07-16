begin;

-- Complete the canonical data-platform execution layer. This migration keeps all
-- provider-specific behaviour data-driven and preserves tenant/licence boundaries.
do $$
begin
  begin
    execute 'create extension if not exists postgis';
  exception when others then
    raise notice 'postgis extension is not available in this environment; numeric lat/lon fallback remains active';
  end;
end $$;

alter table public.data_providers
  add column if not exists source_class text not null default 'licensed_provider'
    check (source_class in ('direct_verified','manual_verified','authority','licensed_provider','permitted_scrape','tenant_import','derived')),
  add column if not exists discovery_configuration jsonb not null default '{}'::jsonb;

alter table public.ingestion_jobs
  add column if not exists adapter_key text not null default 'generic_json',
  add column if not exists adapter_configuration jsonb not null default '{}'::jsonb,
  add column if not exists schedule_interval_seconds integer not null default 432000 check (schedule_interval_seconds between 3600 and 31536000),
  add column if not exists last_scheduled_at timestamptz,
  add column if not exists last_completed_at timestamptz;

alter table public.ingestion_runs
  add column if not exists attempts integer not null default 0,
  add column if not exists max_attempts integer not null default 5 check (max_attempts between 0 and 20),
  add column if not exists next_attempt_at timestamptz not null default now(),
  add column if not exists locked_at timestamptz,
  add column if not exists locked_by text,
  add column if not exists current_page text,
  add column if not exists next_page text,
  add column if not exists parser_fingerprint text;

alter table public.raw_payloads
  add column if not exists parse_status text not null default 'pending' check (parse_status in ('pending','parsed','failed','quarantined')),
  add column if not exists parse_error text;

alter table public.master_entities
  add column if not exists merged_into_id uuid references public.master_entities(id) on delete set null,
  add column if not exists merged_at timestamptz,
  add column if not exists date_of_birth date,
  add column if not exists registration_date date,
  add column if not exists f_tax_registered boolean,
  add column if not exists vat_registered boolean,
  add column if not exists employer_registered boolean,
  add column if not exists phone_type text check (phone_type is null or phone_type in ('mobile','landline','unknown'));

create index if not exists master_entities_radius_idx on public.master_entities(latitude,longitude) where latitude is not null and longitude is not null;
create index if not exists master_entities_extended_filters_idx on public.master_entities(legal_form,organization_status,postal_code,registration_date,revenue,result);
create index if not exists master_entities_visible_idx on public.master_entities(merged_into_id,source_removed_at);

create table public.source_priority_policies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  field_key text not null default '*',
  source_class text not null check (source_class in ('direct_verified','manual_verified','authority','licensed_provider','permitted_scrape','tenant_import','derived')),
  priority integer not null check (priority between 1 and 1000),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id,field_key,source_class),
  unique (tenant_id,id)
);

create table public.identity_keys (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  master_entity_id uuid not null references public.master_entities(id) on delete cascade,
  key_type text not null check (key_type in ('organization_number','external_id','cfar','phone','email','website_domain','name_postal','secure_person_key')),
  normalized_value text not null,
  confidence numeric not null default 1 check (confidence between 0 and 1),
  verified boolean not null default false,
  source_entity_id uuid references public.source_entities(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id,key_type,normalized_value,master_entity_id),
  unique (tenant_id,id)
);
create index identity_keys_lookup_idx on public.identity_keys(tenant_id,key_type,normalized_value);

create table public.merge_decisions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  target_entity_id uuid not null references public.master_entities(id),
  source_entity_id uuid not null references public.master_entities(id),
  decision text not null check (decision in ('merged','undone','rejected')),
  snapshot jsonb not null default '{}'::jsonb,
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz not null default now(),
  undone_by uuid references auth.users(id) on delete set null,
  undone_at timestamptz,
  unique (tenant_id,id),
  check (target_entity_id<>source_entity_id)
);

create table public.parser_observations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  parser_version_id uuid not null,
  ingestion_run_id uuid,
  raw_payload_id uuid,
  page_fingerprint text,
  present_fields text[] not null default '{}',
  missing_fields text[] not null default '{}',
  match_rate numeric not null default 0 check (match_rate between 0 and 1),
  disappearance_rate numeric not null default 0 check (disappearance_rate between 0 and 1),
  status text not null default 'accepted' check (status in ('accepted','warning','quarantined','approved','rejected')),
  details jsonb not null default '{}'::jsonb,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id,id),
  foreign key (tenant_id,parser_version_id) references public.parser_versions(tenant_id,id) on delete cascade,
  foreign key (tenant_id,ingestion_run_id) references public.ingestion_runs(tenant_id,id) on delete cascade,
  foreign key (tenant_id,raw_payload_id) references public.raw_payloads(tenant_id,id) on delete set null
);

create table public.segment_refresh_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  segment_id uuid not null,
  status text not null default 'queued' check (status in ('queued','running','completed','failed')),
  reason text not null default 'scheduled',
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (tenant_id,id),
  foreign key (tenant_id,segment_id) references public.segments(tenant_id,id) on delete cascade
);
create unique index segment_refresh_jobs_active_unique on public.segment_refresh_jobs(segment_id) where status in ('queued','running');

create table public.tenant_entities (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  master_entity_id uuid not null references public.master_entities(id) on delete cascade,
  customer_id uuid,
  relationship text not null default 'prospect' check (relationship in ('prospect','lead','customer','former_customer','blocked')),
  source text not null default 'directory',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id,master_entity_id),
  foreign key (tenant_id,customer_id) references public.customers(tenant_id,id) on delete set null
);

create table public.retention_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  status text not null default 'running' check (status in ('running','completed','failed')),
  deleted_count integer not null default 0,
  anonymized_count integer not null default 0,
  archived_count integer not null default 0,
  details jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  last_error text,
  unique (tenant_id,id)
);

create table public.data_subject_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  request_type text not null check (request_type in ('access','rectification','erasure','portability','restriction','objection')),
  subject_reference text not null,
  status text not null default 'received' check (status in ('received','identity_verification','processing','completed','rejected')),
  due_at timestamptz,
  evidence jsonb not null default '{}'::jsonb,
  result_storage_path text,
  created_by uuid references auth.users(id) on delete set null,
  handled_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (tenant_id,id)
);

alter table public.source_priority_policies enable row level security;
alter table public.identity_keys enable row level security;
alter table public.merge_decisions enable row level security;
alter table public.parser_observations enable row level security;
alter table public.segment_refresh_jobs enable row level security;
alter table public.tenant_entities enable row level security;
alter table public.retention_runs enable row level security;
alter table public.data_subject_requests enable row level security;

do $$
declare t text;
begin
  foreach t in array array['source_priority_policies','identity_keys','merge_decisions','parser_observations','segment_refresh_jobs','tenant_entities','retention_runs','data_subject_requests'] loop
    execute format('create policy %I_member_select on public.%I for select to authenticated using (tenant_id=public.current_tenant_id() and public.is_tenant_member(tenant_id))',t,t);
    execute format('create policy %I_admin_write on public.%I for all to authenticated using (tenant_id=public.current_tenant_id() and public.is_tenant_admin(tenant_id)) with check (tenant_id=public.current_tenant_id() and public.is_tenant_admin(tenant_id))',t,t);
  end loop;
end $$;

insert into public.source_priority_policies(tenant_id,field_key,source_class,priority)
select t.id,'*',v.source_class,v.priority
from public.tenants t
cross join (values
  ('direct_verified',10),('manual_verified',20),('authority',30),('licensed_provider',40),('permitted_scrape',50),('tenant_import',60),('derived',70)
) v(source_class,priority)
on conflict do nothing;

create or replace function public.seed_source_priority_policies_for_tenant()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  insert into public.source_priority_policies(tenant_id,field_key,source_class,priority)
  select new.id,'*',v.source_class,v.priority from (values
    ('direct_verified',10),('manual_verified',20),('authority',30),('licensed_provider',40),('permitted_scrape',50),('tenant_import',60),('derived',70)
  ) v(source_class,priority)
  on conflict do nothing;
  return new;
end $$;
drop trigger if exists tenants_seed_source_priority_policies on public.tenants;
create trigger tenants_seed_source_priority_policies after insert on public.tenants for each row execute function public.seed_source_priority_policies_for_tenant();

create or replace function public.normalize_identity_value(p_type text,p_value text)
returns text language plpgsql immutable as $$
declare v text:=lower(trim(coalesce(p_value,'')));
begin
  if p_type in ('organization_number','cfar','phone','secure_person_key') then return regexp_replace(v,'[^0-9+]','','g'); end if;
  if p_type='email' then return v; end if;
  if p_type='website_domain' then
    v:=regexp_replace(v,'^https?://','','i'); v:=regexp_replace(v,'^www\.','','i'); return split_part(v,'/',1);
  end if;
  return regexp_replace(v,'\s+',' ','g');
end $$;

create or replace function public.haversine_km(p_lat1 numeric,p_lon1 numeric,p_lat2 numeric,p_lon2 numeric)
returns numeric language sql immutable as $$
  select case when p_lat1 is null or p_lon1 is null or p_lat2 is null or p_lon2 is null then null else
    6371 * 2 * asin(sqrt(
      power(sin(radians((p_lat2-p_lat1)::double precision)/2),2) +
      cos(radians(p_lat1::double precision))*cos(radians(p_lat2::double precision))*power(sin(radians((p_lon2-p_lon1)::double precision)/2),2)
    ))
  end::numeric
$$;

create or replace function public.directory_visible_fields_for_tenant(p_tenant_id uuid,p_entity_id uuid)
returns table(field_key text,field_value jsonb,confidence numeric,selected_source_fact_id uuid,verified_at timestamptz,fresh_until timestamptz,updated_at timestamptz)
language sql stable security definer set search_path=public as $$
  select fv.field_key,fv.field_value,fv.confidence,fv.selected_source_fact_id,fv.verified_at,fv.fresh_until,fv.updated_at
  from public.field_values fv
  join public.master_entities me on me.id=fv.master_entity_id
  join public.source_facts sf on sf.id=fv.selected_source_fact_id
  join public.provider_field_permissions pfp on pfp.permission_id=sf.permission_id and pfp.entity_type=me.entity_type and pfp.field_key=fv.field_key
  where fv.master_entity_id=p_entity_id and pfp.may_display
    and exists(select 1 from public.directory_entity_for_tenant(p_tenant_id,p_entity_id))
$$;

create or replace function public.directory_entity_projection_for_tenant(p_tenant_id uuid,p_entity_id uuid)
returns jsonb language sql stable security definer set search_path=public as $$
  with entity as (
    select me.*,coalesce(ef.state,case when me.enriched_at is null then 'missing'::public.directory_freshness_state when me.fresh_until>now() then 'fresh'::public.directory_freshness_state else 'stale'::public.directory_freshness_state end) freshness_state,
           pp.attribution_required,dp.name source_name
    from public.master_entities me
    join public.provider_permissions pp on pp.id=me.permission_id
    join public.data_providers dp on dp.id=me.data_provider_id
    left join public.entity_freshness ef on ef.master_entity_id=me.id
    where me.id=p_entity_id and exists(select 1 from public.directory_entity_for_tenant(p_tenant_id,p_entity_id))
  ), visible as (
    select coalesce(jsonb_object_agg(v.field_key,v.field_value),'{}'::jsonb) fields
    from public.directory_visible_fields_for_tenant(p_tenant_id,p_entity_id) v
  )
  select jsonb_build_object(
    'id',e.id,'entity_type',e.entity_type,'cache_scope',e.cache_scope,
    'data_quality_score',e.data_quality_score,'freshness_state',e.freshness_state,
    'enriched_at',e.enriched_at,'fresh_until',e.fresh_until,'next_refresh_at',e.next_refresh_at,
    'created_at',e.created_at,'updated_at',e.updated_at,
    'source_attribution_required',e.attribution_required,
    'source_name',case when e.attribution_required then e.source_name else null end
  ) || visible.fields
  from entity e cross join visible
$$;

create or replace function public.directory_source_attribution_for_tenant(p_tenant_id uuid,p_entity_id uuid)
returns table(source_name text,match_method text,confidence numeric,manually_verified boolean,last_seen_at timestamptz,removed_at timestamptz,attribution_required boolean)
language sql stable security definer set search_path=public as $$
  select dp.name,esl.match_method,esl.confidence,esl.manually_verified,se.last_seen_at,se.removed_at,pp.attribution_required
  from public.entity_source_links esl
  join public.source_entities se on se.id=esl.source_entity_id
  join public.provider_permissions pp on pp.id=se.permission_id and pp.status='active' and pp.tenant_display_allowed
  join public.data_providers dp on dp.id=se.data_provider_id
  where esl.master_entity_id=p_entity_id
    and exists(select 1 from public.directory_entity_for_tenant(p_tenant_id,p_entity_id))
$$;

create or replace function public.directory_search_summary_for_tenant(
  p_tenant_id uuid,p_filters jsonb default '{}'::jsonb
) returns jsonb
language sql stable security definer set search_path=public as $$
with filtered as (
  select me.*,coalesce(ef.state,case when me.enriched_at is null then 'missing'::public.directory_freshness_state when me.fresh_until>now() then 'fresh'::public.directory_freshness_state else 'stale'::public.directory_freshness_state end) state,
         pp.attribution_required
  from public.master_entities me
  left join public.entity_freshness ef on ef.master_entity_id=me.id
  join public.provider_permissions pp on pp.id=me.permission_id
  join public.data_providers dp on dp.id=me.data_provider_id
  where me.merged_into_id is null and me.source_removed_at is null
    and me.entity_type=coalesce((p_filters->>'entityType')::public.directory_entity_type,'organization')
    and (nullif(p_filters->>'countryCode','') is null or me.country_code=p_filters->>'countryCode')
    and (nullif(p_filters->>'query','') is null or me.canonical_name ilike '%'||(p_filters->>'query')||'%' or me.organization_number ilike '%'||(p_filters->>'query')||'%')
    and (nullif(p_filters->>'county','') is null or me.county=p_filters->>'county')
    and (nullif(p_filters->>'municipality','') is null or me.municipality=p_filters->>'municipality')
    and (nullif(p_filters->>'city','') is null or me.city=p_filters->>'city')
    and (nullif(p_filters->>'postalCode','') is null or me.postal_code like (p_filters->>'postalCode')||'%')
    and (nullif(p_filters->>'sniCode','') is null or me.sni_code like (p_filters->>'sniCode')||'%')
    and (nullif(p_filters->>'legalForm','') is null or me.legal_form=p_filters->>'legalForm')
    and (nullif(p_filters->>'organizationStatus','') is null or me.organization_status=p_filters->>'organizationStatus')
    and (p_filters->>'dataProviderId' is null or me.data_provider_id=(p_filters->>'dataProviderId')::uuid)
    and (nullif(p_filters->>'sourceProvider','') is null or dp.provider=p_filters->>'sourceProvider' or dp.name ilike '%'||(p_filters->>'sourceProvider')||'%')
    and (p_filters->>'ageMin' is null or (me.date_of_birth is not null and extract(year from age(current_date,me.date_of_birth))>=(p_filters->>'ageMin')::integer))
    and (p_filters->>'ageMax' is null or (me.date_of_birth is not null and extract(year from age(current_date,me.date_of_birth))<=(p_filters->>'ageMax')::integer))
    and (p_filters->>'employeeMin' is null or me.employee_count >= (p_filters->>'employeeMin')::integer)
    and (p_filters->>'employeeMax' is null or me.employee_count <= (p_filters->>'employeeMax')::integer)
    and (p_filters->>'revenueMin' is null or me.revenue >= (p_filters->>'revenueMin')::numeric)
    and (p_filters->>'revenueMax' is null or me.revenue <= (p_filters->>'revenueMax')::numeric)
    and (p_filters->>'resultMin' is null or me.result >= (p_filters->>'resultMin')::numeric)
    and (p_filters->>'resultMax' is null or me.result <= (p_filters->>'resultMax')::numeric)
    and (p_filters->>'hasPhone' is null or (me.phone_e164 is not null)=(p_filters->>'hasPhone')::boolean)
    and (p_filters->>'hasEmail' is null or (me.email is not null)=(p_filters->>'hasEmail')::boolean)
    and (p_filters->>'hasWebsite' is null or (me.website is not null)=(p_filters->>'hasWebsite')::boolean)
    and (p_filters->>'phoneType' is null or me.phone_type=p_filters->>'phoneType')
    and (p_filters->>'freshOnly' is null or not (p_filters->>'freshOnly')::boolean or me.fresh_until>now())
    and (p_filters->>'dataAgeDaysMax' is null or me.enriched_at >= now()-make_interval(days=>(p_filters->>'dataAgeDaysMax')::integer))
    and (p_filters->>'registrationFrom' is null or me.registration_date >= (p_filters->>'registrationFrom')::date)
    and (p_filters->>'registrationTo' is null or me.registration_date <= (p_filters->>'registrationTo')::date)
    and (p_filters->>'fTaxRegistered' is null or me.f_tax_registered=(p_filters->>'fTaxRegistered')::boolean)
    and (p_filters->>'vatRegistered' is null or me.vat_registered=(p_filters->>'vatRegistered')::boolean)
    and (p_filters->>'employerRegistered' is null or me.employer_registered=(p_filters->>'employerRegistered')::boolean)
    and (p_filters->>'latitude' is null or p_filters->>'longitude' is null or p_filters->>'radiusKm' is null or public.haversine_km(me.latitude,me.longitude,(p_filters->>'latitude')::numeric,(p_filters->>'longitude')::numeric)<=(p_filters->>'radiusKm')::numeric)
    and (
      me.owner_tenant_id=p_tenant_id
      or (me.cache_scope='global' and pp.status='active' and pp.cache_scope='global' and pp.cross_tenant_reuse_allowed and pp.tenant_display_allowed and (pp.starts_at is null or pp.starts_at<=now()) and (pp.expires_at is null or pp.expires_at>now()))
      or (me.cache_scope='provider_account' and pp.status='active' and pp.tenant_display_allowed and exists(select 1 from public.provider_account_tenants pat where pat.provider_account_id=me.provider_account_id and pat.tenant_id=p_tenant_id))
    )
), tenant_crm as (
  select f.*,te.customer_id,c.last_contact_at,c.call_attempts,c.lifecycle,c.campaign_id
  from filtered f left join public.tenant_entities te on te.tenant_id=p_tenant_id and te.master_entity_id=f.id
  left join public.customers c on c.tenant_id=p_tenant_id and c.id=te.customer_id and c.deleted_at is null
  left join lateral (select n.result from public.nix_checks n where n.tenant_id=p_tenant_id and n.phone_e164=coalesce(c.phone_e164,f.phone_e164) and n.valid_until>now() order by n.checked_at desc limit 1) nx on true
  where (p_filters->>'previouslyContacted' is null or (c.last_contact_at is not null)=(p_filters->>'previouslyContacted')::boolean)
    and (p_filters->>'callAttemptsMin' is null or coalesce(c.call_attempts,0)>=(p_filters->>'callAttemptsMin')::integer)
    and (p_filters->>'campaignId' is null or c.campaign_id=(p_filters->>'campaignId')::uuid)
    and (p_filters->>'customerLifecycle' is null or c.lifecycle::text=p_filters->>'customerLifecycle')
    and (p_filters->>'assignedUserId' is null or c.assigned_user_id=(p_filters->>'assignedUserId')::uuid)
    and (p_filters->>'assignedTeamId' is null or c.assigned_team_id=(p_filters->>'assignedTeamId')::uuid)
    and (p_filters->>'hasContactPerson' is null or ((exists(select 1 from public.contact_people cp where cp.tenant_id=p_tenant_id and cp.customer_id=c.id)) or coalesce((f.current_master->>'contact_person_count')::integer,0)>0)=(p_filters->>'hasContactPerson')::boolean)
    and (p_filters->>'contractStatus' is null or exists(select 1 from public.contracts ct where ct.tenant_id=p_tenant_id and ct.customer_id=c.id and ct.status::text=p_filters->>'contractStatus'))
    and (p_filters->>'activeContract' is null or (exists(select 1 from public.contracts ct where ct.tenant_id=p_tenant_id and ct.customer_id=c.id and ct.status in ('signed','active') and (ct.ends_on is null or ct.ends_on>=current_date)))=(p_filters->>'activeContract')::boolean)
    and (p_filters->>'nixStatus' is null or coalesce(nx.result,'missing')=p_filters->>'nixStatus')
    and (p_filters->>'blocked' is null or (coalesce(c.do_not_call,false) or coalesce(c.do_not_sms,false) or coalesce(c.do_not_email,false) or exists(select 1 from public.compliance_blocks cb where cb.tenant_id=p_tenant_id and cb.active and (cb.expires_at is null or cb.expires_at>now()) and (cb.customer_id=c.id or cb.phone_e164=coalesce(c.phone_e164,f.phone_e164) or cb.email=coalesce(c.email,f.email))))=(p_filters->>'blocked')::boolean)
    and (p_filters->>'allowedChannel' is null or (c.id is not null and public.evaluate_contact_policy_for_tenant(p_tenant_id,c.id,p_filters->>'allowedChannel','direct_marketing')->>'allowed'='true'))
)
select jsonb_build_object(
  'total',count(*),
  'fresh',count(*) filter(where state='fresh'),
  'stale',count(*) filter(where state='stale'),
  'missing',count(*) filter(where state='missing'),
  'refreshing',count(*) filter(where state='refreshing'),
  'quarantined',count(*) filter(where state='quarantined'),
  'missingPhone',count(*) filter(where phone_e164 is null),
  'missingEmail',count(*) filter(where email is null),
  'linkedCustomers',count(*) filter(where customer_id is not null),
  'averageQuality',coalesce(round(avg(data_quality_score),2),0)
) from tenant_crm
$$;


create or replace function public.directory_search_v2_for_tenant(
  p_tenant_id uuid,p_filters jsonb default '{}'::jsonb,p_limit integer default 50,p_offset integer default 0
) returns jsonb
language sql stable security definer set search_path=public as $$
with filtered as (
  select me.*,coalesce(ef.state,case when me.enriched_at is null then 'missing'::public.directory_freshness_state when me.fresh_until>now() then 'fresh'::public.directory_freshness_state else 'stale'::public.directory_freshness_state end) freshness_state,
         coalesce(pp.attribution_required,false) source_attribution_required,te.customer_id,c.last_contact_at,c.call_attempts,c.lifecycle::text customer_lifecycle,c.campaign_id
  from public.master_entities me
  left join public.entity_freshness ef on ef.master_entity_id=me.id
  join public.provider_permissions pp on pp.id=me.permission_id
  join public.data_providers dp on dp.id=me.data_provider_id
  left join public.tenant_entities te on te.tenant_id=p_tenant_id and te.master_entity_id=me.id
  left join public.customers c on c.tenant_id=p_tenant_id and c.id=te.customer_id and c.deleted_at is null
  left join lateral (select n.result from public.nix_checks n where n.tenant_id=p_tenant_id and n.phone_e164=coalesce(c.phone_e164,me.phone_e164) and n.valid_until>now() order by n.checked_at desc limit 1) nx on true
  where me.merged_into_id is null and me.source_removed_at is null
    and me.entity_type=coalesce((p_filters->>'entityType')::public.directory_entity_type,'organization')
    and (nullif(p_filters->>'countryCode','') is null or me.country_code=p_filters->>'countryCode')
    and (nullif(p_filters->>'query','') is null or me.canonical_name ilike '%'||(p_filters->>'query')||'%' or me.organization_number ilike '%'||(p_filters->>'query')||'%')
    and (nullif(p_filters->>'county','') is null or me.county=p_filters->>'county')
    and (nullif(p_filters->>'municipality','') is null or me.municipality=p_filters->>'municipality')
    and (nullif(p_filters->>'city','') is null or me.city=p_filters->>'city')
    and (nullif(p_filters->>'postalCode','') is null or me.postal_code like (p_filters->>'postalCode')||'%')
    and (nullif(p_filters->>'sniCode','') is null or me.sni_code like (p_filters->>'sniCode')||'%')
    and (nullif(p_filters->>'legalForm','') is null or me.legal_form=p_filters->>'legalForm')
    and (nullif(p_filters->>'organizationStatus','') is null or me.organization_status=p_filters->>'organizationStatus')
    and (p_filters->>'dataProviderId' is null or me.data_provider_id=(p_filters->>'dataProviderId')::uuid)
    and (nullif(p_filters->>'sourceProvider','') is null or dp.provider=p_filters->>'sourceProvider' or dp.name ilike '%'||(p_filters->>'sourceProvider')||'%')
    and (p_filters->>'ageMin' is null or (me.date_of_birth is not null and extract(year from age(current_date,me.date_of_birth))>=(p_filters->>'ageMin')::integer))
    and (p_filters->>'ageMax' is null or (me.date_of_birth is not null and extract(year from age(current_date,me.date_of_birth))<=(p_filters->>'ageMax')::integer))
    and (p_filters->>'employeeMin' is null or me.employee_count >= (p_filters->>'employeeMin')::integer)
    and (p_filters->>'employeeMax' is null or me.employee_count <= (p_filters->>'employeeMax')::integer)
    and (p_filters->>'revenueMin' is null or me.revenue >= (p_filters->>'revenueMin')::numeric)
    and (p_filters->>'revenueMax' is null or me.revenue <= (p_filters->>'revenueMax')::numeric)
    and (p_filters->>'resultMin' is null or me.result >= (p_filters->>'resultMin')::numeric)
    and (p_filters->>'resultMax' is null or me.result <= (p_filters->>'resultMax')::numeric)
    and (p_filters->>'hasPhone' is null or (me.phone_e164 is not null)=(p_filters->>'hasPhone')::boolean)
    and (p_filters->>'hasEmail' is null or (me.email is not null)=(p_filters->>'hasEmail')::boolean)
    and (p_filters->>'hasWebsite' is null or (me.website is not null)=(p_filters->>'hasWebsite')::boolean)
    and (p_filters->>'phoneType' is null or me.phone_type=p_filters->>'phoneType')
    and (p_filters->>'freshOnly' is null or not (p_filters->>'freshOnly')::boolean or me.fresh_until>now())
    and (p_filters->>'dataAgeDaysMax' is null or me.enriched_at >= now()-make_interval(days=>(p_filters->>'dataAgeDaysMax')::integer))
    and (p_filters->>'registrationFrom' is null or me.registration_date >= (p_filters->>'registrationFrom')::date)
    and (p_filters->>'registrationTo' is null or me.registration_date <= (p_filters->>'registrationTo')::date)
    and (p_filters->>'fTaxRegistered' is null or me.f_tax_registered=(p_filters->>'fTaxRegistered')::boolean)
    and (p_filters->>'vatRegistered' is null or me.vat_registered=(p_filters->>'vatRegistered')::boolean)
    and (p_filters->>'employerRegistered' is null or me.employer_registered=(p_filters->>'employerRegistered')::boolean)
    and (p_filters->>'latitude' is null or p_filters->>'longitude' is null or p_filters->>'radiusKm' is null or public.haversine_km(me.latitude,me.longitude,(p_filters->>'latitude')::numeric,(p_filters->>'longitude')::numeric)<=(p_filters->>'radiusKm')::numeric)
    and (p_filters->>'previouslyContacted' is null or (c.last_contact_at is not null)=(p_filters->>'previouslyContacted')::boolean)
    and (p_filters->>'callAttemptsMin' is null or coalesce(c.call_attempts,0)>=(p_filters->>'callAttemptsMin')::integer)
    and (p_filters->>'campaignId' is null or c.campaign_id=(p_filters->>'campaignId')::uuid)
    and (p_filters->>'customerLifecycle' is null or c.lifecycle::text=p_filters->>'customerLifecycle')
    and (p_filters->>'assignedUserId' is null or c.assigned_user_id=(p_filters->>'assignedUserId')::uuid)
    and (p_filters->>'assignedTeamId' is null or c.assigned_team_id=(p_filters->>'assignedTeamId')::uuid)
    and (p_filters->>'hasContactPerson' is null or ((exists(select 1 from public.contact_people cp where cp.tenant_id=p_tenant_id and cp.customer_id=c.id)) or coalesce((me.current_master->>'contact_person_count')::integer,0)>0)=(p_filters->>'hasContactPerson')::boolean)
    and (p_filters->>'contractStatus' is null or exists(select 1 from public.contracts ct where ct.tenant_id=p_tenant_id and ct.customer_id=c.id and ct.status::text=p_filters->>'contractStatus'))
    and (p_filters->>'activeContract' is null or (exists(select 1 from public.contracts ct where ct.tenant_id=p_tenant_id and ct.customer_id=c.id and ct.status in ('signed','active') and (ct.ends_on is null or ct.ends_on>=current_date)))=(p_filters->>'activeContract')::boolean)
    and (p_filters->>'nixStatus' is null or coalesce(nx.result,'missing')=p_filters->>'nixStatus')
    and (p_filters->>'blocked' is null or (coalesce(c.do_not_call,false) or coalesce(c.do_not_sms,false) or coalesce(c.do_not_email,false) or exists(select 1 from public.compliance_blocks cb where cb.tenant_id=p_tenant_id and cb.active and (cb.expires_at is null or cb.expires_at>now()) and (cb.customer_id=c.id or cb.phone_e164=coalesce(c.phone_e164,me.phone_e164) or cb.email=coalesce(c.email,me.email))))=(p_filters->>'blocked')::boolean)
    and (p_filters->>'allowedChannel' is null or (c.id is not null and public.evaluate_contact_policy_for_tenant(p_tenant_id,c.id,p_filters->>'allowedChannel','direct_marketing')->>'allowed'='true'))
    and (
      me.owner_tenant_id=p_tenant_id
      or (me.cache_scope='global' and pp.status='active' and pp.cache_scope='global' and pp.cross_tenant_reuse_allowed and pp.tenant_display_allowed and (pp.starts_at is null or pp.starts_at<=now()) and (pp.expires_at is null or pp.expires_at>now()))
      or (me.cache_scope='provider_account' and pp.status='active' and pp.tenant_display_allowed and exists(select 1 from public.provider_account_tenants pat where pat.provider_account_id=me.provider_account_id and pat.tenant_id=p_tenant_id))
    )
), ordered as (
  select * from filtered order by
    case when p_filters->>'sort'='name_asc' then canonical_name end asc,
    case when p_filters->>'sort'='name_desc' then canonical_name end desc,
    case when p_filters->>'sort'='quality_desc' or p_filters->>'sort' is null then data_quality_score end desc,
    case when p_filters->>'sort'='updated_desc' then enriched_at end desc,
    canonical_name asc
  limit greatest(1,least(coalesce(p_limit,50),200)) offset greatest(coalesce(p_offset,0),0)
)
select coalesce(jsonb_agg(
  public.directory_entity_projection_for_tenant(p_tenant_id,ordered.id) || jsonb_build_object(
    'freshness_state',ordered.freshness_state,
    'customer_id',ordered.customer_id,
    'last_contact_at',ordered.last_contact_at,
    'call_attempts',ordered.call_attempts,
    'customer_lifecycle',ordered.customer_lifecycle,
    'campaign_id',ordered.campaign_id
  )
),'[]'::jsonb) from ordered
$$;

create or replace function public.recalculate_data_quality(p_entity_id uuid)
returns numeric language plpgsql security definer set search_path=public as $$
declare v_me public.master_entities%rowtype; v_complete numeric; v_fresh numeric; v_cons numeric; v_prov numeric; v_overall numeric;
begin
  select * into v_me from public.master_entities where id=p_entity_id;
  if not found then return 0; end if;
  v_complete := 100.0 * (
    (case when v_me.canonical_name is not null then 1 else 0 end)+
    (case when coalesce(v_me.organization_number,v_me.external_primary_id) is not null then 1 else 0 end)+
    (case when v_me.address_line1 is not null then 1 else 0 end)+
    (case when v_me.city is not null then 1 else 0 end)+
    (case when v_me.phone_e164 is not null then 1 else 0 end)+
    (case when v_me.email is not null then 1 else 0 end)+
    (case when v_me.entity_type='person' or v_me.sni_code is not null then 1 else 0 end)+
    (case when v_me.entity_type='person' or v_me.organization_status is not null then 1 else 0 end)
  )/8.0;
  v_fresh := case when v_me.fresh_until is null then 0 when v_me.fresh_until>now() then 100 else greatest(0,100-extract(epoch from (now()-v_me.fresh_until))/86400) end;
  select case when count(*)=0 then 100 else greatest(0,100-count(*)*10) end into v_cons from public.data_conflicts where master_entity_id=p_entity_id and status='open';
  select least(100,coalesce(avg(confidence)*100,0)) into v_prov from public.field_values where master_entity_id=p_entity_id;
  insert into public.data_quality_scores(master_entity_id,completeness,freshness,consistency,provenance,details,calculated_at)
  values(p_entity_id,v_complete,v_fresh,v_cons,v_prov,jsonb_build_object('formula','equal_weight_v1'),now())
  on conflict(master_entity_id) do update set completeness=excluded.completeness,freshness=excluded.freshness,consistency=excluded.consistency,provenance=excluded.provenance,details=excluded.details,calculated_at=now();
  select overall into v_overall from public.data_quality_scores where master_entity_id=p_entity_id;
  update public.master_entities set data_quality_score=v_overall,updated_at=now() where id=p_entity_id;
  return v_overall;
end $$;

create or replace function public.rebuild_master_entity(p_entity_id uuid)
returns void language plpgsql security definer set search_path=public as $$
declare v jsonb;
begin
  select coalesce(jsonb_object_agg(fv.field_key,fv.field_value),'{}'::jsonb) into v
  from public.field_values fv
  join public.master_entities me on me.id=fv.master_entity_id
  join public.source_facts sf on sf.id=fv.selected_source_fact_id
  join public.provider_field_permissions pfp on pfp.permission_id=sf.permission_id and pfp.entity_type=me.entity_type and pfp.field_key=fv.field_key and (pfp.may_filter or pfp.may_display)
  where fv.master_entity_id=p_entity_id;
  update public.master_entities set
    canonical_name=coalesce(nullif(v->>'canonical_name',''),canonical_name),organization_number=coalesce(nullif(v->>'organization_number',''),organization_number),
    legal_form=coalesce(nullif(v->>'legal_form',''),legal_form),organization_status=coalesce(nullif(v->>'organization_status',''),organization_status),
    address_line1=coalesce(nullif(v->>'address_line1',''),address_line1),postal_code=coalesce(nullif(v->>'postal_code',''),postal_code),city=coalesce(nullif(v->>'city',''),city),
    municipality=coalesce(nullif(v->>'municipality',''),municipality),municipality_code=coalesce(nullif(v->>'municipality_code',''),municipality_code),county=coalesce(nullif(v->>'county',''),county),county_code=coalesce(nullif(v->>'county_code',''),county_code),
    country_code=coalesce(nullif(v->>'country_code',''),country_code),latitude=coalesce(nullif(v->>'latitude','')::numeric,latitude),longitude=coalesce(nullif(v->>'longitude','')::numeric,longitude),
    industry=coalesce(nullif(v->>'industry',''),industry),sni_code=coalesce(nullif(v->>'sni_code',''),sni_code),employee_count=coalesce(nullif(v->>'employee_count','')::integer,employee_count),
    revenue=coalesce(nullif(v->>'revenue','')::numeric,revenue),result=coalesce(nullif(v->>'result','')::numeric,result),website=coalesce(nullif(v->>'website',''),website),phone_e164=coalesce(nullif(v->>'phone_e164',''),phone_e164),email=coalesce(nullif(v->>'email','')::citext,email),
    registration_date=coalesce(nullif(v->>'registration_date','')::date,registration_date),f_tax_registered=coalesce(nullif(v->>'f_tax_registered','')::boolean,f_tax_registered),vat_registered=coalesce(nullif(v->>'vat_registered','')::boolean,vat_registered),employer_registered=coalesce(nullif(v->>'employer_registered','')::boolean,employer_registered),
    phone_type=coalesce(nullif(v->>'phone_type',''),phone_type),current_master=v,updated_at=now()
  where id=p_entity_id;
  perform public.recalculate_data_quality(p_entity_id);
end $$;

create or replace function public.schedule_due_ingestion_jobs(p_limit integer default 20)
returns setof public.ingestion_runs language plpgsql security definer set search_path=public as $$
declare j public.ingestion_jobs%rowtype; r public.ingestion_runs%rowtype; v_parser uuid;
begin
  for j in select * from public.ingestion_jobs where status='active' and coalesce(next_run_at,now())<=now()
    and not exists(select 1 from public.ingestion_runs ir where ir.ingestion_job_id=ingestion_jobs.id and ir.status in ('scheduled','running'))
    order by priority,next_run_at nulls first limit greatest(1,least(p_limit,100)) for update skip locked
  loop
    if not exists(select 1 from public.provider_permissions pp where pp.id=j.permission_id and pp.status='active' and (pp.starts_at is null or pp.starts_at<=now()) and (pp.expires_at is null or pp.expires_at>now())) then
      update public.ingestion_jobs set status='paused',updated_at=now() where id=j.id; continue;
    end if;
    select id into v_parser from public.parser_versions where tenant_id=j.tenant_id and data_provider_id=j.data_provider_id and entity_type=j.entity_type and status='active' order by created_at desc limit 1;
    insert into public.ingestion_runs(tenant_id,ingestion_job_id,parser_version_id,status,requested_records,max_attempts,next_attempt_at,metadata)
    values(j.tenant_id,j.id,v_parser,'scheduled',j.max_records,coalesce((j.adapter_configuration->>'max_retries')::integer,5),now(),jsonb_build_object('adapter_key',j.adapter_key)) returning * into r;
    insert into public.crawl_plans(tenant_id,ingestion_run_id,priority_bucket,filter_definition,sort_order)
    select j.tenant_id,r.id,x.bucket,j.filter_definition||jsonb_build_object('priorityBucket',x.bucket),x.bucket from (values(1),(2),(3),(4)) x(bucket);
    insert into public.crawl_checkpoints(tenant_id,ingestion_run_id,last_filter,remaining_capacity,last_successful_step)
    values(j.tenant_id,r.id,j.filter_definition,j.max_records,'scheduled');
    update public.ingestion_jobs set last_scheduled_at=now(),next_run_at=now()+make_interval(secs=>schedule_interval_seconds),updated_at=now() where id=j.id;
    return next r;
  end loop;
end $$;

create or replace function public.claim_ingestion_runs(p_worker text,p_limit integer default 5)
returns setof public.ingestion_runs language plpgsql security definer set search_path=public as $$
begin
  return query with picked as (
    select id from public.ingestion_runs where status in ('scheduled','failed') and next_attempt_at<=now() and (locked_at is null or locked_at<now()-interval '15 minutes') and attempts<max_attempts
    order by created_at limit greatest(1,least(p_limit,25)) for update skip locked
  ) update public.ingestion_runs ir set status='running',locked_at=now(),locked_by=left(p_worker,200),attempts=attempts+1,started_at=coalesce(started_at,now()) from picked where ir.id=picked.id returning ir.*;
end $$;

create or replace function public.record_ingestion_raw_payload(
  p_ingestion_run_id uuid,p_external_identifier text,p_content_type text,p_http_status integer,p_request_id text,p_response_headers jsonb,p_source_timestamp timestamptz,p_payload_sha256 text,p_payload_ciphertext text,p_storage_path text,p_metadata jsonb default '{}'::jsonb
) returns uuid language plpgsql security definer set search_path=public as $$
declare v_run public.ingestion_runs%rowtype; v_job public.ingestion_jobs%rowtype; v_id uuid; v_retention integer;
begin
  select * into v_run from public.ingestion_runs where id=p_ingestion_run_id for update;
  if not found then raise exception 'ingestion_run_not_found'; end if;
  select * into v_job from public.ingestion_jobs where id=v_run.ingestion_job_id;
  select retention_days into v_retention from public.provider_permissions where id=v_job.permission_id;
  insert into public.raw_payloads(tenant_id,ingestion_run_id,permission_id,external_identifier,content_type,http_status,request_id,response_headers,source_timestamp,parser_version_id,payload_ciphertext,storage_path,payload_sha256,retention_until,metadata,parse_status)
  values(v_run.tenant_id,v_run.id,v_job.permission_id,p_external_identifier,coalesce(p_content_type,'application/octet-stream'),p_http_status,p_request_id,coalesce(p_response_headers,'{}'),p_source_timestamp,v_run.parser_version_id,p_payload_ciphertext,p_storage_path,p_payload_sha256,case when v_retention is null then null else now()+make_interval(days=>v_retention) end,coalesce(p_metadata,'{}'),'pending') returning id into v_id;
  return v_id;
end $$;

create or replace function public.source_priority_for(p_tenant uuid,p_field text,p_source_class text)
returns integer language sql stable security definer set search_path=public as $$
  select coalesce((select priority from public.source_priority_policies where tenant_id=p_tenant and active and source_class=p_source_class and field_key=p_field limit 1),(select priority from public.source_priority_policies where tenant_id=p_tenant and active and source_class=p_source_class and field_key='*' limit 1),100)
$$;

create or replace function public.complete_ingestion_record(
  p_ingestion_run_id uuid,p_raw_payload_id uuid,p_external_identifier text,p_facts jsonb,p_canonical jsonb,p_page_fingerprint text default null,p_source_timestamp timestamptz default null
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_run public.ingestion_runs%rowtype; v_job public.ingestion_jobs%rowtype; v_provider public.data_providers%rowtype; v_perm public.provider_permissions%rowtype;
  v_entity public.master_entities%rowtype; v_source public.source_entities%rowtype; v_fact jsonb; v_key text; v_val jsonb; v_hash text; v_sf uuid; v_existing public.field_values%rowtype;
  v_priority integer; v_ttl integer:=20; v_fresh timestamptz; v_new boolean:=false; v_changed integer:=0; v_unchanged integer:=0; v_removed integer:=0; v_match text:='new'; v_owner uuid; v_present text[]:='{}'; v_expected text[]:='{}'; v_rate numeric:=1; v_disappear numeric:=0; v_parser public.parser_versions%rowtype;
begin
  select * into v_run from public.ingestion_runs where id=p_ingestion_run_id for update;
  if not found or v_run.status<>'running' then raise exception 'ingestion_run_not_running'; end if;
  select * into v_job from public.ingestion_jobs where id=v_run.ingestion_job_id;
  select * into v_provider from public.data_providers where id=v_job.data_provider_id;
  select * into v_perm from public.provider_permissions where id=v_job.permission_id and status='active';
  if not found then raise exception 'provider_permission_inactive'; end if;
  if p_raw_payload_id is null or not exists(select 1 from public.raw_payloads where id=p_raw_payload_id and ingestion_run_id=v_run.id) then raise exception 'raw_payload_must_be_saved_before_parse'; end if;
  select * into v_parser from public.parser_versions where id=v_run.parser_version_id;
  v_owner:=case when v_perm.cache_scope='global' then null else v_run.tenant_id end;

  select me.* into v_entity from public.master_entities me
  where me.merged_into_id is null and (
    (nullif(p_canonical->>'organization_number','') is not null and me.entity_type='organization' and me.organization_number=p_canonical->>'organization_number' and (me.owner_tenant_id is not distinct from v_owner))
    or exists(select 1 from public.entity_source_links esl join public.source_entities se on se.id=esl.source_entity_id where esl.master_entity_id=me.id and se.data_provider_id=v_job.data_provider_id and se.provider_account_id is not distinct from v_job.provider_account_id and se.entity_type=v_job.entity_type and se.external_identifier=p_external_identifier)
    or (nullif(p_canonical->>'phone_e164','') is not null and me.phone_e164=p_canonical->>'phone_e164' and me.owner_tenant_id is not distinct from v_owner)
    or (nullif(p_canonical->>'email','') is not null and me.email=(p_canonical->>'email')::citext and me.owner_tenant_id is not distinct from v_owner)
  ) order by case when me.organization_number=p_canonical->>'organization_number' then 1 when me.external_primary_id=p_external_identifier then 2 else 3 end limit 1 for update;

  if not found then
    insert into public.master_entities(entity_type,cache_scope,owner_tenant_id,license_tenant_id,data_provider_id,provider_account_id,permission_id,canonical_name,organization_number,external_primary_id,country_code)
    values(v_job.entity_type,v_perm.cache_scope,v_owner,v_run.tenant_id,v_job.data_provider_id,v_job.provider_account_id,v_job.permission_id,coalesce(nullif(p_canonical->>'canonical_name',''),p_external_identifier),nullif(p_canonical->>'organization_number',''),p_external_identifier,coalesce(nullif(p_canonical->>'country_code',''),'SE')) returning * into v_entity;
    v_new:=true; v_match:='created';
  else
    v_match:=case when v_entity.organization_number=p_canonical->>'organization_number' then 'organization_number' when v_entity.external_primary_id=p_external_identifier then 'external_id' when v_entity.phone_e164=p_canonical->>'phone_e164' then 'phone' else 'email' end;
  end if;

  insert into public.source_entities(owner_tenant_id,data_provider_id,provider_account_id,permission_id,entity_type,external_identifier,raw_payload_id,last_seen_at,removed_at,parser_version_id,metadata)
  values(v_run.tenant_id,v_job.data_provider_id,v_job.provider_account_id,v_job.permission_id,v_job.entity_type,p_external_identifier,p_raw_payload_id,now(),null,v_run.parser_version_id,jsonb_build_object('ingestion_run_id',v_run.id))
  on conflict(data_provider_id,provider_account_id,entity_type,external_identifier) do update set raw_payload_id=excluded.raw_payload_id,last_seen_at=now(),removed_at=null,parser_version_id=excluded.parser_version_id,metadata=public.source_entities.metadata||excluded.metadata returning * into v_source;
  insert into public.entity_source_links(master_entity_id,source_entity_id,match_method,confidence) values(v_entity.id,v_source.id,v_match,case when v_match in ('organization_number','external_id') then 1 else .8 end) on conflict(master_entity_id,source_entity_id) do update set match_method=excluded.match_method,confidence=greatest(public.entity_source_links.confidence,excluded.confidence);

  select coalesce(ttl_days,20) into v_ttl from public.provider_freshness_policies where data_provider_id=v_job.data_provider_id and entity_type=v_job.entity_type and field_key is null and active order by created_at desc limit 1;
  v_fresh:=now()+make_interval(days=>coalesce(v_ttl,20));

  for v_fact in select value from jsonb_array_elements(coalesce(p_facts,'[]'::jsonb)) loop
    v_key:=v_fact->>'field_key'; v_val:=v_fact->'field_value'; v_hash:=coalesce(v_fact->>'value_hash',encode(digest(v_val::text,'sha256'),'hex')); v_present:=array_append(v_present,v_key);
    if not exists(select 1 from public.provider_field_permissions where tenant_id=v_run.tenant_id and permission_id=v_job.permission_id and entity_type=v_job.entity_type and field_key=v_key and may_fetch and may_store) then continue; end if;
    insert into public.source_facts(source_entity_id,field_key,field_value,value_hash,fetched_at,last_seen_at,verified_at,confidence,parser_version_id,permission_id,removed_at)
    values(v_source.id,v_key,v_val,v_hash,now(),now(),coalesce(p_source_timestamp,now()),coalesce((v_fact->>'confidence')::numeric,.75),v_run.parser_version_id,v_job.permission_id,null)
    on conflict(source_entity_id,field_key,value_hash) do update set last_seen_at=now(),verified_at=coalesce(excluded.verified_at,public.source_facts.verified_at),removed_at=null returning id into v_sf;
    v_priority:=public.source_priority_for(v_run.tenant_id,v_key,v_provider.source_class);
    select * into v_existing from public.field_values where master_entity_id=v_entity.id and field_key=v_key for update;
    if not found then
      insert into public.field_values(master_entity_id,field_key,field_value,selected_source_fact_id,source_priority,confidence,verified_at,fresh_until)
      values(v_entity.id,v_key,v_val,v_sf,v_priority,coalesce((v_fact->>'confidence')::numeric,.75),coalesce(p_source_timestamp,now()),v_fresh);
      insert into public.field_value_history(master_entity_id,field_key,new_value,source_fact_id,change_type) values(v_entity.id,v_key,v_val,v_sf,'created'); v_changed:=v_changed+1;
    elsif v_existing.field_value is distinct from v_val and (v_existing.manually_verified or v_existing.source_priority<v_priority) then
      insert into public.data_conflicts(tenant_id,master_entity_id,field_key,candidate_values)
      select v_run.tenant_id,v_entity.id,v_key,jsonb_build_array(jsonb_build_object('value',v_existing.field_value,'priority',v_existing.source_priority,'sourceFactId',v_existing.selected_source_fact_id),jsonb_build_object('value',v_val,'priority',v_priority,'sourceFactId',v_sf))
      where not exists(select 1 from public.data_conflicts where tenant_id=v_run.tenant_id and master_entity_id=v_entity.id and field_key=v_key and status='open');
      insert into public.field_value_history(master_entity_id,field_key,old_value,new_value,source_fact_id,change_type) values(v_entity.id,v_key,v_existing.field_value,v_val,v_sf,'conflict');
    elsif v_existing.field_value is distinct from v_val then
      insert into public.field_value_history(master_entity_id,field_key,old_value,new_value,source_fact_id,change_type) values(v_entity.id,v_key,v_existing.field_value,v_val,v_sf,'changed');
      update public.field_values set field_value=v_val,selected_source_fact_id=v_sf,source_priority=v_priority,confidence=coalesce((v_fact->>'confidence')::numeric,.75),verified_at=coalesce(p_source_timestamp,now()),fresh_until=v_fresh,updated_at=now() where id=v_existing.id; v_changed:=v_changed+1;
    else
      update public.field_values set selected_source_fact_id=case when v_priority<=source_priority then v_sf else selected_source_fact_id end,source_priority=least(source_priority,v_priority),confidence=greatest(confidence,coalesce((v_fact->>'confidence')::numeric,.75)),verified_at=coalesce(p_source_timestamp,verified_at),fresh_until=v_fresh,updated_at=now() where id=v_existing.id; v_unchanged:=v_unchanged+1;
    end if;
    insert into public.field_freshness(master_entity_id,field_key,verified_at,fresh_until,next_refresh_at,state,updated_at) values(v_entity.id,v_key,coalesce(p_source_timestamp,now()),v_fresh,v_fresh,'fresh',now()) on conflict(master_entity_id,field_key) do update set verified_at=excluded.verified_at,fresh_until=excluded.fresh_until,next_refresh_at=excluded.next_refresh_at,state='fresh',updated_at=now();
  end loop;

  for v_key in select distinct sf.field_key from public.source_facts sf where sf.source_entity_id=v_source.id and sf.removed_at is null and not (sf.field_key=any(v_present)) loop
    update public.source_facts set removed_at=now() where source_entity_id=v_source.id and field_key=v_key and removed_at is null;
    if exists(select 1 from public.field_values fv join public.source_facts sf on sf.id=fv.selected_source_fact_id where fv.master_entity_id=v_entity.id and fv.field_key=v_key and sf.source_entity_id=v_source.id) then
      insert into public.field_value_history(master_entity_id,field_key,old_value,new_value,source_fact_id,change_type) select v_entity.id,v_key,field_value,null,selected_source_fact_id,'removed' from public.field_values where master_entity_id=v_entity.id and field_key=v_key;
      v_removed:=v_removed+1;
    end if;
  end loop;

  perform public.rebuild_master_entity(v_entity.id);
  update public.master_entities set enriched_at=now(),fresh_until=v_fresh,next_refresh_at=v_fresh,source_removed_at=null,updated_at=now() where id=v_entity.id;
  insert into public.entity_freshness(master_entity_id,state,enriched_at,fresh_until,next_refresh_at,last_refresh_completed_at,updated_at) values(v_entity.id,'fresh',now(),v_fresh,v_fresh,now(),now()) on conflict(master_entity_id) do update set state='fresh',enriched_at=now(),fresh_until=excluded.fresh_until,next_refresh_at=excluded.next_refresh_at,last_refresh_completed_at=now(),last_error=null,updated_at=now();

  insert into public.identity_keys(tenant_id,master_entity_id,key_type,normalized_value,confidence,source_entity_id)
  select v_run.tenant_id,v_entity.id,x.key_type,public.normalize_identity_value(x.key_type,x.val),x.conf,v_source.id from (values
    ('organization_number',nullif(p_canonical->>'organization_number',''),1.0),('external_id',p_external_identifier,1.0),('phone',nullif(p_canonical->>'phone_e164',''),.8),('email',nullif(p_canonical->>'email',''),.8),('website_domain',nullif(p_canonical->>'website',''),.7),('name_postal',nullif(lower(coalesce(p_canonical->>'canonical_name',''))||'|'||coalesce(p_canonical->>'postal_code',''),'|'),.6)
  ) x(key_type,val,conf) where x.val is not null on conflict(tenant_id,key_type,normalized_value,master_entity_id) do update set confidence=greatest(public.identity_keys.confidence,excluded.confidence),updated_at=now();

  insert into public.duplicate_candidates(tenant_id,left_entity_id,right_entity_id,match_method,confidence)
  select v_run.tenant_id,least(v_entity.id,ik.master_entity_id),greatest(v_entity.id,ik.master_entity_id),ik.key_type,case when ik.key_type in ('organization_number','external_id') then 1 else .8 end
  from public.identity_keys mine join public.identity_keys ik on ik.tenant_id=mine.tenant_id and ik.key_type=mine.key_type and ik.normalized_value=mine.normalized_value and ik.master_entity_id<>mine.master_entity_id
  where mine.tenant_id=v_run.tenant_id and mine.master_entity_id=v_entity.id
  on conflict do nothing;

  if v_run.parser_version_id is not null then
    v_expected:=coalesce(v_parser.expected_fields,'{}');
    v_rate:=case when cardinality(v_expected)=0 then 1 else (select count(*)::numeric/cardinality(v_expected) from unnest(v_expected) e where e=any(v_present)) end;
    select case when cardinality(prior.present_fields)=0 then 0 else
      (select count(*)::numeric/cardinality(prior.present_fields) from unnest(prior.present_fields) f where not f=any(v_present)) end
    into v_disappear
    from (select po.present_fields from public.parser_observations po where po.parser_version_id=v_run.parser_version_id and po.status in ('accepted','approved') and po.created_at>now()-interval '90 days' order by po.created_at desc limit 1) prior;
    v_disappear:=coalesce(v_disappear,0);
    insert into public.parser_observations(tenant_id,parser_version_id,ingestion_run_id,raw_payload_id,page_fingerprint,present_fields,missing_fields,match_rate,disappearance_rate,status,details)
    values(v_run.tenant_id,v_run.parser_version_id,v_run.id,p_raw_payload_id,p_page_fingerprint,v_present,array(select e from unnest(v_expected)e where not e=any(v_present)),v_rate,v_disappear,case when v_rate<v_parser.minimum_match_rate or v_disappear>v_parser.disappearance_threshold or (v_parser.page_fingerprint is not null and p_page_fingerprint is distinct from v_parser.page_fingerprint) then 'quarantined' else 'accepted' end,jsonb_build_object('entityId',v_entity.id));
    if v_rate<v_parser.minimum_match_rate or v_disappear>v_parser.disappearance_threshold or (v_parser.page_fingerprint is not null and p_page_fingerprint is distinct from v_parser.page_fingerprint) then
      update public.ingestion_runs set status='quarantined',last_error='parser_structure_change',parser_fingerprint=p_page_fingerprint where id=v_run.id;
      update public.raw_payloads set parse_status='quarantined',parse_error='parser_structure_change' where id=p_raw_payload_id;
      update public.parser_versions set status='paused' where id=v_run.parser_version_id;
      return jsonb_build_object('quarantined',true,'masterEntityId',v_entity.id,'reason','parser_structure_change','matchRate',v_rate,'disappearanceRate',v_disappear);
    end if;
  end if;

  update public.raw_payloads set parse_status='parsed',parse_error=null where id=p_raw_payload_id;
  update public.ingestion_runs set fetched_records=fetched_records+1,new_records=new_records+(case when v_new then 1 else 0 end),changed_records=changed_records+(case when v_changed>0 then 1 else 0 end),unchanged_records=unchanged_records+(case when not v_new and v_changed=0 then 1 else 0 end),parser_fingerprint=coalesce(p_page_fingerprint,parser_fingerprint),metadata=metadata||jsonb_build_object('removedFields',coalesce((metadata->>'removedFields')::integer,0)+v_removed) where id=v_run.id;
  update public.crawl_checkpoints set last_external_identifier=p_external_identifier,last_processed_record=p_external_identifier,fetched_records=fetched_records+1,new_records=new_records+(case when v_new then 1 else 0 end),changed_records=changed_records+(case when v_changed>0 then 1 else 0 end),unchanged_records=unchanged_records+(case when not v_new and v_changed=0 then 1 else 0 end),remaining_capacity=greatest(coalesce(remaining_capacity,v_job.max_records)-1,0),last_successful_step='record_completed',last_error=null,updated_at=now() where ingestion_run_id=v_run.id and crawl_plan_id is null;
  return jsonb_build_object('masterEntityId',v_entity.id,'sourceEntityId',v_source.id,'new',v_new,'changedFields',v_changed,'unchangedFields',v_unchanged,'removedFields',v_removed,'matchMethod',v_match);
end $$;

create or replace function public.complete_ingestion_run(p_run_id uuid,p_next_page text default null,p_metadata jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path=public as $$
declare v_run public.ingestion_runs%rowtype;
begin
  select * into v_run from public.ingestion_runs where id=p_run_id for update;
  if not found then raise exception 'ingestion_run_not_found'; end if;
  update public.ingestion_runs set status='completed',next_page=p_next_page,completed_at=now(),locked_at=null,locked_by=null,metadata=metadata||coalesce(p_metadata,'{}') where id=p_run_id;
  update public.ingestion_jobs set last_completed_at=now(),updated_at=now() where id=v_run.ingestion_job_id;
  update public.crawl_plans set status='completed' where ingestion_run_id=p_run_id and status in ('pending','running');
  update public.crawl_checkpoints set last_successful_step='run_completed',updated_at=now() where ingestion_run_id=p_run_id;
end $$;

create or replace function public.fail_ingestion_run(p_run_id uuid,p_error text,p_retryable boolean default true,p_delay_seconds integer default 60,p_raw_payload_id uuid default null,p_details jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path=public as $$
declare v public.ingestion_runs%rowtype; terminal boolean;
begin
  select * into v from public.ingestion_runs where id=p_run_id for update; if not found then raise exception 'ingestion_run_not_found'; end if;
  terminal:=not p_retryable or v.attempts>=v.max_attempts or v.status='quarantined';
  update public.ingestion_runs set status=case when v.status='quarantined' then 'quarantined'::public.ingestion_state when terminal then 'failed'::public.ingestion_state else 'failed'::public.ingestion_state end,next_attempt_at=case when terminal then next_attempt_at else now()+make_interval(secs=>greatest(1,p_delay_seconds)) end,locked_at=null,locked_by=null,last_error=left(p_error,4000),completed_at=case when terminal then now() else null end where id=p_run_id;
  insert into public.ingestion_errors(tenant_id,ingestion_run_id,raw_payload_id,stage,error_code,message,retryable,details) values(v.tenant_id,p_run_id,p_raw_payload_id,'ingestion_worker',split_part(p_error,':',1),left(p_error,4000),p_retryable,coalesce(p_details,'{}'));
  update public.crawl_checkpoints set last_error=left(p_error,4000),next_retry_at=case when terminal then null else now()+make_interval(secs=>greatest(1,p_delay_seconds)) end,updated_at=now() where ingestion_run_id=p_run_id;
end $$;

create or replace function public.refresh_segment_materialization(p_segment_id uuid,p_actor uuid default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare s public.segments%rowtype; snap uuid; total integer;
begin
  select * into s from public.segments where id=p_segment_id for update; if not found then raise exception 'segment_not_found'; end if;
  insert into public.segment_snapshots(tenant_id,segment_id,rule_definition,generated_by) values(s.tenant_id,s.id,s.rule_definition,p_actor) returning id into snap;
  insert into public.segment_memberships(tenant_id,snapshot_id,segment_id,master_entity_id)
  select s.tenant_id,snap,s.id,me.id
  from public.master_entities me
  join public.provider_permissions pp on pp.id=me.permission_id
  join public.data_providers dp on dp.id=me.data_provider_id
  left join public.tenant_entities te on te.tenant_id=s.tenant_id and te.master_entity_id=me.id
  left join public.customers c on c.tenant_id=s.tenant_id and c.id=te.customer_id and c.deleted_at is null
  left join lateral (select n.result from public.nix_checks n where n.tenant_id=s.tenant_id and n.phone_e164=coalesce(c.phone_e164,me.phone_e164) and n.valid_until>now() order by n.checked_at desc limit 1) nx on true
  where me.merged_into_id is null and me.source_removed_at is null and me.entity_type=s.entity_type
    and (nullif(s.rule_definition->>'countryCode','') is null or me.country_code=s.rule_definition->>'countryCode')
    and (nullif(s.rule_definition->>'query','') is null or me.canonical_name ilike '%'||(s.rule_definition->>'query')||'%' or me.organization_number ilike '%'||(s.rule_definition->>'query')||'%')
    and (nullif(s.rule_definition->>'county','') is null or me.county=s.rule_definition->>'county')
    and (nullif(s.rule_definition->>'municipality','') is null or me.municipality=s.rule_definition->>'municipality')
    and (nullif(s.rule_definition->>'city','') is null or me.city=s.rule_definition->>'city')
    and (nullif(s.rule_definition->>'postalCode','') is null or me.postal_code like (s.rule_definition->>'postalCode')||'%')
    and (nullif(s.rule_definition->>'sniCode','') is null or me.sni_code like (s.rule_definition->>'sniCode')||'%')
    and (nullif(s.rule_definition->>'legalForm','') is null or me.legal_form=s.rule_definition->>'legalForm')
    and (nullif(s.rule_definition->>'organizationStatus','') is null or me.organization_status=s.rule_definition->>'organizationStatus')
    and (s.rule_definition->>'dataProviderId' is null or me.data_provider_id=(s.rule_definition->>'dataProviderId')::uuid)
    and (nullif(s.rule_definition->>'sourceProvider','') is null or dp.provider=s.rule_definition->>'sourceProvider' or dp.name ilike '%'||(s.rule_definition->>'sourceProvider')||'%')
    and (s.rule_definition->>'ageMin' is null or (me.date_of_birth is not null and extract(year from age(current_date,me.date_of_birth))>=(s.rule_definition->>'ageMin')::integer))
    and (s.rule_definition->>'ageMax' is null or (me.date_of_birth is not null and extract(year from age(current_date,me.date_of_birth))<=(s.rule_definition->>'ageMax')::integer))
    and (s.rule_definition->>'employeeMin' is null or me.employee_count>=(s.rule_definition->>'employeeMin')::integer)
    and (s.rule_definition->>'employeeMax' is null or me.employee_count<=(s.rule_definition->>'employeeMax')::integer)
    and (s.rule_definition->>'revenueMin' is null or me.revenue>=(s.rule_definition->>'revenueMin')::numeric)
    and (s.rule_definition->>'revenueMax' is null or me.revenue<=(s.rule_definition->>'revenueMax')::numeric)
    and (s.rule_definition->>'resultMin' is null or me.result>=(s.rule_definition->>'resultMin')::numeric)
    and (s.rule_definition->>'resultMax' is null or me.result<=(s.rule_definition->>'resultMax')::numeric)
    and (s.rule_definition->>'hasPhone' is null or (me.phone_e164 is not null)=(s.rule_definition->>'hasPhone')::boolean)
    and (s.rule_definition->>'hasEmail' is null or (me.email is not null)=(s.rule_definition->>'hasEmail')::boolean)
    and (s.rule_definition->>'hasWebsite' is null or (me.website is not null)=(s.rule_definition->>'hasWebsite')::boolean)
    and (s.rule_definition->>'phoneType' is null or me.phone_type=s.rule_definition->>'phoneType')
    and (s.rule_definition->>'freshOnly' is null or not(s.rule_definition->>'freshOnly')::boolean or me.fresh_until>now())
    and (s.rule_definition->>'dataAgeDaysMax' is null or me.enriched_at>=now()-make_interval(days=>(s.rule_definition->>'dataAgeDaysMax')::integer))
    and (s.rule_definition->>'registrationFrom' is null or me.registration_date>=(s.rule_definition->>'registrationFrom')::date)
    and (s.rule_definition->>'registrationTo' is null or me.registration_date<=(s.rule_definition->>'registrationTo')::date)
    and (s.rule_definition->>'fTaxRegistered' is null or me.f_tax_registered=(s.rule_definition->>'fTaxRegistered')::boolean)
    and (s.rule_definition->>'vatRegistered' is null or me.vat_registered=(s.rule_definition->>'vatRegistered')::boolean)
    and (s.rule_definition->>'employerRegistered' is null or me.employer_registered=(s.rule_definition->>'employerRegistered')::boolean)
    and (s.rule_definition->>'latitude' is null or s.rule_definition->>'longitude' is null or s.rule_definition->>'radiusKm' is null or public.haversine_km(me.latitude,me.longitude,(s.rule_definition->>'latitude')::numeric,(s.rule_definition->>'longitude')::numeric)<=(s.rule_definition->>'radiusKm')::numeric)
    and (s.rule_definition->>'previouslyContacted' is null or (c.last_contact_at is not null)=(s.rule_definition->>'previouslyContacted')::boolean)
    and (s.rule_definition->>'callAttemptsMin' is null or coalesce(c.call_attempts,0)>=(s.rule_definition->>'callAttemptsMin')::integer)
    and (s.rule_definition->>'campaignId' is null or c.campaign_id=(s.rule_definition->>'campaignId')::uuid)
    and (s.rule_definition->>'customerLifecycle' is null or c.lifecycle::text=s.rule_definition->>'customerLifecycle')
    and (s.rule_definition->>'assignedUserId' is null or c.assigned_user_id=(s.rule_definition->>'assignedUserId')::uuid)
    and (s.rule_definition->>'assignedTeamId' is null or c.assigned_team_id=(s.rule_definition->>'assignedTeamId')::uuid)
    and (s.rule_definition->>'hasContactPerson' is null or ((exists(select 1 from public.contact_people cp where cp.tenant_id=s.tenant_id and cp.customer_id=c.id)) or coalesce((me.current_master->>'contact_person_count')::integer,0)>0)=(s.rule_definition->>'hasContactPerson')::boolean)
    and (s.rule_definition->>'contractStatus' is null or exists(select 1 from public.contracts ct where ct.tenant_id=s.tenant_id and ct.customer_id=c.id and ct.status::text=s.rule_definition->>'contractStatus'))
    and (s.rule_definition->>'activeContract' is null or (exists(select 1 from public.contracts ct where ct.tenant_id=s.tenant_id and ct.customer_id=c.id and ct.status in ('signed','active') and (ct.ends_on is null or ct.ends_on>=current_date)))=(s.rule_definition->>'activeContract')::boolean)
    and (s.rule_definition->>'nixStatus' is null or coalesce(nx.result,'missing')=s.rule_definition->>'nixStatus')
    and (s.rule_definition->>'blocked' is null or (coalesce(c.do_not_call,false) or coalesce(c.do_not_sms,false) or coalesce(c.do_not_email,false) or exists(select 1 from public.compliance_blocks cb where cb.tenant_id=s.tenant_id and cb.active and (cb.expires_at is null or cb.expires_at>now()) and (cb.customer_id=c.id or cb.phone_e164=coalesce(c.phone_e164,me.phone_e164) or cb.email=coalesce(c.email,me.email))))=(s.rule_definition->>'blocked')::boolean)
    and (s.rule_definition->>'allowedChannel' is null or (c.id is not null and public.evaluate_contact_policy_for_tenant(s.tenant_id,c.id,s.rule_definition->>'allowedChannel','direct_marketing')->>'allowed'='true'))
    and (me.owner_tenant_id=s.tenant_id
      or (me.cache_scope='global' and pp.status='active' and pp.cache_scope='global' and pp.cross_tenant_reuse_allowed and pp.tenant_display_allowed and (pp.starts_at is null or pp.starts_at<=now()) and (pp.expires_at is null or pp.expires_at>now()))
      or (me.cache_scope='provider_account' and pp.status='active' and pp.tenant_display_allowed and exists(select 1 from public.provider_account_tenants pat where pat.provider_account_id=me.provider_account_id and pat.tenant_id=s.tenant_id)));
  get diagnostics total=row_count;
  update public.segment_snapshots set member_count=total where id=snap; update public.segments set last_refreshed_at=now(),updated_at=now() where id=s.id;
  if s.segment_type='dynamic' then delete from public.segment_snapshots where segment_id=s.id and id<>snap and generated_at<now()-interval '30 days'; end if;
  return jsonb_build_object('snapshotId',snap,'memberCount',total);
end $$;

create or replace function public.queue_due_segment_refreshes(p_limit integer default 100)
returns integer language plpgsql security definer set search_path=public as $$
declare n integer;
begin
  insert into public.segment_refresh_jobs(tenant_id,segment_id,reason)
  select tenant_id,id,'scheduled' from public.segments s where active and segment_type='dynamic' and (last_refreshed_at is null or last_refreshed_at<now()-interval '15 minutes') order by last_refreshed_at nulls first limit greatest(1,least(p_limit,500)) on conflict do nothing;
  get diagnostics n=row_count; return n;
end $$;

create or replace function public.claim_segment_refresh_jobs(p_worker text,p_limit integer default 10)
returns setof public.segment_refresh_jobs language plpgsql security definer set search_path=public as $$
begin
 return query with picked as (select id from public.segment_refresh_jobs where status='queued' and next_attempt_at<=now() and (locked_at is null or locked_at<now()-interval '15 minutes') order by created_at limit greatest(1,least(p_limit,50)) for update skip locked)
 update public.segment_refresh_jobs j set status='running',locked_at=now(),locked_by=left(p_worker,200),attempts=attempts+1 from picked where j.id=picked.id returning j.*;
end $$;

create or replace function public.complete_segment_refresh_job(p_job_id uuid,p_error text default null)
returns void language plpgsql security definer set search_path=public as $$
declare j public.segment_refresh_jobs%rowtype;
begin
 select * into j from public.segment_refresh_jobs where id=p_job_id for update; if not found then return; end if;
 if p_error is null then perform public.refresh_segment_materialization(j.segment_id,null); update public.segment_refresh_jobs set status='completed',completed_at=now(),locked_at=null,locked_by=null,last_error=null where id=j.id;
 else update public.segment_refresh_jobs set status=case when attempts>=5 then 'failed' else 'queued' end,next_attempt_at=now()+make_interval(secs=>least(3600,power(2,attempts)::integer*30)),locked_at=null,locked_by=null,last_error=left(p_error,4000) where id=j.id; end if;
end $$;

create or replace function public.materialize_segment_to_campaign(p_segment_id uuid,p_campaign_id uuid,p_actor uuid default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare s public.segments%rowtype; snap uuid; r record; cust uuid; created_customers integer:=0; added integer:=0;
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
    if public.evaluate_contact_policy_for_tenant(s.tenant_id,cust,'call','direct_marketing')->>'allowed'='true' then
      insert into public.campaign_members(tenant_id,campaign_id,customer_id) values(s.tenant_id,p_campaign_id,cust) on conflict do nothing; if found then added:=added+1; end if;
    end if;
  end loop;
  return jsonb_build_object('snapshotId',snap,'createdCustomers',created_customers,'addedToCampaign',added);
end $$;

create or replace function public.merge_master_entities(p_tenant_id uuid,p_target uuid,p_source uuid,p_actor uuid)
returns uuid language plpgsql security definer set search_path=public as $$
declare d uuid; snap jsonb;
begin
  if p_target=p_source then raise exception 'merge_entities_must_differ'; end if;
  if not public.is_tenant_admin(p_tenant_id) and auth.uid() is not null then raise exception 'admin_required'; end if;
  if not exists(select 1 from public.directory_entity_for_tenant(p_tenant_id,p_target)) or not exists(select 1 from public.directory_entity_for_tenant(p_tenant_id,p_source)) then raise exception 'entity_not_accessible'; end if;
  select jsonb_build_object('sourceLinks',coalesce(jsonb_agg(esl.source_entity_id),'[]'::jsonb),'identityKeys',coalesce((select jsonb_agg(id) from public.identity_keys where tenant_id=p_tenant_id and master_entity_id=p_source),'[]'::jsonb)) into snap from public.entity_source_links esl where esl.master_entity_id=p_source;
  insert into public.merge_decisions(tenant_id,target_entity_id,source_entity_id,decision,snapshot,decided_by) values(p_tenant_id,p_target,p_source,'merged',coalesce(snap,'{}'),p_actor) returning id into d;
  insert into public.entity_source_links(master_entity_id,source_entity_id,match_method,confidence,manually_verified) select p_target,source_entity_id,'manual_merge',confidence,true from public.entity_source_links where master_entity_id=p_source on conflict do nothing;
  delete from public.entity_source_links where master_entity_id=p_source;
  update public.identity_keys set master_entity_id=p_target,updated_at=now() where tenant_id=p_tenant_id and master_entity_id=p_source and not exists(select 1 from public.identity_keys x where x.tenant_id=p_tenant_id and x.master_entity_id=p_target and x.key_type=public.identity_keys.key_type and x.normalized_value=public.identity_keys.normalized_value);
  update public.master_entities set merged_into_id=p_target,merged_at=now(),updated_at=now() where id=p_source;
  update public.duplicate_candidates set status='merged',reviewed_by=p_actor,reviewed_at=now() where tenant_id=p_tenant_id and ((left_entity_id=p_target and right_entity_id=p_source) or (left_entity_id=p_source and right_entity_id=p_target));
  perform public.rebuild_master_entity(p_target); return d;
end $$;

create or replace function public.undo_master_entity_merge(p_decision_id uuid,p_actor uuid)
returns void language plpgsql security definer set search_path=public as $$
declare d public.merge_decisions%rowtype; sid text;
begin
 select * into d from public.merge_decisions where id=p_decision_id and decision='merged' and undone_at is null for update; if not found then raise exception 'merge_decision_not_found'; end if;
 if not public.is_tenant_admin(d.tenant_id) and auth.uid() is not null then raise exception 'admin_required'; end if;
 for sid in select jsonb_array_elements_text(coalesce(d.snapshot->'sourceLinks','[]'::jsonb)) loop
   insert into public.entity_source_links(master_entity_id,source_entity_id,match_method,confidence,manually_verified) values(d.source_entity_id,sid::uuid,'merge_undo',1,true) on conflict do nothing;
   delete from public.entity_source_links where master_entity_id=d.target_entity_id and source_entity_id=sid::uuid;
 end loop;
 update public.master_entities set merged_into_id=null,merged_at=null,updated_at=now() where id=d.source_entity_id;
 update public.merge_decisions set undone_by=p_actor,undone_at=now(),decision='undone' where id=d.id;
end $$;

create or replace function public.run_retention_maintenance(p_tenant_id uuid,p_limit integer default 1000)
returns jsonb language plpgsql security definer set search_path=public as $$
declare rid uuid; deleted integer:=0; anonymized integer:=0;
begin
 insert into public.retention_runs(tenant_id) values(p_tenant_id) returning id into rid;
 with doomed as (select id from public.raw_payloads where tenant_id=p_tenant_id and retention_until is not null and retention_until<=now() order by retention_until limit greatest(1,least(p_limit,10000)))
 update public.raw_payloads rp set payload_ciphertext=null,storage_path=null,metadata=metadata||jsonb_build_object('retentionPurgedAt',now()),parse_error=null from doomed where rp.id=doomed.id;
 get diagnostics deleted=row_count;
 update public.retention_runs set status='completed',deleted_count=deleted,anonymized_count=anonymized,completed_at=now(),details=jsonb_build_object('rawPayloadsPurged',deleted) where id=rid;
 return jsonb_build_object('runId',rid,'rawPayloadsPurged',deleted,'anonymized',anonymized);
exception when others then update public.retention_runs set status='failed',last_error=sqlerrm,completed_at=now() where id=rid; raise;
end $$;

-- Auto-queue dynamic segment refreshes when canonical entities change.
create or replace function public.queue_dynamic_segment_refresh_trigger() returns trigger language plpgsql security definer set search_path=public as $$
begin
  insert into public.segment_refresh_jobs(tenant_id,segment_id,reason)
  select s.tenant_id,s.id,'entity_changed' from public.segments s where s.active and s.segment_type='dynamic' and exists(select 1 from public.directory_entity_for_tenant(s.tenant_id,new.id)) on conflict do nothing;
  return new;
end $$;
drop trigger if exists master_entities_queue_segments on public.master_entities;
create trigger master_entities_queue_segments after insert or update of current_master,fresh_until,source_removed_at,merged_into_id on public.master_entities for each row execute function public.queue_dynamic_segment_refresh_trigger();

-- Service-only execution surfaces.
revoke all on function public.schedule_due_ingestion_jobs(integer) from public,anon,authenticated;
revoke all on function public.claim_ingestion_runs(text,integer) from public,anon,authenticated;
revoke all on function public.record_ingestion_raw_payload(uuid,text,text,integer,text,jsonb,timestamptz,text,text,text,jsonb) from public,anon,authenticated;
revoke all on function public.complete_ingestion_record(uuid,uuid,text,jsonb,jsonb,text,timestamptz) from public,anon,authenticated;
revoke all on function public.complete_ingestion_run(uuid,text,jsonb) from public,anon,authenticated;
revoke all on function public.fail_ingestion_run(uuid,text,boolean,integer,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.queue_due_segment_refreshes(integer) from public,anon,authenticated;
revoke all on function public.claim_segment_refresh_jobs(text,integer) from public,anon,authenticated;
revoke all on function public.complete_segment_refresh_job(uuid,text) from public,anon,authenticated;
revoke all on function public.run_retention_maintenance(uuid,integer) from public,anon,authenticated;
grant execute on function public.schedule_due_ingestion_jobs(integer),public.claim_ingestion_runs(text,integer),public.record_ingestion_raw_payload(uuid,text,text,integer,text,jsonb,timestamptz,text,text,text,jsonb),public.complete_ingestion_record(uuid,uuid,text,jsonb,jsonb,text,timestamptz),public.complete_ingestion_run(uuid,text,jsonb),public.fail_ingestion_run(uuid,text,boolean,integer,uuid,jsonb),public.queue_due_segment_refreshes(integer),public.claim_segment_refresh_jobs(text,integer),public.complete_segment_refresh_job(uuid,text),public.run_retention_maintenance(uuid,integer) to service_role;

grant execute on function public.directory_search_summary_for_tenant(uuid,jsonb),public.directory_search_v2_for_tenant(uuid,jsonb,integer,integer),public.directory_visible_fields_for_tenant(uuid,uuid),public.directory_entity_projection_for_tenant(uuid,uuid),public.directory_source_attribution_for_tenant(uuid,uuid),public.refresh_segment_materialization(uuid,uuid),public.materialize_segment_to_campaign(uuid,uuid,uuid),public.merge_master_entities(uuid,uuid,uuid,uuid),public.undo_master_entity_merge(uuid,uuid) to authenticated,service_role;

commit;
