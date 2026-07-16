begin;

alter table public.import_runs
  add column if not exists file_mime_type text,
  add column if not exists file_size_bytes bigint,
  add column if not exists scan_status text not null default 'pending' check (scan_status in ('pending','clean','infected','failed','waived')),
  add column if not exists scan_provider text,
  add column if not exists scan_sha256 text,
  add column if not exists scan_completed_at timestamptz,
  add column if not exists catalog_sync_status text not null default 'pending' check (catalog_sync_status in ('pending','processing','completed','failed'));

create index if not exists import_runs_scan_idx on public.import_runs(tenant_id,scan_status,status,created_at desc);

create or replace function public.ensure_tenant_import_provider(p_tenant_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_provider uuid; v_account uuid; v_permission uuid; v_field text; v_entity public.directory_entity_type;
begin
  if auth.uid() is not null and p_tenant_id<>public.current_tenant_id() then raise exception 'tenant_mismatch'; end if;
  insert into public.data_providers(
    tenant_id,provider,name,field_mapping,license_terms,status,adapter_key,integration_type,cache_scope,
    allowed_entity_types,allowed_purposes,allow_raw_storage,allow_tenant_display,allow_export,
    source_attribution_required,source_class,valid_from
  ) values (
    p_tenant_id,'tenant_import','Tenant imports',
    '{"canonical_name":"display_name","organization_number":"organization_number","email":"email","phone_e164":"phone_e164","city":"city","county":"county","industry":"industry","sni_code":"sni_code"}'::jsonb,
    jsonb_build_object('scope','tenant_only','generated_by','Kundexa'),
    'active','file_import','file','tenant',array['organization','person']::public.directory_entity_type[],array['crm_import'],true,true,false,false,'tenant_import',current_date
  ) on conflict(tenant_id,provider,name) do update set status='active',source_class='tenant_import',updated_at=now() returning id into v_provider;

  select id into v_account from public.provider_accounts where tenant_id=p_tenant_id and data_provider_id=v_provider and name='Tenant imports' for update;
  if v_account is null then
    insert into public.provider_accounts(tenant_id,data_provider_id,name,status,configuration,created_by)
    values(p_tenant_id,v_provider,'Tenant imports','active','{"managed":true}'::jsonb,auth.uid()) returning id into v_account;
  end if;
  insert into public.provider_account_tenants(provider_account_id,owner_tenant_id,tenant_id)
  values(v_account,p_tenant_id,p_tenant_id) on conflict(provider_account_id,tenant_id) do nothing;

  insert into public.provider_permissions(
    tenant_id,data_provider_id,provider_account_id,permission_name,cache_scope,allowed_domains,allowed_paths,
    allowed_entity_types,allowed_purposes,raw_storage_allowed,tenant_display_allowed,cross_tenant_reuse_allowed,
    export_allowed,resale_allowed,attribution_required,retention_days,starts_at,written_approval_reference,status,created_by
  ) values (
    p_tenant_id,v_provider,v_account,'Tenant-owned import data','tenant','{}','{}',array['organization','person']::public.directory_entity_type[],array['crm_import'],
    true,true,false,false,false,false,365,now(),'Tenant-provided source data','active',auth.uid()
  ) on conflict(tenant_id,data_provider_id,permission_name) do update set provider_account_id=excluded.provider_account_id,status='active',updated_at=now()
  returning id into v_permission;

  foreach v_entity in array array['organization','person']::public.directory_entity_type[] loop
    foreach v_field in array array['canonical_name','organization_number','email','phone_e164','city','county','industry','sni_code'] loop
      insert into public.provider_field_permissions(tenant_id,permission_id,entity_type,field_key,may_fetch,may_store,may_display,may_filter,may_export,retention_days)
      values(p_tenant_id,v_permission,v_entity,v_field,true,true,true,true,false,365)
      on conflict(permission_id,entity_type,field_key) do update set may_fetch=true,may_store=true,may_display=true,may_filter=true,may_export=false,retention_days=365;
    end loop;
    insert into public.provider_freshness_policies(tenant_id,data_provider_id,entity_type,field_key,ttl_days,stale_while_revalidate,active)
    values(p_tenant_id,v_provider,v_entity,null,20,true,true)
    on conflict(data_provider_id,entity_type) where field_key is null do update set ttl_days=20,active=true,updated_at=now();
  end loop;
  return jsonb_build_object('provider_id',v_provider,'account_id',v_account,'permission_id',v_permission);
end $$;

create or replace function public.sync_tenant_import_to_directory(
  p_tenant_id uuid,p_import_run_id uuid,p_import_row_id bigint,p_customer_id uuid,p_data jsonb
) returns uuid language plpgsql security definer set search_path=public as $$
declare cfg jsonb; v_provider uuid; v_account uuid; v_permission uuid; v_entity public.master_entities%rowtype; v_source public.source_entities%rowtype;
  v_type public.directory_entity_type; v_external text; v_pair record; v_value jsonb; v_sf uuid; v_priority integer; v_fresh timestamptz:=now()+interval '20 days';
begin
  cfg:=public.ensure_tenant_import_provider(p_tenant_id);
  v_provider:=(cfg->>'provider_id')::uuid; v_account:=(cfg->>'account_id')::uuid; v_permission:=(cfg->>'permission_id')::uuid;
  v_type:=case when p_data->>'customer_type'='person' then 'person'::public.directory_entity_type else 'organization'::public.directory_entity_type end;
  v_external:=p_import_run_id::text||':'||p_import_row_id::text;

  select * into v_entity from public.master_entities me where me.owner_tenant_id=p_tenant_id and me.merged_into_id is null and (
    (nullif(p_data->>'organization_number','') is not null and me.organization_number=p_data->>'organization_number') or
    (nullif(p_data->>'phone_e164','') is not null and me.phone_e164=p_data->>'phone_e164') or
    (nullif(p_data->>'email','') is not null and me.email=(p_data->>'email')::citext)
  ) order by case when me.organization_number=p_data->>'organization_number' then 1 when me.phone_e164=p_data->>'phone_e164' then 2 else 3 end limit 1 for update;

  if not found then
    insert into public.master_entities(entity_type,cache_scope,owner_tenant_id,license_tenant_id,data_provider_id,provider_account_id,permission_id,canonical_name,organization_number,external_primary_id,country_code)
    values(v_type,'tenant',p_tenant_id,p_tenant_id,v_provider,v_account,v_permission,coalesce(nullif(p_data->>'display_name',''),v_external),nullif(p_data->>'organization_number',''),v_external,'SE')
    returning * into v_entity;
  end if;

  insert into public.source_entities(owner_tenant_id,data_provider_id,provider_account_id,permission_id,entity_type,external_identifier,last_seen_at,metadata)
  values(p_tenant_id,v_provider,v_account,v_permission,v_type,v_external,now(),jsonb_build_object('import_run_id',p_import_run_id,'import_row_id',p_import_row_id))
  on conflict(data_provider_id,provider_account_id,entity_type,external_identifier) do update set last_seen_at=now(),removed_at=null,metadata=excluded.metadata returning * into v_source;
  insert into public.entity_source_links(master_entity_id,source_entity_id,match_method,confidence,manually_verified)
  values(v_entity.id,v_source.id,'tenant_import',.9,false)
  on conflict(master_entity_id,source_entity_id) do update set confidence=greatest(public.entity_source_links.confidence,excluded.confidence);

  v_priority:=public.source_priority_for(p_tenant_id,'*','tenant_import');
  for v_pair in select * from jsonb_each(jsonb_build_object(
    'canonical_name',p_data->'display_name','organization_number',p_data->'organization_number','email',p_data->'email','phone_e164',p_data->'phone_e164',
    'city',p_data->'city','county',p_data->'county','industry',p_data->'industry','sni_code',p_data->'sni_code'
  )) loop
    v_value:=v_pair.value;
    if v_value is null or v_value='null'::jsonb or trim(both '"' from v_value::text)='' then continue; end if;
    insert into public.source_facts(source_entity_id,field_key,field_value,value_hash,fetched_at,last_seen_at,verified_at,confidence,permission_id)
    values(v_source.id,v_pair.key,v_value,md5(v_value::text),now(),now(),now(),.9,v_permission)
    on conflict(source_entity_id,field_key,value_hash) do update set last_seen_at=now(),verified_at=now(),removed_at=null returning id into v_sf;
    insert into public.field_values(master_entity_id,field_key,field_value,selected_source_fact_id,source_priority,confidence,verified_at,fresh_until)
    values(v_entity.id,v_pair.key,v_value,v_sf,public.source_priority_for(p_tenant_id,v_pair.key,'tenant_import'),.9,now(),v_fresh)
    on conflict(master_entity_id,field_key) do update set
      field_value=case when public.field_values.manually_verified or public.field_values.source_priority<excluded.source_priority then public.field_values.field_value else excluded.field_value end,
      selected_source_fact_id=case when public.field_values.manually_verified or public.field_values.source_priority<excluded.source_priority then public.field_values.selected_source_fact_id else excluded.selected_source_fact_id end,
      source_priority=least(public.field_values.source_priority,excluded.source_priority),confidence=greatest(public.field_values.confidence,excluded.confidence),verified_at=now(),fresh_until=excluded.fresh_until,updated_at=now();
    insert into public.field_freshness(master_entity_id,field_key,verified_at,fresh_until,next_refresh_at,state,updated_at)
    values(v_entity.id,v_pair.key,now(),v_fresh,v_fresh,'fresh',now())
    on conflict(master_entity_id,field_key) do update set verified_at=now(),fresh_until=excluded.fresh_until,next_refresh_at=excluded.next_refresh_at,state='fresh',updated_at=now();
  end loop;

  perform public.rebuild_master_entity(v_entity.id);
  update public.master_entities set enriched_at=now(),fresh_until=v_fresh,next_refresh_at=v_fresh,updated_at=now() where id=v_entity.id;
  insert into public.entity_freshness(master_entity_id,state,enriched_at,fresh_until,next_refresh_at,last_refresh_completed_at,updated_at)
  values(v_entity.id,'fresh',now(),v_fresh,v_fresh,now(),now()) on conflict(master_entity_id) do update set state='fresh',enriched_at=now(),fresh_until=excluded.fresh_until,next_refresh_at=excluded.next_refresh_at,last_refresh_completed_at=now(),updated_at=now();
  insert into public.tenant_entities(tenant_id,master_entity_id,customer_id,relationship,source,created_by)
  values(p_tenant_id,v_entity.id,p_customer_id,'prospect','tenant_import',auth.uid())
  on conflict(tenant_id,master_entity_id) do update set customer_id=excluded.customer_id,source='tenant_import',updated_at=now();
  return v_entity.id;
end $$;

create or replace function public.process_import_run(p_import_run_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_tenant_id uuid; v_status public.import_status; v_name text; v_source_type text; v_scan text; v_created_by uuid:=auth.uid(); v_row record; v_data jsonb;
  v_existing_id uuid; v_new_id uuid; v_created_ids uuid[]:='{}'::uuid[]; v_new integer:=0; v_duplicates integer:=0; v_blocked integer:=0; v_errors integer:=0; v_catalog integer:=0;
begin
  select tenant_id,status,name,source_type,scan_status into v_tenant_id,v_status,v_name,v_source_type,v_scan
  from public.import_runs where id=p_import_run_id and tenant_id=public.current_tenant_id() for update;
  if v_tenant_id is null then raise exception 'import_run_not_found'; end if;
  if not public.has_current_role(array['owner','admin','team_lead','backoffice']) then raise exception 'permission_denied'; end if;
  if v_status<>'preview_ready' then raise exception 'import_run_not_ready'; end if;
  if v_scan not in ('clean','waived') then raise exception 'import_file_not_security_cleared'; end if;
  update public.import_runs set status='processing',simulation=false,started_at=now(),catalog_sync_status='processing' where id=p_import_run_id;

  for v_row in select * from public.import_rows where tenant_id=v_tenant_id and import_run_id=p_import_run_id order by row_number for update loop
    if v_row.decision<>'ready' then if v_row.decision='error' then v_errors:=v_errors+1; end if; continue; end if;
    v_data:=coalesce(v_row.normalized_data,'{}'::jsonb); v_existing_id:=null;
    if exists(select 1 from public.compliance_blocks b where b.tenant_id=v_tenant_id and b.active and (b.expires_at is null or b.expires_at>now()) and ((nullif(v_data->>'phone_e164','') is not null and b.phone_e164=v_data->>'phone_e164') or (nullif(v_data->>'email','') is not null and b.email=v_data->>'email'))) then
      update public.import_rows set decision='blocked' where id=v_row.id; v_blocked:=v_blocked+1; continue;
    end if;
    select c.id into v_existing_id from public.customers c where c.tenant_id=v_tenant_id and c.deleted_at is null and (
      (nullif(v_data->>'organization_number','') is not null and c.organization_number=v_data->>'organization_number') or
      (nullif(v_data->>'phone_e164','') is not null and c.phone_e164=v_data->>'phone_e164') or
      (nullif(v_data->>'email','') is not null and c.email=v_data->>'email')) order by c.updated_at desc limit 1;
    if v_existing_id is not null then
      update public.import_rows set decision='duplicate',matched_customer_id=v_existing_id where id=v_row.id; v_duplicates:=v_duplicates+1;
      perform public.sync_tenant_import_to_directory(v_tenant_id,p_import_run_id,v_row.id,v_existing_id,v_data); v_catalog:=v_catalog+1; continue;
    end if;
    insert into public.customers(tenant_id,customer_type,lifecycle,display_name,email,phone_e164,organization_number,city,county,industry,sni_code,source_name,source_external_id,source_retrieved_at,created_by)
    values(v_tenant_id,case when v_data->>'customer_type'='person' then 'person'::public.customer_type else 'company'::public.customer_type end,'prospect',nullif(v_data->>'display_name',''),nullif(v_data->>'email',''),nullif(v_data->>'phone_e164',''),nullif(v_data->>'organization_number',''),nullif(v_data->>'city',''),nullif(v_data->>'county',''),nullif(v_data->>'industry',''),nullif(v_data->>'sni_code',''),v_source_type||':'||v_name,v_row.id::text,now(),v_created_by) returning id into v_new_id;
    update public.import_rows set decision='inserted',matched_customer_id=v_new_id where id=v_row.id;
    perform public.sync_tenant_import_to_directory(v_tenant_id,p_import_run_id,v_row.id,v_new_id,v_data); v_catalog:=v_catalog+1;
    v_created_ids:=array_append(v_created_ids,v_new_id); v_new:=v_new+1;
  end loop;

  update public.import_runs set status='completed',new_count=v_new,updated_count=0,duplicate_count=v_duplicates,blocked_count=v_blocked,error_count=v_errors,catalog_sync_status='completed',
    rollback_data=jsonb_build_object('created_customer_ids',to_jsonb(v_created_ids)),validation_report=validation_report||jsonb_build_object('processed_at',now(),'new',v_new,'duplicates',v_duplicates,'blocked',v_blocked,'errors',v_errors,'catalog_synced',v_catalog),completed_at=now()
  where id=p_import_run_id;
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
  values(v_tenant_id,v_created_by,'import.completed','import_run',p_import_run_id,jsonb_build_object('new',v_new,'duplicates',v_duplicates,'blocked',v_blocked,'errors',v_errors,'catalog_synced',v_catalog));
  return jsonb_build_object('new',v_new,'duplicates',v_duplicates,'blocked',v_blocked,'errors',v_errors,'catalogSynced',v_catalog);
exception when others then
  if v_tenant_id is not null then update public.import_runs set status='failed',catalog_sync_status='failed',completed_at=now(),validation_report=validation_report||jsonb_build_object('execution_error',sqlerrm) where id=p_import_run_id; end if;
  raise;
end $$;

revoke all on function public.ensure_tenant_import_provider(uuid) from public,anon;
revoke all on function public.sync_tenant_import_to_directory(uuid,uuid,bigint,uuid,jsonb) from public,anon;
revoke all on function public.process_import_run(uuid) from public,anon;
grant execute on function public.ensure_tenant_import_provider(uuid),public.sync_tenant_import_to_directory(uuid,uuid,bigint,uuid,jsonb),public.process_import_run(uuid) to authenticated,service_role;

update storage.buckets set allowed_mime_types=array[
  'text/csv','text/plain','application/json','application/x-ndjson','application/xml','text/xml',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
] where id='imports';

commit;
