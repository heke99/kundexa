begin;

create unique index if not exists provider_permissions_name_uidx
  on public.provider_permissions(tenant_id,data_provider_id,permission_name);
create unique index if not exists provider_freshness_default_uidx
  on public.provider_freshness_policies(data_provider_id,entity_type)
  where field_key is null;

create or replace function public.configure_generic_json_provider(
  p_provider text,
  p_name text,
  p_permission_name text,
  p_endpoint_template text,
  p_method text,
  p_credentials_ciphertext text,
  p_field_mapping jsonb,
  p_allowed_domains text[],
  p_allowed_paths text[],
  p_allowed_entity_types public.directory_entity_type[],
  p_allowed_purposes text[],
  p_cache_scope public.provider_cache_scope,
  p_raw_storage_allowed boolean,
  p_tenant_display_allowed boolean,
  p_cross_tenant_reuse_allowed boolean,
  p_export_allowed boolean,
  p_attribution_required boolean,
  p_retention_days integer,
  p_written_approval_reference text,
  p_quota_units integer,
  p_quota_window_seconds integer,
  p_max_concurrency integer,
  p_minimum_delay_ms integer,
  p_timeout_ms integer,
  p_max_retries integer,
  p_ttl_days integer,
  p_estimated_cost_per_call numeric default 0
)
returns jsonb
language plpgsql security definer set search_path=public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_user uuid := auth.uid();
  v_provider uuid;
  v_account uuid;
  v_permission uuid;
  v_entity_type public.directory_entity_type;
  v_field text;
  v_configuration jsonb;
