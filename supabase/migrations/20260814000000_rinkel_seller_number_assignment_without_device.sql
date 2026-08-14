begin;

-- Rinkel exposes no device catalog endpoint. A provider user's device id only
-- appears on the user object once the account has a registered webphone or desk
-- phone, so `deviceId: null` and an absent `devices[]` array are normal provider
-- states rather than a synchronization defect.
--
-- Requiring a synchronized active device before a telephony user could be
-- allocated to a company, and before a seller could be given an outgoing number,
-- made number assignment impossible for exactly those accounts. Device presence
-- now gates dialing only - which is where Rinkel actually requires it, because
-- `POST /dial` takes a deviceId. Assignment is an administrative act and stays
-- open; `telephony_status_for_current_user` and the reservation path keep failing
-- closed with an explicit device blocker until a device has been synchronized.

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
    -- A missing device no longer blocks allocation. The dial path still requires
    -- an active synchronized device, so an allocation without one is inert rather
    -- than unsafe.

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
    pg_catalog.jsonb_build_object(
      'allocation_id',v_id,
      'shared_across_tenants',true,
      'active_device_count',case when p_resource_type='user' then (
        select pg_catalog.count(*)::integer
        from public.platform_rinkel_devices device
        where device.platform_rinkel_user_id=p_resource_id and device.active
      ) else null end
    )
  );
  return v_id;
end
$$;
revoke all on function public.allocate_platform_rinkel_resource(text,uuid,uuid,text)
  from public,anon;
grant execute on function public.allocate_platform_rinkel_resource(text,uuid,uuid,text)
  to authenticated;

-- Seller mapping: the device argument becomes an optional, verified refinement.
--   explicit device  -> must be an active device of the mapped provider user
--   null + 1 device  -> that device is selected automatically
--   null + N devices -> DEVICE_SELECTION_REQUIRED, because guessing is not safe
--   null + 0 devices -> the mapping is stored without a device and the seller
--                       receives the number; dialing stays blocked until a
--                       device is synchronized.
create or replace function public.replace_rinkel_user_mapping_v3(
  p_kundexa_user_id uuid,
  p_rinkel_user_allocation_id uuid,
  p_default_number_allocation_id uuid,
  p_selected_device_id uuid
) returns uuid
language plpgsql
security definer
set search_path=''
as $$
declare
  v_tenant uuid:=public.current_tenant_id();
  v_actor uuid:=auth.uid();
  v_role text:=public.current_membership_role();
  v_provider_user_id uuid;
  v_active_device_count integer;
  v_selected_device_id uuid:=p_selected_device_id;
  v_mapping_id uuid;
  v_grant_id uuid;
