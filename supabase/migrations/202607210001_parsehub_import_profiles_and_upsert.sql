begin;


create table if not exists public.import_profiles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  source_provider text not null default 'file',
  source_website text,
  format text not null default 'auto' check(format in ('auto','csv','json','ndjson','xlsx')),
  worksheet_name text,
  header_row integer not null default 1 check(header_row between 1 and 100),
  records_path text,
  target_type text not null default 'crm' check(target_type in ('crm','list','review')),
  target_list_id uuid,
  automatic_commit boolean not null default false,
  current_version integer not null default 0 check(current_version >= 0),
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(tenant_id,id),
  unique(tenant_id,name),
  foreign key(tenant_id,target_list_id) references public.customer_lists(tenant_id,id) on delete set null
);

create table if not exists public.import_profile_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  import_profile_id uuid not null,
  version integer not null check(version > 0),
  config jsonb not null default '{}'::jsonb,
  field_mapping jsonb not null default '{}'::jsonb,
  mapping_checksum text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique(tenant_id,id),
  unique(import_profile_id,version),
  foreign key(tenant_id,import_profile_id) references public.import_profiles(tenant_id,id) on delete cascade
);

create table if not exists public.import_field_mappings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  import_profile_version_id uuid not null,
  target_scope text not null check(target_scope in ('company','contact')),
  target_field text not null,
  source_path text,
  transform_chain jsonb not null default '[]'::jsonb,
  default_value jsonb,
  required boolean not null default false,
  sort_order integer not null default 100,
  created_at timestamptz not null default now(),
  unique(tenant_id,id),
  unique(import_profile_version_id,target_scope,target_field),
  foreign key(tenant_id,import_profile_version_id) references public.import_profile_versions(tenant_id,id) on delete cascade
);

create table if not exists public.parsehub_projects (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  provider_account_id uuid,
  import_profile_id uuid,
  project_token_hash text not null,
  project_name text not null,
  source_website text,
  webhook_secret_hash text,
  active boolean not null default true,
  configuration jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(tenant_id,id),
  unique(tenant_id,project_token_hash),
  foreign key(tenant_id,provider_account_id) references public.provider_accounts(tenant_id,id) on delete set null,
  foreign key(tenant_id,import_profile_id) references public.import_profiles(tenant_id,id) on delete set null
);

create table if not exists public.parsehub_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  parsehub_project_id uuid not null,
  import_profile_id uuid,
  import_run_id uuid,
  run_token_hash text not null,
  idempotency_key text not null,
  status text not null default 'received' check(status in ('received','downloading','downloaded','queued','processing','completed','failed','ignored')),
  run_started_at timestamptz,
  run_completed_at timestamptz,
  source_retrieved_at timestamptz,
  attempts integer not null default 0 check(attempts >= 0),
  next_attempt_at timestamptz,
  last_error_code text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(tenant_id,id),
  unique(tenant_id,idempotency_key),
  foreign key(tenant_id,parsehub_project_id) references public.parsehub_projects(tenant_id,id) on delete cascade,
  foreign key(tenant_id,import_profile_id) references public.import_profiles(tenant_id,id) on delete set null,
  foreign key(tenant_id,import_run_id) references public.import_runs(tenant_id,id) on delete set null
);

create table if not exists public.import_merge_conflicts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  import_run_id uuid not null,
  import_row_id bigint,
  customer_id uuid,
  contact_person_id uuid,
  field_name text,
  existing_value jsonb,
  incoming_value jsonb,
  reason text not null,
  status text not null default 'open' check(status in ('open','resolved_existing','resolved_incoming','ignored')),
  resolved_by uuid references auth.users(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  unique(tenant_id,id),
  foreign key(tenant_id,import_run_id) references public.import_runs(tenant_id,id) on delete cascade,
  foreign key(import_row_id) references public.import_rows(id) on delete cascade,
  foreign key(tenant_id,customer_id) references public.customers(tenant_id,id) on delete cascade,
  foreign key(tenant_id,contact_person_id) references public.contact_people(tenant_id,id) on delete cascade
);

create table if not exists public.import_run_list_targets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  import_run_id uuid not null,
  list_id uuid not null,
  assignment_strategy text not null default 'shared_queue' check(assignment_strategy in ('shared_queue','round_robin','weighted','manual')),
  settings jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique(tenant_id,id),
  unique(import_run_id,list_id),
  foreign key(tenant_id,import_run_id) references public.import_runs(tenant_id,id) on delete cascade,
  foreign key(tenant_id,list_id) references public.customer_lists(tenant_id,id) on delete cascade
);

create table if not exists public.import_change_sets (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  import_run_id uuid not null,
  import_row_id bigint,
  entity_type text not null check(entity_type in ('customer','contact_person','list_member')),
  entity_id text not null,
  operation text not null check(operation in ('created','updated')),
  before_data jsonb,
  after_data jsonb,
  rollback_status text not null default 'pending' check(rollback_status in ('pending','rolled_back','skipped','failed')),
  rollback_reason text,
  created_at timestamptz not null default now(),
  foreign key(tenant_id,import_run_id) references public.import_runs(tenant_id,id) on delete cascade,
  foreign key(import_row_id) references public.import_rows(id) on delete set null
);

