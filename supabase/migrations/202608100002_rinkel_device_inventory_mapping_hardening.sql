-- Rinkel device inventory and seller-mapping hardening.
-- Forward-only: preserve historical migrations and public RPC signatures.

-- A platform user without an active provider device cannot produce a valid /dial request.
-- Prevent unusable allocations from being created after the central catalog has been synced.
create or replace function public.allocate_platform_rinkel_resource(
  p_resource_type text,
  p_resource_id uuid,
  p_tenant_id uuid,
  p_reason text default null
) returns uuid
language plpgsql
security definer
set search_path=''
as $$
declare
  v_actor uuid:=auth.uid();
  v_id uuid;
begin
  if v_actor is null or not public.is_platform_role(array[
    'platform_owner'::public.platform_role,
    'platform_admin'::public.platform_role
  ]) then
    raise exception 'PLATFORM_ADMIN_REQUIRED';
  end if;
  if not exists(
    select 1 from public.tenants
    where id=p_tenant_id and status in ('trial','active')
  ) then
    raise exception 'TENANT_NOT_ACTIVE';
  end if;

  if p_resource_type='user' then
    if not exists(
      select 1 from public.platform_rinkel_users
      where id=p_resource_id and active
    ) then
      raise exception 'RINKEL_USER_INACTIVE';
    end if;
    if not exists(
      select 1
      from public.platform_rinkel_devices device
      where device.platform_rinkel_user_id=p_resource_id
        and device.active
    ) then
      raise exception 'RINKEL_USER_DEVICE_MISSING';
    end if;

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('rinkel-user:'||p_resource_id::text||':'||p_tenant_id::text,0)
    );
    select id into v_id
    from public.rinkel_user_allocations
    where rinkel_user_id=p_resource_id
      and tenant_id=p_tenant_id
      and status='active'
      and valid_to is null
    for update;
    if v_id is null then
      insert into public.rinkel_user_allocations(
        rinkel_user_id,tenant_id,allocated_by,allocation_reason
      ) values(p_resource_id,p_tenant_id,v_actor,p_reason)
      returning id into v_id;
    end if;

  elsif p_resource_type='number' then
    if not exists(
      select 1 from public.platform_rinkel_numbers
      where id=p_resource_id and active
    ) then
      raise exception 'PHONE_NUMBER_INACTIVE';
    end if;

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('rinkel-number:'||p_resource_id::text||':'||p_tenant_id::text,0)
    );
    select id into v_id
    from public.rinkel_number_allocations
    where rinkel_number_id=p_resource_id
      and tenant_id=p_tenant_id
      and status='active'
      and valid_to is null
    for update;
    if v_id is null then
      insert into public.rinkel_number_allocations(
        rinkel_number_id,tenant_id,allocated_by,allocation_reason
      ) values(p_resource_id,p_tenant_id,v_actor,p_reason)
      returning id into v_id;
    end if;

    insert into public.rinkel_number_grants(
      tenant_id,number_allocation_id,access_level,active,created_by
    ) values(p_tenant_id,v_id,'dial',true,v_actor)
    on conflict(number_allocation_id,access_level)
      where active and team_id is null and user_id is null
    do update set updated_at=pg_catalog.now();
  else
    raise exception 'INVALID_RINKEL_RESOURCE_TYPE';
  end if;

  insert into public.platform_audit_logs(
    actor_user_id,action,entity_type,entity_id,tenant_id,reason,metadata
  ) values(
    v_actor,'rinkel.resource_allocated','rinkel_'||p_resource_type,
    p_resource_id::text,p_tenant_id,p_reason,
    pg_catalog.jsonb_build_object('allocation_id',v_id,'shared_across_tenants',true)
  );
  return v_id;
end
$$;
revoke all on function public.allocate_platform_rinkel_resource(text,uuid,uuid,text)
  from public,anon;
grant execute on function public.allocate_platform_rinkel_resource(text,uuid,uuid,text)
  to authenticated;

