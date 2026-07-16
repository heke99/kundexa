begin;

create table public.geographic_areas (
  id uuid primary key default gen_random_uuid(),
  country_code text not null default 'SE',
  area_type text not null check (area_type in ('country','county','municipality','postal_code','locality')),
  code text not null,
  name text not null,
  parent_id uuid references public.geographic_areas(id) on delete set null,
  parent_code text,
  postal_code text,
  aliases text[] not null default '{}',
  latitude numeric,
  longitude numeric,
  source text not null,
  source_version text,
  valid_from date,
  valid_until date,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(country_code,area_type,code)
);
create index geographic_areas_lookup_idx on public.geographic_areas(country_code,area_type,code);
create index geographic_areas_postal_idx on public.geographic_areas(country_code,postal_code) where postal_code is not null;
create index geographic_areas_name_trgm_idx on public.geographic_areas using gin(name gin_trgm_ops);

create table public.geographic_normalization_results (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  master_entity_id uuid not null references public.master_entities(id) on delete cascade,
  input_hash text not null,
  input_values jsonb not null,
  normalized_values jsonb not null default '{}'::jsonb,
  postal_area_id uuid references public.geographic_areas(id) on delete set null,
  municipality_area_id uuid references public.geographic_areas(id) on delete set null,
  county_area_id uuid references public.geographic_areas(id) on delete set null,
  match_method text not null,
  confidence numeric not null check(confidence between 0 and 1),
  normalized_at timestamptz not null default now(),
  unique(tenant_id,master_entity_id),
  unique(tenant_id,id)
);

create table public.legal_holds (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete cascade,
  master_entity_id uuid references public.master_entities(id) on delete cascade,
  reason text not null,
  scope text[] not null default '{all}',
  active boolean not null default true,
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  released_by uuid references auth.users(id) on delete set null,
  released_at timestamptz,
  created_at timestamptz not null default now(),
  unique(tenant_id,id),
  check(customer_id is not null or master_entity_id is not null)
);

alter table public.data_subject_requests
  add column if not exists customer_id uuid,
  add column if not exists identity_verified_at timestamptz,
  add column if not exists rejection_reason text,
  add column if not exists result_hash text,
  add column if not exists processing_notes text;
alter table public.data_subject_requests drop constraint if exists data_subject_requests_customer_tenant_fk;
alter table public.data_subject_requests add constraint data_subject_requests_customer_tenant_fk
  foreign key(tenant_id,customer_id) references public.customers(tenant_id,id) on delete set null;

create table public.data_subject_request_events (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  request_id uuid not null,
  event_type text not null,
  details jsonb not null default '{}'::jsonb,
  actor_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key(tenant_id,request_id) references public.data_subject_requests(tenant_id,id) on delete cascade
);

alter table public.geographic_areas enable row level security;
alter table public.geographic_normalization_results enable row level security;
alter table public.legal_holds enable row level security;
alter table public.data_subject_request_events enable row level security;
create policy geographic_areas_authenticated_read on public.geographic_areas for select to authenticated using(true);
create policy geographic_normalization_member_read on public.geographic_normalization_results for select to authenticated using(tenant_id=public.current_tenant_id() and public.is_tenant_member(tenant_id));
create policy geographic_normalization_admin_write on public.geographic_normalization_results for all to authenticated using(tenant_id=public.current_tenant_id() and public.is_tenant_admin(tenant_id)) with check(tenant_id=public.current_tenant_id() and public.is_tenant_admin(tenant_id));
create policy legal_holds_admin on public.legal_holds for all to authenticated using(tenant_id=public.current_tenant_id() and public.is_tenant_admin(tenant_id)) with check(tenant_id=public.current_tenant_id() and public.is_tenant_admin(tenant_id));
create policy data_subject_request_events_admin on public.data_subject_request_events for all to authenticated using(tenant_id=public.current_tenant_id() and public.is_tenant_admin(tenant_id)) with check(tenant_id=public.current_tenant_id() and public.is_tenant_admin(tenant_id));