begin
  if v_user is null or v_tenant is null then raise exception 'authentication_required'; end if;
  if not public.is_tenant_admin(v_tenant) then raise exception 'admin_required'; end if;
  if p_provider !~ '^[a-z0-9][a-z0-9_-]{1,62}$' then raise exception 'provider_key_invalid'; end if;
  if nullif(trim(p_name),'') is null or nullif(trim(p_permission_name),'') is null then raise exception 'provider_name_required'; end if;
  if p_endpoint_template !~ '^https://' then raise exception 'provider_https_endpoint_required'; end if;
  if position('{{external_identifier}}' in p_endpoint_template)=0 and position('{{organization_number}}' in p_endpoint_template)=0 then
    raise exception 'provider_endpoint_identifier_placeholder_required';
  end if;
  if upper(p_method) not in ('GET','POST') then raise exception 'provider_method_invalid'; end if;
  if jsonb_typeof(p_field_mapping)<>'object' or p_field_mapping='{}'::jsonb then raise exception 'provider_field_mapping_required'; end if;
  if coalesce(cardinality(p_allowed_domains),0)=0 then raise exception 'provider_allowed_domain_required'; end if;
  if coalesce(cardinality(p_allowed_entity_types),0)=0 then raise exception 'provider_entity_type_required'; end if;
  if p_cache_scope='global' and (not p_cross_tenant_reuse_allowed or not p_tenant_display_allowed or nullif(trim(p_written_approval_reference),'') is null) then
    raise exception 'global_cache_requires_documented_cross_tenant_permission';
  end if;
  if p_raw_storage_allowed and p_retention_days is null then raise exception 'raw_storage_retention_required'; end if;
  if p_retention_days is not null and p_retention_days<0 then raise exception 'retention_days_invalid'; end if;
  if p_quota_units<1 or p_quota_window_seconds<1 or p_max_concurrency<1 then raise exception 'provider_rate_limit_invalid'; end if;
  if p_ttl_days<0 or p_ttl_days>3650 then raise exception 'provider_ttl_invalid'; end if;

  insert into public.data_providers(
    tenant_id,provider,name,field_mapping,license_terms,status,adapter_key,integration_type,cache_scope,
    allowed_entity_types,allowed_purposes,allow_raw_storage,allow_tenant_display,allow_export,
    source_attribution_required,valid_from
  ) values (
    v_tenant,p_provider,p_name,p_field_mapping,
    jsonb_build_object('written_approval_reference',nullif(p_written_approval_reference,''),'configured_at',now()),
    'active','generic_json','api',p_cache_scope,p_allowed_entity_types,coalesce(p_allowed_purposes,'{}'::text[]),
    p_raw_storage_allowed,p_tenant_display_allowed,p_export_allowed,p_attribution_required,current_date
  )
  on conflict(tenant_id,provider,name) do update set
    field_mapping=excluded.field_mapping,license_terms=excluded.license_terms,status='active',adapter_key='generic_json',
    integration_type='api',cache_scope=excluded.cache_scope,allowed_entity_types=excluded.allowed_entity_types,
    allowed_purposes=excluded.allowed_purposes,allow_raw_storage=excluded.allow_raw_storage,
    allow_tenant_display=excluded.allow_tenant_display,allow_export=excluded.allow_export,
    source_attribution_required=excluded.source_attribution_required,updated_at=now()
  returning id into v_provider;

  v_configuration := jsonb_build_object(
    'endpoint_template',p_endpoint_template,'method',upper(p_method),'field_mapping',p_field_mapping,
    'timeout_ms',p_timeout_ms,'estimated_cost_per_call',coalesce(p_estimated_cost_per_call,0)
  );

  select id into v_account from public.provider_accounts
    where tenant_id=v_tenant and data_provider_id=v_provider and name=p_name||' API' for update;
  if v_account is null then
    insert into public.provider_accounts(
      tenant_id,data_provider_id,name,credentials_ciphertext,status,configuration,created_by
    ) values (
      v_tenant,v_provider,p_name||' API',nullif(p_credentials_ciphertext,''),'active',v_configuration,v_user
    ) returning id into v_account;
  else
    update public.provider_accounts set
      credentials_ciphertext=coalesce(nullif(p_credentials_ciphertext,''),credentials_ciphertext),
      status='active',configuration=v_configuration,updated_at=now()
    where id=v_account;
  end if;

  insert into public.provider_account_tenants(provider_account_id,owner_tenant_id,tenant_id)
    values(v_account,v_tenant,v_tenant)
  on conflict(provider_account_id,tenant_id) do nothing;

  insert into public.provider_permissions(
    tenant_id,data_provider_id,provider_account_id,permission_name,cache_scope,allowed_domains,allowed_paths,
    allowed_entity_types,allowed_purposes,raw_storage_allowed,tenant_display_allowed,cross_tenant_reuse_allowed,
    export_allowed,resale_allowed,attribution_required,retention_days,starts_at,written_approval_reference,status,created_by
  ) values (
    v_tenant,v_provider,v_account,p_permission_name,p_cache_scope,p_allowed_domains,coalesce(p_allowed_paths,'{}'::text[]),
    p_allowed_entity_types,coalesce(p_allowed_purposes,'{}'::text[]),p_raw_storage_allowed,p_tenant_display_allowed,
    p_cross_tenant_reuse_allowed,p_export_allowed,false,p_attribution_required,p_retention_days,now(),
    nullif(p_written_approval_reference,''),'active',v_user
  )
  on conflict(tenant_id,data_provider_id,permission_name) do update set
    provider_account_id=excluded.provider_account_id,cache_scope=excluded.cache_scope,
    allowed_domains=excluded.allowed_domains,allowed_paths=excluded.allowed_paths,
    allowed_entity_types=excluded.allowed_entity_types,allowed_purposes=excluded.allowed_purposes,
    raw_storage_allowed=excluded.raw_storage_allowed,tenant_display_allowed=excluded.tenant_display_allowed,
    cross_tenant_reuse_allowed=excluded.cross_tenant_reuse_allowed,export_allowed=excluded.export_allowed,
    resale_allowed=false,attribution_required=excluded.attribution_required,retention_days=excluded.retention_days,
    starts_at=coalesce(public.provider_permissions.starts_at,now()),expires_at=null,
    written_approval_reference=excluded.written_approval_reference,status='active',updated_at=now()
  returning id into v_permission;

  delete from public.provider_field_permissions where tenant_id=v_tenant and permission_id=v_permission;
  for v_entity_type in select unnest(p_allowed_entity_types)
  loop
    for v_field in select jsonb_object_keys(p_field_mapping)
    loop
      insert into public.provider_field_permissions(
        tenant_id,permission_id,entity_type,field_key,may_fetch,may_store,may_display,may_filter,may_export,retention_days
      ) values (
        v_tenant,v_permission,v_entity_type,v_field,true,true,p_tenant_display_allowed,p_tenant_display_allowed,
        p_export_allowed,p_retention_days
      );
    end loop;

    delete from public.provider_freshness_policies
      where tenant_id=v_tenant and data_provider_id=v_provider and entity_type=v_entity_type and field_key is null;
    insert into public.provider_freshness_policies(
      tenant_id,data_provider_id,entity_type,field_key,ttl_days,stale_while_revalidate,active
    ) values (v_tenant,v_provider,v_entity_type,null,p_ttl_days,true,true);
  end loop;

  insert into public.provider_rate_limits(
    tenant_id,provider_account_id,quota_key,window_seconds,max_units,max_concurrency,minimum_delay_ms,timeout_ms,max_retries
  ) values (
    v_tenant,v_account,'enrichment',p_quota_window_seconds,p_quota_units,p_max_concurrency,
    p_minimum_delay_ms,p_timeout_ms,p_max_retries
  )
  on conflict(provider_account_id,quota_key) do update set
    window_seconds=excluded.window_seconds,max_units=excluded.max_units,max_concurrency=excluded.max_concurrency,
    minimum_delay_ms=excluded.minimum_delay_ms,timeout_ms=excluded.timeout_ms,max_retries=excluded.max_retries,updated_at=now();

  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
    values(v_tenant,v_user,'data_provider.configured','data_provider',v_provider::text,
      jsonb_build_object('provider',p_provider,'account_id',v_account,'permission_id',v_permission,'cache_scope',p_cache_scope));
  return jsonb_build_object('provider_id',v_provider,'account_id',v_account,'permission_id',v_permission);
end
$$;

revoke all on function public.configure_generic_json_provider(
  text,text,text,text,text,text,jsonb,text[],text[],public.directory_entity_type[],text[],public.provider_cache_scope,
  boolean,boolean,boolean,boolean,boolean,integer,text,integer,integer,integer,integer,integer,integer,integer,numeric
) from public,anon;
grant execute on function public.configure_generic_json_provider(
  text,text,text,text,text,text,jsonb,text[],text[],public.directory_entity_type[],text[],public.provider_cache_scope,
  boolean,boolean,boolean,boolean,boolean,integer,text,integer,integer,integer,integer,integer,integer,integer,numeric
) to authenticated;

commit;