alter table public.import_runs
  add column if not exists import_profile_id uuid,
  add column if not exists import_profile_version_id uuid,
  add column if not exists profile_version integer,
  add column if not exists profile_snapshot jsonb not null default '{}'::jsonb,
  add column if not exists source_provider text not null default 'file',
  add column if not exists source_website text,
  add column if not exists source_project text,
  add column if not exists source_run_id text,
  add column if not exists source_retrieved_at timestamptz,
  add column if not exists file_sha256 text,
  add column if not exists worksheet_name text,
  add column if not exists header_row integer not null default 1,
  add column if not exists records_path text,
  add column if not exists target_list_id uuid,
  add column if not exists idempotency_key text,
  add column if not exists commit_approved_by uuid references auth.users(id) on delete set null,
  add column if not exists commit_approved_at timestamptz,
  add column if not exists warning_count integer not null default 0,
  add column if not exists unchanged_count integer not null default 0,
  add column if not exists conflict_count integer not null default 0,
  add column if not exists new_contact_count integer not null default 0,
  add column if not exists updated_contact_count integer not null default 0,
  add constraint import_runs_profile_fk foreign key(tenant_id,import_profile_id) references public.import_profiles(tenant_id,id) on delete set null,
  add constraint import_runs_profile_version_fk foreign key(tenant_id,import_profile_version_id) references public.import_profile_versions(tenant_id,id) on delete set null,
  add constraint import_runs_target_list_fk foreign key(tenant_id,target_list_id) references public.customer_lists(tenant_id,id) on delete set null;

alter table public.import_rows
  add column if not exists row_status text not null default 'pending',
  add column if not exists warning_codes jsonb not null default '[]'::jsonb,
  add column if not exists error_code text,
  add column if not exists matched_contact_person_id uuid,
  add column if not exists processing_batch integer,
  add column if not exists processing_ms integer,
  add column if not exists source_external_id text,
  add constraint import_rows_contact_fk foreign key(tenant_id,matched_contact_person_id) references public.contact_people(tenant_id,id) on delete set null;

alter table public.contact_people
  add column if not exists first_name text,
  add column if not exists last_name text,
  add column if not exists role text,
  add column if not exists alternate_phone_e164 text,
  add column if not exists ownership_percentage numeric,
  add column if not exists is_signatory boolean not null default false,
  add column if not exists source_external_id text,
  add column if not exists source_import_run_id uuid,
  add column if not exists source_retrieved_at timestamptz,
  add column if not exists source_url text,
  add column if not exists raw_source_data jsonb not null default '{}'::jsonb,
  add constraint contact_people_source_import_fk foreign key(tenant_id,source_import_run_id) references public.import_runs(tenant_id,id) on delete set null;

alter table public.customers
  add column if not exists company_status text,
  add column if not exists founded_year integer,
  add column if not exists source_provider text,
  add column if not exists source_website text,
  add column if not exists source_url text,
  add column if not exists source_import_run_id uuid,
  add constraint customers_source_import_fk foreign key(tenant_id,source_import_run_id) references public.import_runs(tenant_id,id) on delete set null;

alter table public.customer_list_members
  add column if not exists source_import_run_id uuid,
  add column if not exists source_import_profile_id uuid,
  add column if not exists source_reason text,
  add column if not exists compliance_status text not null default 'pending_compliance',
  add column if not exists compliance_reason text,
  add constraint customer_list_members_source_import_fk foreign key(tenant_id,source_import_run_id) references public.import_runs(tenant_id,id) on delete set null,
  add constraint customer_list_members_source_profile_fk foreign key(tenant_id,source_import_profile_id) references public.import_profiles(tenant_id,id) on delete set null;

create unique index if not exists import_runs_idempotency_idx on public.import_runs(tenant_id,idempotency_key) where idempotency_key is not null;
create index if not exists import_profiles_tenant_active_idx on public.import_profiles(tenant_id,active,updated_at desc);
create index if not exists import_profile_versions_profile_idx on public.import_profile_versions(tenant_id,import_profile_id,version desc);
create index if not exists import_rows_run_status_idx on public.import_rows(tenant_id,import_run_id,row_status,row_number);
create index if not exists import_conflicts_open_idx on public.import_merge_conflicts(tenant_id,import_run_id,status) where status='open';
create index if not exists import_changes_run_idx on public.import_change_sets(tenant_id,import_run_id,id desc);
create index if not exists contacts_match_email_idx on public.contact_people(tenant_id,customer_id,email) where email is not null;
create index if not exists contacts_match_phone_idx on public.contact_people(tenant_id,customer_id,phone_e164) where phone_e164 is not null;
create unique index if not exists contacts_external_identity_idx on public.contact_people(tenant_id,customer_id,source_external_id) where source_external_id is not null;

alter table public.import_profiles enable row level security;
alter table public.import_profile_versions enable row level security;
alter table public.import_field_mappings enable row level security;
alter table public.parsehub_projects enable row level security;
alter table public.parsehub_runs enable row level security;
alter table public.import_merge_conflicts enable row level security;
alter table public.import_run_list_targets enable row level security;
alter table public.import_change_sets enable row level security;

do $$
declare t text;
begin
  foreach t in array array['import_profiles','import_profile_versions','import_field_mappings','parsehub_projects','parsehub_runs','import_merge_conflicts','import_run_list_targets','import_change_sets'] loop
    execute format('drop policy if exists %I_import_ops on public.%I',t,t);
    execute format('create policy %I_import_ops on public.%I for all to authenticated using (tenant_id=public.current_tenant_id() and public.has_current_role(array[''owner'',''admin'',''team_lead'',''backoffice''])) with check (tenant_id=public.current_tenant_id() and public.has_current_role(array[''owner'',''admin'',''team_lead'',''backoffice'']))',t,t);
    execute format('drop trigger if exists %I_tenant_immutable on public.%I',t,t);
    execute format('create trigger %I_tenant_immutable before update of tenant_id on public.%I for each row execute function public.prevent_tenant_move()',t,t);
  end loop;
end $$;