begin
  if v_tenant is null or v_actor is null then
    raise exception 'AUTHENTICATION_REQUIRED';
  end if;
  if not public.is_tenant_admin(v_tenant) then
    raise exception 'RINKEL_MAPPING_TENANT_ADMIN_REQUIRED';
  end if;
  if not exists(
    select 1
    from public.tenant_memberships membership
    where membership.tenant_id=v_tenant
      and membership.user_id=p_kundexa_user_id
      and membership.status='active'
  ) then
    raise exception 'RINKEL_MAPPING_MEMBER_NOT_ACTIVE';
  end if;
  if v_role='team_lead' and not exists(
    select 1
    from public.team_members team_member
    where team_member.tenant_id=v_tenant
      and team_member.user_id=p_kundexa_user_id
      and public.can_manage_team(team_member.team_id)
  ) then
    raise exception 'RINKEL_MAPPING_TEAM_PERMISSION_REQUIRED';
  end if;

  select provider_user.id
  into v_provider_user_id
  from public.rinkel_user_allocations allocation
  join public.platform_rinkel_users provider_user
    on provider_user.id=allocation.rinkel_user_id
   and provider_user.active
  where allocation.id=p_rinkel_user_allocation_id
    and allocation.tenant_id=v_tenant
    and allocation.status='active'
    and allocation.valid_to is null;
  if v_provider_user_id is null then
    raise exception 'RINKEL_USER_ALLOCATION_MISSING';
  end if;

  select pg_catalog.count(*)::integer
  into v_active_device_count
  from public.platform_rinkel_devices device
  where device.platform_rinkel_user_id=v_provider_user_id
    and device.active;

  if v_selected_device_id is not null then
    if not exists(
      select 1
      from public.platform_rinkel_devices device
      where device.id=v_selected_device_id
        and device.platform_rinkel_user_id=v_provider_user_id
        and device.active
    ) then
      raise exception 'DEVICE_MISSING';
    end if;
  elsif v_active_device_count=1 then
    select device.id
    into v_selected_device_id
    from public.platform_rinkel_devices device
    where device.platform_rinkel_user_id=v_provider_user_id
      and device.active;
  elsif v_active_device_count>1 then
    raise exception 'DEVICE_SELECTION_REQUIRED';
  end if;

  if not exists(
    select 1
    from public.rinkel_number_allocations allocation
    join public.platform_rinkel_numbers provider_number
      on provider_number.id=allocation.rinkel_number_id
     and provider_number.active
    where allocation.id=p_default_number_allocation_id
      and allocation.tenant_id=v_tenant
      and allocation.status='active'
      and allocation.valid_to is null
  ) then
    raise exception 'NUMBER_ALLOCATION_MISSING';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_tenant::text||':rinkel-mapping:'||p_kundexa_user_id::text,0)
  );

  update public.rinkel_user_mappings_v2 mapping
  set active=false,
      updated_at=pg_catalog.now()
  where mapping.active
    and (
      (mapping.tenant_id=v_tenant and mapping.kundexa_user_id=p_kundexa_user_id)
      or mapping.rinkel_user_allocation_id=p_rinkel_user_allocation_id
    );

  -- Keep any other direct number access, but make exactly one direct grant the
  -- mapping default for this seller.
  update public.rinkel_number_grants grant_row
  set is_default=false,
      updated_at=pg_catalog.now()
  where grant_row.tenant_id=v_tenant
    and grant_row.user_id=p_kundexa_user_id
    and grant_row.team_id is null
    and grant_row.access_level in ('dial','manage')
    and grant_row.active
    and grant_row.is_default;

  select grant_row.id
  into v_grant_id
  from public.rinkel_number_grants grant_row
  where grant_row.tenant_id=v_tenant
    and grant_row.number_allocation_id=p_default_number_allocation_id
    and grant_row.user_id=p_kundexa_user_id
    and grant_row.team_id is null
    and grant_row.access_level='dial'
  order by grant_row.active desc,grant_row.created_at,grant_row.id
  limit 1
  for update;

  if v_grant_id is null then
    insert into public.rinkel_number_grants(
      tenant_id,number_allocation_id,team_id,user_id,
      access_level,is_default,active,created_by
    ) values(
      v_tenant,p_default_number_allocation_id,null,p_kundexa_user_id,
      'dial',true,true,v_actor
    ) returning id into v_grant_id;
  else
    update public.rinkel_number_grants grant_row
    set active=true,
        is_default=true,
        updated_at=pg_catalog.now()
    where grant_row.id=v_grant_id;
  end if;

  insert into public.rinkel_user_mappings_v2(
    tenant_id,kundexa_user_id,rinkel_user_allocation_id,
    default_number_allocation_id,selected_device_id,created_by
  ) values(
    v_tenant,p_kundexa_user_id,p_rinkel_user_allocation_id,
    p_default_number_allocation_id,v_selected_device_id,v_actor
  ) returning id into v_mapping_id;

  insert into public.audit_logs(
    tenant_id,actor_user_id,action,entity_type,entity_id,after_data
  ) values(
    v_tenant,v_actor,'rinkel.user_mapping_saved','rinkel_user_mapping',v_mapping_id::text,
    pg_catalog.jsonb_build_object(
      'kundexa_user_id',p_kundexa_user_id,
      'selected_device_id',v_selected_device_id,
      'requested_device_id',p_selected_device_id,
      'active_device_count',v_active_device_count,
      'dial_ready',v_selected_device_id is not null,
      'default_number_allocation_id',p_default_number_allocation_id,
      'direct_number_grant_id',v_grant_id
    )
  );
  return v_mapping_id;
end
$$;
revoke all on function public.replace_rinkel_user_mapping_v3(uuid,uuid,uuid,uuid) from public,anon;
grant execute on function public.replace_rinkel_user_mapping_v3(uuid,uuid,uuid,uuid) to authenticated;

commit;