-- Keep the tenant projection explicit about whether zero devices means an authoritative
-- provider result or only an incomplete provider payload. No raw provider payload is exposed.
create or replace function public.get_tenant_rinkel_resources()
returns jsonb
language sql
stable
security definer
set search_path=''
as $$
select pg_catalog.jsonb_build_object(
  'users',coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'allocationId',allocation.id,
      'userId',provider_user.id,
      'displayName',provider_user.display_name,
      'email',provider_user.email,
      'hasDevice',exists(
        select 1 from public.platform_rinkel_devices device
        where device.platform_rinkel_user_id=provider_user.id and device.active
      ),
      'activeDeviceCount',(
        select pg_catalog.count(*)::integer
        from public.platform_rinkel_devices device
        where device.platform_rinkel_user_id=provider_user.id and device.active
      ),
      'deviceInventoryComplete',coalesce(
        (provider_user.raw_provider_data #>> '{_kundexa_sync,device_inventory_complete}')::boolean,
        false
      ),
      'deviceInventorySource',provider_user.raw_provider_data #>> '{_kundexa_sync,device_inventory_source}',
      'deviceInventoryError',provider_user.raw_provider_data #>> '{_kundexa_sync,device_inventory_error}',
      'active',provider_user.active,
      'devices',coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id',device.id,
          'providerDeviceId',device.provider_device_id,
          'displayName',device.display_name,
          'deviceType',device.device_type,
          'status',device.provider_status,
          'active',device.active,
          'lastSyncedAt',device.last_synced_at
        ) order by device.display_name nulls last,device.provider_device_id)
        from public.platform_rinkel_devices device
        where device.platform_rinkel_user_id=provider_user.id
      ),'[]'::jsonb)
    ) order by provider_user.display_name)
    from public.rinkel_user_allocations allocation
    join public.platform_rinkel_users provider_user on provider_user.id=allocation.rinkel_user_id
    where allocation.tenant_id=public.current_tenant_id()
      and allocation.status='active'
      and allocation.valid_to is null
  ),'[]'::jsonb),
  'numbers',coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'allocationId',allocation.id,
      'numberId',provider_number.id,
      'number',provider_number.phone_number_e164,
      'displayName',provider_number.display_name,
      'recordingEnabled',provider_number.recording_enabled,
      'active',provider_number.active
    ) order by provider_number.phone_number_e164)
    from public.rinkel_number_allocations allocation
    join public.platform_rinkel_numbers provider_number on provider_number.id=allocation.rinkel_number_id
    where allocation.tenant_id=public.current_tenant_id()
      and allocation.status='active'
      and allocation.valid_to is null
  ),'[]'::jsonb),
  'mappings',coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id',mapping.id,
      'kundexaUserId',mapping.kundexa_user_id,
      'userAllocationId',mapping.rinkel_user_allocation_id,
      'numberAllocationId',mapping.default_number_allocation_id,
      'selectedDeviceId',mapping.selected_device_id,
      'active',mapping.active
    ))
    from public.rinkel_user_mappings_v2 mapping
    where mapping.tenant_id=public.current_tenant_id() and mapping.active
  ),'[]'::jsonb),
  'callerIdDefaults',pg_catalog.jsonb_build_object(
    'tenantDefaultAllocationId',(
      select policy.default_number_allocation_id
      from public.telephony_policies policy
      where policy.tenant_id=public.current_tenant_id()
    ),
    'teams',coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id',team.id,'name',team.name,'numberAllocationId',team.rinkel_number_allocation_id
      ) order by team.name)
      from public.teams team where team.tenant_id=public.current_tenant_id()
    ),'[]'::jsonb),
    'lists',coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id',list.id,'name',list.name,'numberAllocationId',list.rinkel_number_allocation_id
      ) order by list.name)
      from public.customer_lists list
      where list.tenant_id=public.current_tenant_id() and list.archived_at is null
    ),'[]'::jsonb),
    'campaigns',coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id',campaign.id,'name',campaign.name,'numberAllocationId',campaign.rinkel_number_allocation_id
      ) order by campaign.name)
      from public.campaigns campaign
      where campaign.tenant_id=public.current_tenant_id()
        and campaign.status not in ('completed','archived')
    ),'[]'::jsonb)
  ),
  'capabilities',coalesce((
    select pg_catalog.jsonb_build_object(
      'recordingDetected',capability.recording_detected,
      'transcriptionSupported',capability.transcription_supported,
      'insightsSupported',capability.insights_supported,
      'noteSyncSupported',capability.note_sync_supported,
      'privateRecordingCopySupported',false
    )
    from public.platform_integrations integration
    join public.platform_rinkel_capabilities capability
      on capability.platform_integration_id=integration.id
    where integration.provider='rinkel' and integration.is_canonical
  ),'{}'::jsonb)
)
where public.current_tenant_id() is not null
  and public.is_tenant_member(public.current_tenant_id())
$$;
revoke all on function public.get_tenant_rinkel_resources() from public,anon;
grant execute on function public.get_tenant_rinkel_resources() to authenticated;