create trigger import_profiles_touch before update on public.import_profiles for each row execute function public.touch_updated_at();
create trigger parsehub_projects_touch before update on public.parsehub_projects for each row execute function public.touch_updated_at();
create trigger parsehub_runs_touch before update on public.parsehub_runs for each row execute function public.touch_updated_at();

create or replace function public.save_import_profile(
  p_profile_id uuid,
  p_name text,
  p_source_provider text,
  p_source_website text,
  p_format text,
  p_worksheet_name text,
  p_header_row integer,
  p_records_path text,
  p_target_type text,
  p_target_list_id uuid,
  p_automatic_commit boolean,
  p_config jsonb,
  p_field_mapping jsonb
) returns uuid
language plpgsql security definer set search_path=public as $$
declare
  v_tenant uuid:=public.current_tenant_id();
  v_user uuid:=auth.uid();
  v_profile uuid:=p_profile_id;
  v_version integer;
  v_version_id uuid;
  v_scope text;
  v_target text;
  v_rule jsonb;
begin
  if v_tenant is null or v_user is null then raise exception 'authentication_required'; end if;
  if not public.has_current_role(array['owner','admin','team_lead','backoffice']) then raise exception 'permission_denied'; end if;
  if nullif(trim(p_name),'') is null then raise exception 'profile_name_required'; end if;
  if p_format not in ('auto','csv','json','ndjson','xlsx') then raise exception 'profile_format_invalid'; end if;
  if p_target_type not in ('crm','list','review') then raise exception 'profile_target_type_invalid'; end if;
  if p_target_list_id is not null and not public.can_manage_customer_list(p_target_list_id) then raise exception 'target_list_permission_denied'; end if;

  if v_profile is null then
    insert into public.import_profiles(tenant_id,name,source_provider,source_website,format,worksheet_name,header_row,records_path,target_type,target_list_id,automatic_commit,current_version,created_by,updated_by)
    values(v_tenant,trim(p_name),coalesce(nullif(trim(p_source_provider),''),'file'),nullif(trim(p_source_website),''),p_format,nullif(trim(p_worksheet_name),''),coalesce(p_header_row,1),nullif(trim(p_records_path),''),p_target_type,p_target_list_id,coalesce(p_automatic_commit,false),0,v_user,v_user)
    returning id into v_profile;
  else
    update public.import_profiles set name=trim(p_name),source_provider=coalesce(nullif(trim(p_source_provider),''),'file'),source_website=nullif(trim(p_source_website),''),format=p_format,
      worksheet_name=nullif(trim(p_worksheet_name),''),header_row=coalesce(p_header_row,1),records_path=nullif(trim(p_records_path),''),target_type=p_target_type,target_list_id=p_target_list_id,
      automatic_commit=coalesce(p_automatic_commit,false),updated_by=v_user,active=true
    where tenant_id=v_tenant and id=v_profile;
    if not found then raise exception 'import_profile_not_found'; end if;
  end if;

  select current_version+1 into v_version from public.import_profiles where tenant_id=v_tenant and id=v_profile for update;
  insert into public.import_profile_versions(tenant_id,import_profile_id,version,config,field_mapping,mapping_checksum,created_by)
  values(v_tenant,v_profile,v_version,coalesce(p_config,'{}'::jsonb),coalesce(p_field_mapping,'{}'::jsonb),encode(digest(coalesce(p_field_mapping,'{}'::jsonb)::text,'sha256'),'hex'),v_user)
  returning id into v_version_id;
  update public.import_profiles set current_version=v_version,updated_by=v_user,updated_at=now() where id=v_profile;

  for v_scope,v_target,v_rule in
    select 'company',key,value from jsonb_each(coalesce(p_field_mapping->'company','{}'::jsonb))
    union all
    select 'contact',key,value from jsonb_each(coalesce(p_field_mapping->'contacts'->'fields','{}'::jsonb))
  loop
    insert into public.import_field_mappings(tenant_id,import_profile_version_id,target_scope,target_field,source_path,transform_chain,default_value,required)
    values(v_tenant,v_version_id,v_scope,v_target,
      case when jsonb_typeof(v_rule->'source')='string' then v_rule->>'source' else null end,
      coalesce(v_rule->'transforms','[]'::jsonb),v_rule->'default',coalesce((v_rule->>'required')::boolean,false));
  end loop;

  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
  values(v_tenant,v_user,'import_profile.saved','import_profile',v_profile::text,jsonb_build_object('version',v_version,'source_provider',p_source_provider));
  return v_profile;
end $$;