create trigger geographic_areas_touch before update on public.geographic_areas for each row execute function public.touch_updated_at();

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('compliance-exports','compliance-exports',false,52428800,array['application/json','application/zip'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
create policy compliance_exports_admin_read on storage.objects for select to authenticated using(
  bucket_id='compliance-exports' and (storage.foldername(name))[1]=public.current_tenant_id()::text and public.is_tenant_admin(public.current_tenant_id())
);
create policy compliance_exports_admin_write on storage.objects for insert to authenticated with check(
  bucket_id='compliance-exports' and (storage.foldername(name))[1]=public.current_tenant_id()::text and public.is_tenant_admin(public.current_tenant_id())
);
create policy compliance_exports_admin_delete on storage.objects for delete to authenticated using(
  bucket_id='compliance-exports' and (storage.foldername(name))[1]=public.current_tenant_id()::text and public.is_tenant_admin(public.current_tenant_id())
);

create or replace function public.normalize_geo_token(p_value text)
returns text language sql immutable as $$
  select regexp_replace(lower(trim(coalesce(p_value,''))),'[^a-z0-9åäö]+','','g')
$$;

create or replace function public.upsert_geographic_reference_batch(p_rows jsonb,p_source text,p_source_version text default null)
returns integer language plpgsql security definer set search_path=public as $$
declare r jsonb; n integer:=0;
begin
  if jsonb_typeof(p_rows)<>'array' then raise exception 'geographic_rows_must_be_array'; end if;
  for r in select value from jsonb_array_elements(p_rows) loop
    if coalesce(r->>'country_code','')='' or coalesce(r->>'area_type','')='' or coalesce(r->>'code','')='' or coalesce(r->>'name','')='' then
      raise exception 'geographic_row_missing_required_fields';
    end if;
    insert into public.geographic_areas(country_code,area_type,code,name,parent_code,postal_code,aliases,latitude,longitude,source,source_version,valid_from,valid_until,metadata)
    values(upper(r->>'country_code'),r->>'area_type',r->>'code',r->>'name',nullif(r->>'parent_code',''),nullif(regexp_replace(coalesce(r->>'postal_code',''),'\s','','g'),''),
      coalesce(array(select jsonb_array_elements_text(coalesce(r->'aliases','[]'::jsonb))),'{}'),nullif(r->>'latitude','')::numeric,nullif(r->>'longitude','')::numeric,p_source,p_source_version,
      nullif(r->>'valid_from','')::date,nullif(r->>'valid_until','')::date,coalesce(r->'metadata','{}'::jsonb))
    on conflict(country_code,area_type,code) do update set name=excluded.name,parent_code=excluded.parent_code,postal_code=excluded.postal_code,aliases=excluded.aliases,
      latitude=excluded.latitude,longitude=excluded.longitude,source=excluded.source,source_version=excluded.source_version,valid_from=excluded.valid_from,valid_until=excluded.valid_until,metadata=excluded.metadata,updated_at=now();
    n:=n+1;
  end loop;
  update public.geographic_areas child set parent_id=parent.id
  from public.geographic_areas parent
  where child.country_code=parent.country_code and child.parent_code=parent.code and child.parent_id is distinct from parent.id;
  return n;
end $$;

create or replace function public.apply_geographic_derived_value(p_entity_id uuid,p_source_entity_id uuid,p_permission_id uuid,p_field_key text,p_value jsonb,p_confidence numeric default .95)
returns boolean language plpgsql security definer set search_path=public as $$
declare me public.master_entities%rowtype; sf uuid; existing public.field_values%rowtype; priority integer; v_value_hash text;
begin
  if p_value is null or p_value='null'::jsonb then return false; end if;
  select * into me from public.master_entities where id=p_entity_id;
  if not found or p_source_entity_id is null or p_permission_id is null then return false; end if;
  if not exists(select 1 from public.provider_field_permissions where tenant_id=me.license_tenant_id and permission_id=p_permission_id and entity_type=me.entity_type and field_key=p_field_key and may_store) then return false; end if;
  v_value_hash:=encode(digest(p_value::text,'sha256'),'hex');
  insert into public.source_facts(source_entity_id,field_key,field_value,value_hash,fetched_at,last_seen_at,verified_at,confidence,permission_id)
  values(p_source_entity_id,p_field_key,p_value,v_value_hash,now(),now(),now(),p_confidence,p_permission_id)
  on conflict(source_entity_id,field_key,value_hash) do update set last_seen_at=now(),verified_at=now(),removed_at=null returning id into sf;
  priority:=public.source_priority_for(me.license_tenant_id,p_field_key,'derived');
  select * into existing from public.field_values where master_entity_id=p_entity_id and field_key=p_field_key for update;
  if not found then
    insert into public.field_values(master_entity_id,field_key,field_value,selected_source_fact_id,source_priority,confidence,verified_at)
    values(p_entity_id,p_field_key,p_value,sf,priority,p_confidence,now());
    insert into public.field_value_history(master_entity_id,field_key,new_value,source_fact_id,change_type) values(p_entity_id,p_field_key,p_value,sf,'created');
    return true;
  elsif existing.field_value is distinct from p_value and not existing.manually_verified and existing.source_priority>=priority then
    insert into public.field_value_history(master_entity_id,field_key,old_value,new_value,source_fact_id,change_type) values(p_entity_id,p_field_key,existing.field_value,p_value,sf,'changed');
    update public.field_values set field_value=p_value,selected_source_fact_id=sf,source_priority=priority,confidence=p_confidence,verified_at=now(),updated_at=now() where id=existing.id;
    return true;
  end if;
  return false;
end $$;

create or replace function public.normalize_master_entity_geography(p_entity_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare me public.master_entities%rowtype; postal public.geographic_areas%rowtype; municipality public.geographic_areas%rowtype; county public.geographic_areas%rowtype;
  source_entity uuid; permission uuid; input jsonb; input_hash text; normalized jsonb:='{}'::jsonb; method text:='none'; confidence numeric:=0;
begin
  select * into me from public.master_entities where id=p_entity_id and merged_into_id is null;
  if not found then return jsonb_build_object('normalized',false,'reason','entity_not_found'); end if;
  input:=jsonb_build_object('country_code',me.country_code,'postal_code',me.postal_code,'city',me.city,'municipality',me.municipality,'municipality_code',me.municipality_code,'county',me.county,'county_code',me.county_code);
  input_hash:=encode(digest(input::text,'sha256'),'hex');
  select sf.source_entity_id,sf.permission_id into source_entity,permission
  from public.field_values fv join public.source_facts sf on sf.id=fv.selected_source_fact_id
  where fv.master_entity_id=me.id and fv.field_key in ('postal_code','city','municipality','municipality_code','county','county_code')
  order by case fv.field_key when 'postal_code' then 1 when 'municipality_code' then 2 when 'municipality' then 3 else 4 end limit 1;

  if nullif(regexp_replace(coalesce(me.postal_code,''),'\s','','g'),'') is not null then
    select * into postal from public.geographic_areas ga where ga.country_code=me.country_code and ga.area_type='postal_code'
      and coalesce(ga.valid_until,current_date)>=current_date and (ga.postal_code=regexp_replace(me.postal_code,'\s','','g') or ga.code=regexp_replace(me.postal_code,'\s','','g')) limit 1;
  end if;
  if postal.id is not null and postal.parent_id is not null then select * into municipality from public.geographic_areas where id=postal.parent_id; method:='postal_code'; confidence:=1; end if;
  if municipality.id is null then
    select * into municipality from public.geographic_areas ga where ga.country_code=me.country_code and ga.area_type='municipality' and coalesce(ga.valid_until,current_date)>=current_date and (
      (me.municipality_code is not null and ga.code=me.municipality_code) or
      (nullif(me.municipality,'') is not null and (public.normalize_geo_token(ga.name)=public.normalize_geo_token(me.municipality) or exists(select 1 from unnest(ga.aliases)a where public.normalize_geo_token(a)=public.normalize_geo_token(me.municipality)))) or
      (nullif(me.city,'') is not null and (public.normalize_geo_token(ga.name)=public.normalize_geo_token(me.city) or exists(select 1 from unnest(ga.aliases)a where public.normalize_geo_token(a)=public.normalize_geo_token(me.city))))
    ) order by case when ga.code=me.municipality_code then 1 when public.normalize_geo_token(ga.name)=public.normalize_geo_token(me.municipality) then 2 else 3 end limit 1;
    if municipality.id is not null then method:='name_or_code'; confidence:=.9; end if;
  end if;
  if municipality.id is not null and municipality.parent_id is not null then select * into county from public.geographic_areas where id=municipality.parent_id; end if;
  if county.id is null then
    select * into county from public.geographic_areas ga where ga.country_code=me.country_code and ga.area_type='county' and (
      (me.county_code is not null and ga.code=me.county_code) or (nullif(me.county,'') is not null and (public.normalize_geo_token(ga.name)=public.normalize_geo_token(me.county) or exists(select 1 from unnest(ga.aliases)a where public.normalize_geo_token(a)=public.normalize_geo_token(me.county))))
    ) limit 1;
  end if;
  if municipality.id is not null then
    normalized:=normalized||jsonb_build_object('municipality',municipality.name,'municipality_code',municipality.code);
    perform public.apply_geographic_derived_value(me.id,source_entity,permission,'municipality',to_jsonb(municipality.name),confidence);
    perform public.apply_geographic_derived_value(me.id,source_entity,permission,'municipality_code',to_jsonb(municipality.code),confidence);
  end if;
  if county.id is not null then
    normalized:=normalized||jsonb_build_object('county',county.name,'county_code',county.code);
    perform public.apply_geographic_derived_value(me.id,source_entity,permission,'county',to_jsonb(county.name),confidence);
    perform public.apply_geographic_derived_value(me.id,source_entity,permission,'county_code',to_jsonb(county.code),confidence);
  end if;
  if postal.id is not null and postal.latitude is not null and postal.longitude is not null then
    normalized:=normalized||jsonb_build_object('latitude',postal.latitude,'longitude',postal.longitude);
    perform public.apply_geographic_derived_value(me.id,source_entity,permission,'latitude',to_jsonb(postal.latitude),confidence);
    perform public.apply_geographic_derived_value(me.id,source_entity,permission,'longitude',to_jsonb(postal.longitude),confidence);
  elsif municipality.id is not null and municipality.latitude is not null and municipality.longitude is not null then
    normalized:=normalized||jsonb_build_object('latitude',municipality.latitude,'longitude',municipality.longitude);
    perform public.apply_geographic_derived_value(me.id,source_entity,permission,'latitude',to_jsonb(municipality.latitude),confidence);
    perform public.apply_geographic_derived_value(me.id,source_entity,permission,'longitude',to_jsonb(municipality.longitude),confidence);
  end if;
  if normalized<>'{}'::jsonb then perform public.rebuild_master_entity(me.id); end if;
  insert into public.geographic_normalization_results(tenant_id,master_entity_id,input_hash,input_values,normalized_values,postal_area_id,municipality_area_id,county_area_id,match_method,confidence,normalized_at)
  values(me.license_tenant_id,me.id,input_hash,input,normalized,postal.id,municipality.id,county.id,method,confidence,now())
  on conflict(tenant_id,master_entity_id) do update set input_hash=excluded.input_hash,input_values=excluded.input_values,normalized_values=excluded.normalized_values,postal_area_id=excluded.postal_area_id,municipality_area_id=excluded.municipality_area_id,county_area_id=excluded.county_area_id,match_method=excluded.match_method,confidence=excluded.confidence,normalized_at=now();
  return jsonb_build_object('normalized',normalized<>'{}'::jsonb,'method',method,'confidence',confidence,'values',normalized);
end $$;

create or replace function public.normalize_due_geographies(p_limit integer default 500)
returns integer language plpgsql security definer set search_path=public as $$
declare r record; n integer:=0; h text;
begin
  for r in select me.id,me.country_code,me.postal_code,me.city,me.municipality,me.municipality_code,me.county,me.county_code,me.license_tenant_id
    from public.master_entities me left join public.geographic_normalization_results g on g.master_entity_id=me.id and g.tenant_id=me.license_tenant_id
    where me.merged_into_id is null and (me.postal_code is not null or me.city is not null or me.municipality is not null)
    order by me.updated_at desc limit greatest(1,least(p_limit,5000))
  loop
    h:=encode(digest(jsonb_build_object('country_code',r.country_code,'postal_code',r.postal_code,'city',r.city,'municipality',r.municipality,'municipality_code',r.municipality_code,'county',r.county,'county_code',r.county_code)::text,'sha256'),'hex');
    if not exists(select 1 from public.geographic_normalization_results where tenant_id=r.license_tenant_id and master_entity_id=r.id and input_hash=h) then perform public.normalize_master_entity_geography(r.id); n:=n+1; end if;
  end loop;
  return n;
end $$;

create or replace function public.customer_has_legal_retention(p_tenant_id uuid,p_customer_id uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select exists(select 1 from public.legal_holds h where h.tenant_id=p_tenant_id and h.customer_id=p_customer_id and h.active and (h.ends_at is null or h.ends_at>now()))
    or exists(select 1 from public.contracts c where c.tenant_id=p_tenant_id and c.customer_id=p_customer_id and c.status in ('accepted','signed','active','terminated'))
$$;

create or replace function public.anonymize_customer_record(p_tenant_id uuid,p_customer_id uuid,p_reason text,p_actor uuid default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare c public.customers%rowtype; token text; retained boolean; removed_master integer:=0;
begin
  select * into c from public.customers where tenant_id=p_tenant_id and id=p_customer_id for update;
  if not found then return jsonb_build_object('anonymized',false,'reason','customer_not_found'); end if;
  retained:=public.customer_has_legal_retention(p_tenant_id,p_customer_id);
  token:=substr(encode(digest(c.id::text||p_tenant_id::text,'sha256'),'hex'),1,12);
  if c.phone_e164 is not null or c.email is not null then
    insert into public.compliance_blocks(tenant_id,customer_id,phone_e164,email,channels,reason,source,active,created_by)
    select p_tenant_id,null,c.phone_e164,c.email,array['call','sms','email'],coalesce(p_reason,'retention_anonymization'),'retention',true,p_actor
    where not exists(select 1 from public.compliance_blocks b where b.tenant_id=p_tenant_id and b.active and b.source='retention' and (b.phone_e164=c.phone_e164 or b.email=c.email));
  end if;
  delete from public.contact_people where tenant_id=p_tenant_id and customer_id=p_customer_id;
  delete from public.notes where tenant_id=p_tenant_id and customer_id=p_customer_id;
  delete from public.customer_tags where tenant_id=p_tenant_id and customer_id=p_customer_id;
  delete from public.customer_list_members where tenant_id=p_tenant_id and customer_id=p_customer_id;
  update public.activities set description=null,metadata='{}'::jsonb where tenant_id=p_tenant_id and customer_id=p_customer_id and contract_id is null;
  update public.calls set from_number='[redacted]',to_number='[redacted]',notes=null,metadata='{}'::jsonb where tenant_id=p_tenant_id and customer_id=p_customer_id;
  update public.sms_messages set from_number='[redacted]',to_number='[redacted]',body='[redacted]' where tenant_id=p_tenant_id and customer_id=p_customer_id and contract_id is null;
  update public.email_messages set to_addresses=array['redacted@invalid.local']::citext[],cc_addresses='{}',subject='[redacted]',body_text=null,body_html=null,attachments='[]'::jsonb where tenant_id=p_tenant_id and customer_id=p_customer_id and contract_id is null;
  delete from public.master_entities me using public.tenant_entities te,public.data_providers dp
    where te.tenant_id=p_tenant_id and te.customer_id=p_customer_id and me.id=te.master_entity_id and me.cache_scope='tenant' and me.data_provider_id=dp.id and dp.source_class='tenant_import';
  get diagnostics removed_master=row_count;
  update public.customers set display_name='Raderad kund '||token,first_name=null,last_name=null,company_name=null,personal_identity_number=null,organization_number=case when retained then organization_number else null end,
    email=null,phone_e164=null,alternate_phone_e164=null,website=null,address_line1=null,address_line2=null,postal_code=null,city=null,municipality=null,county=null,latitude=null,longitude=null,current_supplier=null,
    source_name=null,source_external_id=null,source_retrieved_at=null,source_verified_at=null,marketing_allowed=false,legal_basis=null,do_not_call=true,do_not_sms=true,do_not_email=true,blocked_reason=coalesce(p_reason,'retention_anonymization'),
    assigned_user_id=null,assigned_team_id=null,campaign_id=null,custom_fields='{}'::jsonb,deleted_at=coalesce(deleted_at,now()),updated_at=now() where tenant_id=p_tenant_id and id=p_customer_id;
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data) values(p_tenant_id,p_actor,'customer.anonymized','customer',p_customer_id::text,jsonb_build_object('reason',p_reason,'legalRetention',retained,'tenantMasterEntitiesRemoved',removed_master));
  return jsonb_build_object('anonymized',true,'legalRetention',retained,'tenantMasterEntitiesRemoved',removed_master);
end $$;

create or replace function public.data_subject_export_for_request(p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r public.data_subject_requests%rowtype; result jsonb;
begin
  select * into r from public.data_subject_requests where id=p_request_id;
  if not found or r.customer_id is null then raise exception 'data_subject_request_customer_missing'; end if;
  if auth.uid() is not null and not public.is_tenant_admin(r.tenant_id) then raise exception 'admin_required'; end if;
  select jsonb_build_object(
    'requestId',r.id,'generatedAt',now(),'customer',(select to_jsonb(c)-'personal_identity_number' from public.customers c where c.tenant_id=r.tenant_id and c.id=r.customer_id),
    'contactPeople',coalesce((select jsonb_agg(to_jsonb(x)) from public.contact_people x where x.tenant_id=r.tenant_id and x.customer_id=r.customer_id),'[]'::jsonb),
    'activities',coalesce((select jsonb_agg(to_jsonb(x)) from public.activities x where x.tenant_id=r.tenant_id and x.customer_id=r.customer_id),'[]'::jsonb),
    'calls',coalesce((select jsonb_agg(to_jsonb(x)) from public.calls x where x.tenant_id=r.tenant_id and x.customer_id=r.customer_id),'[]'::jsonb),
    'sms',coalesce((select jsonb_agg(to_jsonb(x)) from public.sms_messages x where x.tenant_id=r.tenant_id and x.customer_id=r.customer_id),'[]'::jsonb),
    'email',coalesce((select jsonb_agg(to_jsonb(x)) from public.email_messages x where x.tenant_id=r.tenant_id and x.customer_id=r.customer_id),'[]'::jsonb),
    'contracts',coalesce((select jsonb_agg(to_jsonb(x)) from public.contracts x where x.tenant_id=r.tenant_id and x.customer_id=r.customer_id),'[]'::jsonb),
    'permissions',coalesce((select jsonb_agg(to_jsonb(x)) from public.contact_permissions x where x.tenant_id=r.tenant_id and x.customer_id=r.customer_id),'[]'::jsonb),
    'nixChecks',coalesce((select jsonb_agg(to_jsonb(x)) from public.nix_checks x where x.tenant_id=r.tenant_id and x.customer_id=r.customer_id),'[]'::jsonb)
  ) into result;
  return result;
end $$;

create or replace function public.execute_data_subject_erasure(p_request_id uuid,p_actor uuid default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r public.data_subject_requests%rowtype; result jsonb;
begin
  select * into r from public.data_subject_requests where id=p_request_id for update;
  if not found then raise exception 'data_subject_request_not_found'; end if;
  if r.request_type<>'erasure' then raise exception 'data_subject_request_not_erasure'; end if;
  if r.identity_verified_at is null then raise exception 'identity_verification_required'; end if;
  if r.customer_id is null then raise exception 'data_subject_request_customer_missing'; end if;
  if auth.uid() is not null and not public.is_tenant_admin(r.tenant_id) then raise exception 'admin_required'; end if;
  update public.data_subject_requests set status='processing',handled_by=p_actor where id=r.id;
  insert into public.data_subject_request_events(tenant_id,request_id,event_type,details,actor_user_id) values(r.tenant_id,r.id,'erasure_started','{}',p_actor);
  result:=public.anonymize_customer_record(r.tenant_id,r.customer_id,'data_subject_erasure',p_actor);
  update public.data_subject_requests set status='completed',completed_at=now(),handled_by=p_actor,processing_notes=case when result->>'legalRetention'='true' then 'Identifierare anonymiserade; juridiskt nödvändiga avtalsuppgifter bevarade.' else 'Tenantunik persondata anonymiserad.' end where id=r.id;
  insert into public.data_subject_request_events(tenant_id,request_id,event_type,details,actor_user_id) values(r.tenant_id,r.id,'erasure_completed',result,p_actor);
  return result;
end $$;

create or replace function public.run_retention_maintenance(p_tenant_id uuid,p_limit integer default 1000)
returns jsonb language plpgsql security definer set search_path=public as $$
declare rid uuid; raw_deleted integer:=0; recordings_purged integer:=0; anonymized integer:=0; policy public.retention_policies%rowtype; c record;
begin
 insert into public.retention_runs(tenant_id) values(p_tenant_id) returning id into rid;
 with doomed as (select id from public.raw_payloads where tenant_id=p_tenant_id and retention_until is not null and retention_until<=now() order by retention_until limit greatest(1,least(p_limit,10000)))
 update public.raw_payloads rp set payload_ciphertext=null,storage_path=null,metadata=metadata||jsonb_build_object('retentionPurgedAt',now()),parse_error=null from doomed where rp.id=doomed.id;
 get diagnostics raw_deleted=row_count;
 with doomed as (select cr.id from public.call_recordings cr where cr.tenant_id=p_tenant_id and cr.retention_until is not null and cr.retention_until<=now() order by cr.retention_until limit greatest(1,least(p_limit,10000)))
 update public.call_recordings cr set storage_path=null,status='purged' from doomed where cr.id=doomed.id;
 get diagnostics recordings_purged=row_count;
 select * into policy from public.retention_policies where tenant_id=p_tenant_id and active and data_category='prospect_personal_data' and action in ('anonymize','delete') order by updated_at desc limit 1;
 if found then
   for c in select cu.id from public.customers cu where cu.tenant_id=p_tenant_id and cu.deleted_at is null and cu.lifecycle in ('prospect','lost','former_customer')
     and cu.updated_at<now()-make_interval(days=>policy.retention_days) and not public.customer_has_legal_retention(p_tenant_id,cu.id)
     order by cu.updated_at limit greatest(1,least(p_limit,10000))
   loop perform public.anonymize_customer_record(p_tenant_id,c.id,'retention_policy:'||policy.id::text,null); anonymized:=anonymized+1; end loop;
 end if;
 update public.retention_runs set status='completed',deleted_count=raw_deleted+recordings_purged,anonymized_count=anonymized,completed_at=now(),details=jsonb_build_object('rawPayloadsPurged',raw_deleted,'recordingsPurged',recordings_purged,'customersAnonymized',anonymized) where id=rid;
 return jsonb_build_object('runId',rid,'rawPayloadsPurged',raw_deleted,'recordingsPurged',recordings_purged,'customersAnonymized',anonymized);
exception when others then update public.retention_runs set status='failed',last_error=sqlerrm,completed_at=now() where id=rid; raise;
end $$;

revoke all on function public.upsert_geographic_reference_batch(jsonb,text,text),public.normalize_due_geographies(integer),public.normalize_master_entity_geography(uuid),public.run_retention_maintenance(uuid,integer),public.data_subject_export_for_request(uuid),public.execute_data_subject_erasure(uuid,uuid),public.anonymize_customer_record(uuid,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.upsert_geographic_reference_batch(jsonb,text,text),public.normalize_due_geographies(integer),public.normalize_master_entity_geography(uuid),public.run_retention_maintenance(uuid,integer),public.data_subject_export_for_request(uuid),public.execute_data_subject_erasure(uuid,uuid),public.anonymize_customer_record(uuid,uuid,text,uuid) to service_role;

commit;