create or replace function public.process_import_run(p_import_run_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_tenant uuid;
  v_status public.import_status;
  v_name text;
  v_source_type text;
  v_source_provider text;
  v_source_website text;
  v_profile uuid;
  v_target_list uuid;
  v_scan text;
  v_actor uuid:=auth.uid();
  v_row record;
  v_data jsonb;
  v_contacts jsonb;
  v_contact jsonb;
  v_customer_id uuid;
  v_contact_id uuid;
  v_match_count integer;
  v_before jsonb;
  v_after jsonb;
  v_policy jsonb;
  v_candidate_status text;
  v_compliance_status text;
  v_new integer:=0;
  v_updated integer:=0;
  v_unchanged integer:=0;
  v_conflicts integer:=0;
  v_blocked integer:=0;
  v_errors integer:=0;
  v_warnings integer:=0;
  v_new_contacts integer:=0;
  v_updated_contacts integer:=0;
  v_list_added integer:=0;
  v_catalog integer:=0;
  v_first_contact uuid;
  v_started timestamptz;
  v_row_decision text;
begin
  select tenant_id,status,name,source_type,source_provider,source_website,import_profile_id,target_list_id,scan_status
  into v_tenant,v_status,v_name,v_source_type,v_source_provider,v_source_website,v_profile,v_target_list,v_scan
  from public.import_runs where id=p_import_run_id and tenant_id=public.current_tenant_id() for update;
  if v_tenant is null then raise exception 'import_run_not_found'; end if;
  if not public.has_current_role(array['owner','admin','team_lead','backoffice']) then raise exception 'permission_denied'; end if;
  if v_status not in ('preview_ready','validated','queued') then raise exception 'import_run_not_ready'; end if;
  if v_scan not in ('clean','waived') then raise exception 'import_file_not_security_cleared'; end if;
  if v_target_list is not null and not public.can_manage_customer_list(v_target_list) then raise exception 'target_list_permission_denied'; end if;

  update public.import_runs set status='processing',simulation=false,commit_approved_by=v_actor,commit_approved_at=now(),started_at=coalesce(started_at,now()),catalog_sync_status='processing' where id=p_import_run_id;

  for v_row in select * from public.import_rows where tenant_id=v_tenant and import_run_id=p_import_run_id order by row_number for update loop
    v_started:=clock_timestamp();
    if v_row.decision not in ('ready','warning') then
      if v_row.decision='error' then v_errors:=v_errors+1; end if;
      continue;
    end if;
    v_data:=coalesce(v_row.normalized_data,'{}'::jsonb);
    v_contacts:=coalesce(v_data->'contacts','[]'::jsonb);
    v_customer_id:=null;
    v_first_contact:=null;
    v_before:=null;
    v_after:=null;
    v_row_decision:=null;

    select count(*),(array_agg(c.id order by c.updated_at desc))[1] into v_match_count,v_customer_id
    from public.customers c
    where c.tenant_id=v_tenant and c.deleted_at is null and (
      (nullif(v_data->>'organization_number','') is not null and c.organization_number=v_data->>'organization_number')
      or (nullif(v_data->>'organization_number','') is null and nullif(v_data->>'source_external_id','') is not null and c.source_provider=coalesce(v_source_provider,v_source_type) and c.source_external_id=v_data->>'source_external_id')
      or (nullif(v_data->>'organization_number','') is null and nullif(v_data->>'phone_e164','') is not null and c.phone_e164=v_data->>'phone_e164')
      or (nullif(v_data->>'organization_number','') is null and nullif(v_data->>'email','') is not null and c.email::text=lower(v_data->>'email'))
    );

    if v_match_count>1 then
      insert into public.import_merge_conflicts(tenant_id,import_run_id,import_row_id,reason,incoming_value)
      values(v_tenant,p_import_run_id,v_row.id,'multiple_customer_matches',v_data);
      update public.import_rows set decision='conflict',row_status='conflict',error_code='multiple_customer_matches',processing_ms=(extract(epoch from clock_timestamp()-v_started)*1000)::integer where id=v_row.id;
      v_conflicts:=v_conflicts+1;
      continue;
    end if;

    if v_customer_id is null then
      insert into public.customers(
        tenant_id,customer_type,lifecycle,display_name,company_name,organization_number,legal_form,company_status,
        phone_e164,alternate_phone_e164,email,website,address_line1,address_line2,postal_code,city,municipality,county,country_code,
        industry,sni_code,employee_count,revenue,result,founded_year,source_name,source_provider,source_website,source_external_id,source_url,
        source_retrieved_at,source_import_run_id,created_by
      ) values (
        v_tenant,'company','prospect',coalesce(nullif(v_data->>'display_name',''),nullif(v_data->>'company_name','')),nullif(v_data->>'company_name',''),nullif(v_data->>'organization_number',''),
        nullif(v_data->>'legal_form',''),nullif(v_data->>'company_status',''),nullif(v_data->>'phone_e164',''),nullif(v_data->>'alternate_phone_e164',''),nullif(v_data->>'email','')::citext,
        nullif(v_data->>'website',''),nullif(v_data->>'address_line1',''),nullif(v_data->>'address_line2',''),nullif(v_data->>'postal_code',''),nullif(v_data->>'city',''),
        nullif(v_data->>'municipality',''),nullif(v_data->>'county',''),coalesce(nullif(v_data->>'country_code',''),'SE'),nullif(v_data->>'industry',''),nullif(v_data->>'sni_code',''),
        nullif(v_data->>'employee_count','')::integer,nullif(v_data->>'revenue','')::numeric,nullif(v_data->>'result','')::numeric,nullif(v_data->>'founded_year','')::integer,
        coalesce(v_source_provider,v_source_type)||':'||v_name,coalesce(v_source_provider,v_source_type),v_source_website,nullif(v_data->>'source_external_id',''),nullif(v_data->>'source_url',''),
        coalesce((select source_retrieved_at from public.import_runs where id=p_import_run_id),now()),p_import_run_id,v_actor
      ) returning id,to_jsonb(customers.*) into v_customer_id,v_after;
      insert into public.import_change_sets(tenant_id,import_run_id,import_row_id,entity_type,entity_id,operation,after_data)
      values(v_tenant,p_import_run_id,v_row.id,'customer',v_customer_id::text,'created',v_after);
      v_new:=v_new+1;
      v_row_decision:='created';
    else
      select to_jsonb(c.*) into v_before from public.customers c where c.tenant_id=v_tenant and c.id=v_customer_id for update;
      update public.customers c set
        display_name=case when 'display_name'=any(c.manually_verified_fields) then c.display_name else coalesce(nullif(v_data->>'display_name',''),c.display_name) end,
        company_name=case when 'company_name'=any(c.manually_verified_fields) then c.company_name else coalesce(nullif(v_data->>'company_name',''),c.company_name) end,
        organization_number=case when 'organization_number'=any(c.manually_verified_fields) then c.organization_number else coalesce(nullif(v_data->>'organization_number',''),c.organization_number) end,
        legal_form=case when 'legal_form'=any(c.manually_verified_fields) then c.legal_form else coalesce(nullif(v_data->>'legal_form',''),c.legal_form) end,
        company_status=case when 'company_status'=any(c.manually_verified_fields) then c.company_status else coalesce(nullif(v_data->>'company_status',''),c.company_status) end,
        phone_e164=case when 'phone_e164'=any(c.manually_verified_fields) then c.phone_e164 else coalesce(nullif(v_data->>'phone_e164',''),c.phone_e164) end,
        alternate_phone_e164=case when 'alternate_phone_e164'=any(c.manually_verified_fields) then c.alternate_phone_e164 else coalesce(nullif(v_data->>'alternate_phone_e164',''),c.alternate_phone_e164) end,
        email=case when 'email'=any(c.manually_verified_fields) then c.email else coalesce(nullif(v_data->>'email','')::citext,c.email) end,
        website=case when 'website'=any(c.manually_verified_fields) then c.website else coalesce(nullif(v_data->>'website',''),c.website) end,
        address_line1=case when 'address_line1'=any(c.manually_verified_fields) then c.address_line1 else coalesce(nullif(v_data->>'address_line1',''),c.address_line1) end,
        address_line2=case when 'address_line2'=any(c.manually_verified_fields) then c.address_line2 else coalesce(nullif(v_data->>'address_line2',''),c.address_line2) end,
        postal_code=case when 'postal_code'=any(c.manually_verified_fields) then c.postal_code else coalesce(nullif(v_data->>'postal_code',''),c.postal_code) end,
        city=case when 'city'=any(c.manually_verified_fields) then c.city else coalesce(nullif(v_data->>'city',''),c.city) end,
        municipality=case when 'municipality'=any(c.manually_verified_fields) then c.municipality else coalesce(nullif(v_data->>'municipality',''),c.municipality) end,
        county=case when 'county'=any(c.manually_verified_fields) then c.county else coalesce(nullif(v_data->>'county',''),c.county) end,
        country_code=case when 'country_code'=any(c.manually_verified_fields) then c.country_code else coalesce(nullif(v_data->>'country_code',''),c.country_code) end,
        industry=case when 'industry'=any(c.manually_verified_fields) then c.industry else coalesce(nullif(v_data->>'industry',''),c.industry) end,
        sni_code=case when 'sni_code'=any(c.manually_verified_fields) then c.sni_code else coalesce(nullif(v_data->>'sni_code',''),c.sni_code) end,
        employee_count=case when 'employee_count'=any(c.manually_verified_fields) then c.employee_count else coalesce(nullif(v_data->>'employee_count','')::integer,c.employee_count) end,
        revenue=case when 'revenue'=any(c.manually_verified_fields) then c.revenue else coalesce(nullif(v_data->>'revenue','')::numeric,c.revenue) end,
        result=case when 'result'=any(c.manually_verified_fields) then c.result else coalesce(nullif(v_data->>'result','')::numeric,c.result) end,
        founded_year=case when 'founded_year'=any(c.manually_verified_fields) then c.founded_year else coalesce(nullif(v_data->>'founded_year','')::integer,c.founded_year) end,
        source_name=coalesce(v_source_provider,v_source_type)||':'||v_name,source_provider=coalesce(v_source_provider,v_source_type),source_website=coalesce(v_source_website,c.source_website),
        source_external_id=coalesce(nullif(v_data->>'source_external_id',''),c.source_external_id),source_url=coalesce(nullif(v_data->>'source_url',''),c.source_url),
        source_retrieved_at=coalesce((select source_retrieved_at from public.import_runs where id=p_import_run_id),now()),source_import_run_id=p_import_run_id,updated_at=now()
      where c.tenant_id=v_tenant and c.id=v_customer_id returning to_jsonb(c.*) into v_after;
      if (v_before-'updated_at'-'source_retrieved_at'-'source_import_run_id') is distinct from (v_after-'updated_at'-'source_retrieved_at'-'source_import_run_id') then
        insert into public.import_change_sets(tenant_id,import_run_id,import_row_id,entity_type,entity_id,operation,before_data,after_data)
        values(v_tenant,p_import_run_id,v_row.id,'customer',v_customer_id::text,'updated',v_before,v_after);
        v_updated:=v_updated+1;
        v_row_decision:='updated';
      else
        v_unchanged:=v_unchanged+1;
        v_row_decision:='unchanged';
      end if;
    end if;

    if jsonb_typeof(v_contacts)='array' then
      for v_contact in select value from jsonb_array_elements(v_contacts) loop
        v_contact_id:=null;
        select cp.id into v_contact_id from public.contact_people cp
        where cp.tenant_id=v_tenant and cp.customer_id=v_customer_id and (
          (nullif(v_contact->>'source_external_id','') is not null and cp.source_external_id=v_contact->>'source_external_id')
          or (nullif(v_contact->>'email','') is not null and cp.email::text=lower(v_contact->>'email'))
          or (nullif(v_contact->>'phone_e164','') is not null and cp.phone_e164=v_contact->>'phone_e164')
          or (nullif(v_contact->>'full_name','') is not null and lower(cp.full_name)=lower(v_contact->>'full_name') and coalesce(lower(cp.role),'')=coalesce(lower(v_contact->>'role'),''))
        ) order by cp.updated_at desc limit 1 for update;
        if v_contact_id is null then
          insert into public.contact_people(tenant_id,customer_id,full_name,first_name,last_name,title,role,email,phone_e164,alternate_phone_e164,is_primary,ownership_percentage,is_signatory,source_external_id,source_import_run_id,source_retrieved_at,source_url,raw_source_data)
          values(v_tenant,v_customer_id,coalesce(nullif(v_contact->>'full_name',''),concat_ws(' ',nullif(v_contact->>'first_name',''),nullif(v_contact->>'last_name',''))),nullif(v_contact->>'first_name',''),nullif(v_contact->>'last_name',''),
            nullif(v_contact->>'title',''),nullif(v_contact->>'role',''),nullif(v_contact->>'email','')::citext,nullif(v_contact->>'phone_e164',''),nullif(v_contact->>'alternate_phone_e164',''),coalesce((v_contact->>'is_primary')::boolean,false),
            nullif(v_contact->>'ownership_percentage','')::numeric,coalesce((v_contact->>'is_signatory')::boolean,false),nullif(v_contact->>'source_external_id',''),p_import_run_id,coalesce((select source_retrieved_at from public.import_runs where id=p_import_run_id),now()),
            nullif(v_contact->>'source_url',''),v_contact) returning id,to_jsonb(contact_people.*) into v_contact_id,v_after;
          insert into public.import_change_sets(tenant_id,import_run_id,import_row_id,entity_type,entity_id,operation,after_data)
          values(v_tenant,p_import_run_id,v_row.id,'contact_person',v_contact_id::text,'created',v_after);
          v_new_contacts:=v_new_contacts+1;
        else
          select to_jsonb(cp.*) into v_before from public.contact_people cp where cp.tenant_id=v_tenant and cp.id=v_contact_id;
          update public.contact_people cp set
            full_name=coalesce(nullif(v_contact->>'full_name',''),cp.full_name),first_name=coalesce(nullif(v_contact->>'first_name',''),cp.first_name),last_name=coalesce(nullif(v_contact->>'last_name',''),cp.last_name),
            title=coalesce(nullif(v_contact->>'title',''),cp.title),role=coalesce(nullif(v_contact->>'role',''),cp.role),email=coalesce(nullif(v_contact->>'email','')::citext,cp.email),
            phone_e164=coalesce(nullif(v_contact->>'phone_e164',''),cp.phone_e164),alternate_phone_e164=coalesce(nullif(v_contact->>'alternate_phone_e164',''),cp.alternate_phone_e164),
            is_primary=coalesce((v_contact->>'is_primary')::boolean,cp.is_primary),ownership_percentage=coalesce(nullif(v_contact->>'ownership_percentage','')::numeric,cp.ownership_percentage),
            is_signatory=coalesce((v_contact->>'is_signatory')::boolean,cp.is_signatory),source_external_id=coalesce(nullif(v_contact->>'source_external_id',''),cp.source_external_id),
            source_import_run_id=p_import_run_id,source_retrieved_at=coalesce((select source_retrieved_at from public.import_runs where id=p_import_run_id),now()),source_url=coalesce(nullif(v_contact->>'source_url',''),cp.source_url),
            raw_source_data=cp.raw_source_data||v_contact,updated_at=now()
          where cp.tenant_id=v_tenant and cp.id=v_contact_id returning to_jsonb(cp.*) into v_after;
          if (v_before-'updated_at'-'source_retrieved_at'-'source_import_run_id') is distinct from (v_after-'updated_at'-'source_retrieved_at'-'source_import_run_id') then
            insert into public.import_change_sets(tenant_id,import_run_id,import_row_id,entity_type,entity_id,operation,before_data,after_data)
            values(v_tenant,p_import_run_id,v_row.id,'contact_person',v_contact_id::text,'updated',v_before,v_after);
            v_updated_contacts:=v_updated_contacts+1;
          end if;
        end if;
        v_first_contact:=coalesce(v_first_contact,v_contact_id);
      end loop;
    end if;

    perform public.sync_tenant_import_to_directory(v_tenant,p_import_run_id,v_row.id,v_customer_id,v_data);
    v_catalog:=v_catalog+1;
    v_policy:=public.evaluate_contact_policy_for_tenant(v_tenant,v_customer_id,'call','direct_marketing');
    if v_policy->>'allowed'='true' or v_policy->>'reason'='outside_contact_hours' then
      v_candidate_status:='approved'; v_compliance_status:='eligible';
    elsif v_policy->>'reason'='nix_check_required' then
      v_candidate_status:='pending_nix'; v_compliance_status:='pending_nix';
    elsif v_policy->>'reason' in ('feature_disabled','legal_basis_required') then
      v_candidate_status:='pending'; v_compliance_status:='manual_review';
    else
      v_candidate_status:='blocked'; v_compliance_status:='blocked'; v_blocked:=v_blocked+1;
    end if;

    if v_target_list is not null then
      insert into public.customer_list_contact_candidates(tenant_id,list_id,customer_id,status,policy_reason,evaluated_at)
      values(v_tenant,v_target_list,v_customer_id,v_candidate_status,v_policy->>'reason',now())
      on conflict(list_id,customer_id) do update set status=excluded.status,policy_reason=excluded.policy_reason,evaluated_at=excluded.evaluated_at,updated_at=now();
      insert into public.customer_list_members(tenant_id,list_id,customer_id,added_by,state,source_import_run_id,source_import_profile_id,source_reason,compliance_status,compliance_reason)
      values(v_tenant,v_target_list,v_customer_id,v_actor,case when v_candidate_status='approved' then 'pending' else 'blocked' end,p_import_run_id,v_profile,'import',v_compliance_status,v_policy->>'reason')
      on conflict(list_id,customer_id) do update set source_import_run_id=excluded.source_import_run_id,source_import_profile_id=coalesce(excluded.source_import_profile_id,public.customer_list_members.source_import_profile_id),
        compliance_status=excluded.compliance_status,compliance_reason=excluded.compliance_reason,
        state=case when public.customer_list_members.state in ('completed','dialing','after_call') then public.customer_list_members.state else excluded.state end,updated_at=now();
      if found then
        insert into public.import_change_sets(tenant_id,import_run_id,import_row_id,entity_type,entity_id,operation,after_data)
        values(v_tenant,p_import_run_id,v_row.id,'list_member',v_target_list::text||':'||v_customer_id::text,'created',jsonb_build_object('list_id',v_target_list,'customer_id',v_customer_id))
        on conflict do nothing;
        v_list_added:=v_list_added+1;
      end if;
    end if;

    update public.import_rows set decision=coalesce(v_row_decision,'unchanged'),
      row_status=case when jsonb_array_length(coalesce(warning_codes,'[]'::jsonb))>0 then 'warning' else 'valid' end,matched_customer_id=v_customer_id,matched_contact_person_id=v_first_contact,
      processing_ms=(extract(epoch from clock_timestamp()-v_started)*1000)::integer where id=v_row.id;
  end loop;

  select count(*) into v_warnings from public.import_rows where tenant_id=v_tenant and import_run_id=p_import_run_id and jsonb_array_length(coalesce(warning_codes,'[]'::jsonb))>0;
  update public.import_runs set status=(case when v_errors+v_conflicts+v_warnings>0 then 'completed_with_warnings' else 'completed' end)::public.import_status,
    new_count=v_new,updated_count=v_updated,unchanged_count=v_unchanged,duplicate_count=v_unchanged,blocked_count=v_blocked,error_count=v_errors,warning_count=v_warnings,conflict_count=v_conflicts,
    new_contact_count=v_new_contacts,updated_contact_count=v_updated_contacts,catalog_sync_status='completed',
    validation_report=validation_report||jsonb_build_object('processed_at',now(),'new_companies',v_new,'updated_companies',v_updated,'unchanged_companies',v_unchanged,'new_contacts',v_new_contacts,'updated_contacts',v_updated_contacts,'conflicts',v_conflicts,'blocked',v_blocked,'errors',v_errors,'warnings',v_warnings,'list_members',v_list_added,'catalog_synced',v_catalog),completed_at=now()
  where id=p_import_run_id;
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
  values(v_tenant,v_actor,'import.completed','import_run',p_import_run_id::text,jsonb_build_object('new',v_new,'updated',v_updated,'unchanged',v_unchanged,'contacts',v_new_contacts+v_updated_contacts,'conflicts',v_conflicts,'list_members',v_list_added,'catalog_synced',v_catalog));
  return jsonb_build_object('new',v_new,'updated',v_updated,'unchanged',v_unchanged,'newContacts',v_new_contacts,'updatedContacts',v_updated_contacts,'conflicts',v_conflicts,'blocked',v_blocked,'errors',v_errors,'warnings',v_warnings,'listMembers',v_list_added,'catalogSynced',v_catalog);
exception when others then
  if v_tenant is not null then
    update public.import_runs set status='failed',catalog_sync_status='failed',completed_at=now(),validation_report=validation_report||jsonb_build_object('execution_error',sqlerrm) where id=p_import_run_id;
  end if;
  raise;
end $$;

drop function if exists public.rollback_import_run(uuid);

create function public.rollback_import_run(p_import_run_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_tenant uuid:=public.current_tenant_id();
  v_actor uuid:=auth.uid();
  v_status public.import_status;
  v_change record;
  v_rolled integer:=0;
  v_skipped integer:=0;
  v_current jsonb;
  v_change_rolled boolean;
begin
  if not public.has_current_role(array['owner','admin']) then raise exception 'admin_required'; end if;
  select status into v_status from public.import_runs where tenant_id=v_tenant and id=p_import_run_id for update;
  if v_status not in ('completed','completed_with_warnings') then raise exception 'import_not_rollbackable'; end if;
  for v_change in select * from public.import_change_sets where tenant_id=v_tenant and import_run_id=p_import_run_id and rollback_status='pending' order by id desc for update loop
    begin
      v_change_rolled:=false;
      if v_change.entity_type='list_member' then
        delete from public.customer_list_members lm
        where lm.tenant_id=v_tenant and lm.source_import_run_id=p_import_run_id and lm.list_id=(v_change.after_data->>'list_id')::uuid and lm.customer_id=(v_change.after_data->>'customer_id')::uuid
          and not exists(select 1 from public.calls c where c.tenant_id=v_tenant and c.list_member_id=lm.id);
        if found then v_rolled:=v_rolled+1; v_change_rolled:=true; else v_skipped:=v_skipped+1; end if;
      elsif v_change.entity_type='contact_person' and v_change.operation='created' then
        delete from public.contact_people cp where cp.tenant_id=v_tenant and cp.id=v_change.entity_id::uuid and cp.source_import_run_id=p_import_run_id;
        if found then v_rolled:=v_rolled+1; v_change_rolled:=true; else v_skipped:=v_skipped+1; end if;
      elsif v_change.entity_type='contact_person' and v_change.operation='updated' then
        select to_jsonb(cp.*) into v_current from public.contact_people cp where cp.tenant_id=v_tenant and cp.id=v_change.entity_id::uuid for update;
        if (v_current-'updated_at') is distinct from (v_change.after_data-'updated_at') then
          v_skipped:=v_skipped+1;
        else
          update public.contact_people set full_name=v_change.before_data->>'full_name',first_name=v_change.before_data->>'first_name',last_name=v_change.before_data->>'last_name',title=v_change.before_data->>'title',role=v_change.before_data->>'role',
            email=nullif(v_change.before_data->>'email','')::citext,phone_e164=v_change.before_data->>'phone_e164',alternate_phone_e164=v_change.before_data->>'alternate_phone_e164',
            is_primary=coalesce((v_change.before_data->>'is_primary')::boolean,false),ownership_percentage=nullif(v_change.before_data->>'ownership_percentage','')::numeric,is_signatory=coalesce((v_change.before_data->>'is_signatory')::boolean,false),
            source_external_id=v_change.before_data->>'source_external_id',source_import_run_id=nullif(v_change.before_data->>'source_import_run_id','')::uuid,source_retrieved_at=nullif(v_change.before_data->>'source_retrieved_at','')::timestamptz,
            source_url=v_change.before_data->>'source_url',raw_source_data=coalesce(v_change.before_data->'raw_source_data','{}'::jsonb),updated_at=now()
          where tenant_id=v_tenant and id=v_change.entity_id::uuid;
          v_rolled:=v_rolled+1;
          v_change_rolled:=true;
        end if;
      elsif v_change.entity_type='customer' and v_change.operation='created' then
        update public.customers c set deleted_at=now(),updated_at=now()
        where c.tenant_id=v_tenant and c.id=v_change.entity_id::uuid and c.source_import_run_id=p_import_run_id
          and not exists(select 1 from public.calls x where x.tenant_id=v_tenant and x.customer_id=c.id)
          and not exists(select 1 from public.contracts x where x.tenant_id=v_tenant and x.customer_id=c.id)
          and not exists(select 1 from public.sales_orders x where x.tenant_id=v_tenant and x.customer_id=c.id);
        if found then v_rolled:=v_rolled+1; v_change_rolled:=true; else v_skipped:=v_skipped+1; end if;
      elsif v_change.entity_type='customer' and v_change.operation='updated' then
        select to_jsonb(c.*) into v_current from public.customers c where c.tenant_id=v_tenant and c.id=v_change.entity_id::uuid for update;
        if (v_current-'updated_at') is distinct from (v_change.after_data-'updated_at') then
          v_skipped:=v_skipped+1;
        else
          update public.customers set display_name=v_change.before_data->>'display_name',company_name=v_change.before_data->>'company_name',organization_number=v_change.before_data->>'organization_number',legal_form=v_change.before_data->>'legal_form',
            company_status=v_change.before_data->>'company_status',phone_e164=v_change.before_data->>'phone_e164',alternate_phone_e164=v_change.before_data->>'alternate_phone_e164',email=nullif(v_change.before_data->>'email','')::citext,
            website=v_change.before_data->>'website',address_line1=v_change.before_data->>'address_line1',address_line2=v_change.before_data->>'address_line2',postal_code=v_change.before_data->>'postal_code',city=v_change.before_data->>'city',
            municipality=v_change.before_data->>'municipality',county=v_change.before_data->>'county',country_code=coalesce(v_change.before_data->>'country_code','SE'),industry=v_change.before_data->>'industry',sni_code=v_change.before_data->>'sni_code',
            employee_count=nullif(v_change.before_data->>'employee_count','')::integer,revenue=nullif(v_change.before_data->>'revenue','')::numeric,result=nullif(v_change.before_data->>'result','')::numeric,founded_year=nullif(v_change.before_data->>'founded_year','')::integer,
            source_name=v_change.before_data->>'source_name',source_provider=v_change.before_data->>'source_provider',source_website=v_change.before_data->>'source_website',source_external_id=v_change.before_data->>'source_external_id',
            source_url=v_change.before_data->>'source_url',source_retrieved_at=nullif(v_change.before_data->>'source_retrieved_at','')::timestamptz,source_import_run_id=nullif(v_change.before_data->>'source_import_run_id','')::uuid,updated_at=now()
          where tenant_id=v_tenant and id=v_change.entity_id::uuid;
          v_rolled:=v_rolled+1;
          v_change_rolled:=true;
        end if;
      end if;
      update public.import_change_sets set rollback_status=case when v_change_rolled then 'rolled_back' else 'skipped' end,rollback_reason=case when v_change_rolled then null else 'entity_changed_or_in_use' end where id=v_change.id;
    exception when others then
      update public.import_change_sets set rollback_status='failed',rollback_reason=sqlerrm where id=v_change.id;
      v_skipped:=v_skipped+1;
    end;
  end loop;
  update public.import_runs set status='rolled_back',updated_at=now(),validation_report=validation_report||jsonb_build_object('rollback_at',now(),'rollback_count',v_rolled,'rollback_skipped',v_skipped) where id=p_import_run_id;
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
  values(v_tenant,v_actor,'import.rolled_back','import_run',p_import_run_id::text,jsonb_build_object('rolled_back',v_rolled,'skipped',v_skipped));
  return jsonb_build_object('rolledBack',v_rolled,'skipped',v_skipped);
end $$;

revoke all on function public.save_import_profile(uuid,text,text,text,text,text,integer,text,text,uuid,boolean,jsonb,jsonb) from public,anon;
revoke all on function public.process_import_run(uuid) from public,anon;
revoke all on function public.rollback_import_run(uuid) from public,anon;
grant execute on function public.save_import_profile(uuid,text,text,text,text,text,integer,text,text,uuid,boolean,jsonb,jsonb) to authenticated,service_role;
grant execute on function public.process_import_run(uuid),public.rollback_import_run(uuid) to authenticated,service_role;

commit;
