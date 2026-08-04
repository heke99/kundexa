-- Make central Rinkel users reusable across tenant contexts and make number-to-team
-- assignment activate every deterministically matchable seller, not only the number grant.

-- A platform user/device may be used by the same human in more than one tenant.
-- Keep one active allocation per provider user and tenant instead of moving the
-- provider user away from the previous tenant.
with ranked as (
  select id,
    row_number() over (
      partition by rinkel_user_id,tenant_id
      order by valid_from,created_at,id
    ) as position
  from public.rinkel_user_allocations
  where status='active' and valid_to is null
)
update public.rinkel_user_allocations allocation
set status='revoked',valid_to=now(),updated_at=now()
from ranked
where ranked.id=allocation.id and ranked.position>1;

drop index if exists public.rinkel_user_allocations_one_active_uidx;
create unique index if not exists rinkel_user_allocations_one_active_tenant_uidx
  on public.rinkel_user_allocations(rinkel_user_id,tenant_id)
  where status='active' and valid_to is null;

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
    do update set updated_at=now();
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
  from public,anon,authenticated;
grant execute on function public.allocate_platform_rinkel_resource(text,uuid,uuid,text)
  to authenticated;

create or replace function public.assign_platform_rinkel_number_to_teams(
  p_number_id uuid,
  p_team_ids uuid[],
  p_reason text default null
) returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_actor uuid:=auth.uid();
  v_team record;
  v_member record;
  v_allocation_id uuid;
  v_grant_id uuid;
  v_mapping_id uuid;
  v_mapping_device_id uuid;
  v_mapping_rinkel_user_id uuid;
  v_provider_user_id uuid;
  v_user_allocation_id uuid;
  v_device_id uuid;
  v_provider_user_count integer;
  v_device_count integer;
  v_requested_count integer;
  v_valid_count integer;
  v_created_allocations integer:=0;
  v_created_grants integer:=0;
  v_reused_grants integer:=0;
  v_member_count integer:=0;
  v_ready_member_count integer:=0;
  v_auto_mapped_count integer:=0;
  v_repaired_device_count integer:=0;
  v_unmatched_member_count integer:=0;
  v_ambiguous_member_count integer:=0;
  v_seen_member_keys text[]:='{}'::text[];
  v_member_key text;
begin
  if v_actor is null or not public.is_platform_role(array[
    'platform_owner'::public.platform_role,
    'platform_admin'::public.platform_role
  ]) then
    raise exception 'PLATFORM_ADMIN_REQUIRED';
  end if;
  if not exists(
    select 1 from public.platform_rinkel_numbers
    where id=p_number_id and active
  ) then
    raise exception 'PHONE_NUMBER_INACTIVE';
  end if;

  select pg_catalog.count(distinct selected_team_id)::integer
  into v_requested_count
  from pg_catalog.unnest(coalesce(p_team_ids,'{}'::uuid[])) selected(selected_team_id);
  if v_requested_count=0 then raise exception 'TEAM_SELECTION_REQUIRED'; end if;

  select pg_catalog.count(*)::integer into v_valid_count
  from (
    select distinct team.id
    from public.teams team
    join public.tenants tenant on tenant.id=team.tenant_id
    where team.id=any(p_team_ids)
      and team.status='active'
      and tenant.status in ('trial','active')
  ) valid;
  if v_valid_count<>v_requested_count then raise exception 'ACTIVE_TEAM_SELECTION_INVALID'; end if;

  for v_team in
    select distinct team.id,team.tenant_id,team.name
    from public.teams team
    join public.tenants tenant on tenant.id=team.tenant_id
    where team.id=any(p_team_ids)
      and team.status='active'
      and tenant.status in ('trial','active')
    order by team.tenant_id,team.id
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('rinkel-number:'||p_number_id::text||':'||v_team.tenant_id::text,0)
    );
    select id into v_allocation_id
    from public.rinkel_number_allocations
    where rinkel_number_id=p_number_id
      and tenant_id=v_team.tenant_id
      and status='active'
      and valid_to is null
    for update;
    if v_allocation_id is null then
      insert into public.rinkel_number_allocations(
        rinkel_number_id,tenant_id,allocated_by,allocation_reason
      ) values(p_number_id,v_team.tenant_id,v_actor,p_reason)
      returning id into v_allocation_id;
      v_created_allocations:=v_created_allocations+1;
    end if;

    update public.rinkel_number_grants
    set active=false,is_default=false,updated_at=now()
    where number_allocation_id=v_allocation_id
      and active and team_id is null and user_id is null and access_level='dial';

    select id into v_grant_id
    from public.rinkel_number_grants
    where number_allocation_id=v_allocation_id
      and team_id=v_team.id
      and user_id is null
      and access_level='dial'
      and active
    for update;
    if v_grant_id is null then
      insert into public.rinkel_number_grants(
        tenant_id,number_allocation_id,team_id,user_id,
        access_level,is_default,active,created_by
      ) values(
        v_team.tenant_id,v_allocation_id,v_team.id,null,
        'dial',true,true,v_actor
      ) returning id into v_grant_id;
      v_created_grants:=v_created_grants+1;
    else
      update public.rinkel_number_grants
      set is_default=true,updated_at=now()
      where id=v_grant_id;
      v_reused_grants:=v_reused_grants+1;
    end if;

    update public.rinkel_number_grants
    set is_default=false,updated_at=now()
    where tenant_id=v_team.tenant_id
      and team_id=v_team.id
      and user_id is null
      and access_level='dial'
      and active
      and id<>v_grant_id;

    update public.teams
    set rinkel_number_allocation_id=v_allocation_id,updated_at=now()
    where id=v_team.id and tenant_id=v_team.tenant_id;

    for v_member in
      select membership.user_id,auth_user.email
      from public.team_members team_member
      join public.tenant_memberships membership
        on membership.tenant_id=team_member.tenant_id
       and membership.user_id=team_member.user_id
       and membership.status='active'
      left join auth.users auth_user on auth_user.id=membership.user_id
      where team_member.tenant_id=v_team.tenant_id
        and team_member.team_id=v_team.id
    loop
      v_member_key:=v_team.tenant_id::text||':'||v_member.user_id::text;
      if v_member_key=any(v_seen_member_keys) then continue; end if;
      v_seen_member_keys:=pg_catalog.array_append(v_seen_member_keys,v_member_key);
      v_member_count:=v_member_count+1;

      v_mapping_id:=null;
      v_mapping_device_id:=null;
      v_mapping_rinkel_user_id:=null;
      select m.id,m.selected_device_id,ua.rinkel_user_id
      into v_mapping_id,v_mapping_device_id,v_mapping_rinkel_user_id
      from public.rinkel_user_mappings_v2 m
      join public.rinkel_user_allocations ua
        on ua.id=m.rinkel_user_allocation_id
       and ua.tenant_id=v_team.tenant_id
       and ua.status='active'
       and ua.valid_to is null
      where m.tenant_id=v_team.tenant_id
        and m.kundexa_user_id=v_member.user_id
        and m.active
      limit 1;

      if v_mapping_id is not null then
        if exists(
          select 1 from public.platform_rinkel_devices device
          where device.id=v_mapping_device_id
            and device.platform_rinkel_user_id=v_mapping_rinkel_user_id
            and device.active
        ) then
          v_ready_member_count:=v_ready_member_count+1;
          continue;
        end if;

        select pg_catalog.count(*)::integer
        into v_device_count
        from public.platform_rinkel_devices device
        where device.platform_rinkel_user_id=v_mapping_rinkel_user_id
          and device.active;
        select device.id into v_device_id
        from public.platform_rinkel_devices device
        where device.platform_rinkel_user_id=v_mapping_rinkel_user_id
          and device.active
        order by device.id
        limit 1;
        if v_device_count=1 then
          update public.rinkel_user_mappings_v2
          set selected_device_id=v_device_id,updated_at=now()
          where id=v_mapping_id;
          v_repaired_device_count:=v_repaired_device_count+1;
          v_ready_member_count:=v_ready_member_count+1;
        else
          v_ambiguous_member_count:=v_ambiguous_member_count+1;
        end if;
        continue;
      end if;

      if v_member.email is null or pg_catalog.btrim(v_member.email)='' then
        v_unmatched_member_count:=v_unmatched_member_count+1;
        continue;
      end if;

      select pg_catalog.count(*)::integer
      into v_provider_user_count
      from public.platform_rinkel_users provider_user
      where provider_user.active
        and provider_user.email is not null
        and pg_catalog.lower(provider_user.email)=pg_catalog.lower(v_member.email);
      select provider_user.id into v_provider_user_id
      from public.platform_rinkel_users provider_user
      where provider_user.active
        and provider_user.email is not null
        and pg_catalog.lower(provider_user.email)=pg_catalog.lower(v_member.email)
      order by provider_user.id
      limit 1;
      if v_provider_user_count<>1 then
        if v_provider_user_count=0 then
          v_unmatched_member_count:=v_unmatched_member_count+1;
        else
          v_ambiguous_member_count:=v_ambiguous_member_count+1;
        end if;
        continue;
      end if;

      select pg_catalog.count(*)::integer
      into v_device_count
      from public.platform_rinkel_devices device
      where device.platform_rinkel_user_id=v_provider_user_id
        and device.active;
      select device.id into v_device_id
      from public.platform_rinkel_devices device
      where device.platform_rinkel_user_id=v_provider_user_id
        and device.active
      order by device.id
      limit 1;
      if v_device_count<>1 then
        v_ambiguous_member_count:=v_ambiguous_member_count+1;
        continue;
      end if;

      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('rinkel-user:'||v_provider_user_id::text||':'||v_team.tenant_id::text,0)
      );
      select id into v_user_allocation_id
      from public.rinkel_user_allocations
      where rinkel_user_id=v_provider_user_id
        and tenant_id=v_team.tenant_id
        and status='active'
        and valid_to is null
      for update;
      if v_user_allocation_id is null then
        insert into public.rinkel_user_allocations(
          rinkel_user_id,tenant_id,allocated_by,allocation_reason
        ) values(
          v_provider_user_id,v_team.tenant_id,v_actor,
          coalesce(p_reason,'Automatiskt aktiverad via teamets telefonnummer')
        ) returning id into v_user_allocation_id;
      end if;

      if exists(
        select 1 from public.rinkel_user_mappings_v2 mapping
        where mapping.rinkel_user_allocation_id=v_user_allocation_id
          and mapping.active
      ) then
        v_ambiguous_member_count:=v_ambiguous_member_count+1;
        continue;
      end if;

      insert into public.rinkel_user_mappings_v2(
        tenant_id,kundexa_user_id,rinkel_user_allocation_id,
        default_number_allocation_id,selected_device_id,created_by
      ) values(
        v_team.tenant_id,v_member.user_id,v_user_allocation_id,
        v_allocation_id,v_device_id,v_actor
      );
      v_auto_mapped_count:=v_auto_mapped_count+1;
      v_ready_member_count:=v_ready_member_count+1;
    end loop;

    insert into public.platform_audit_logs(
      actor_user_id,action,entity_type,entity_id,tenant_id,reason,metadata
    ) values(
      v_actor,'rinkel.number_team_granted','rinkel_number_grant',v_grant_id::text,
      v_team.tenant_id,p_reason,
      pg_catalog.jsonb_build_object(
        'number_id',p_number_id,'team_id',v_team.id,'team_name',v_team.name,
        'allocation_id',v_allocation_id
      )
    );
  end loop;

  return pg_catalog.jsonb_build_object(
    'selected_team_count',v_requested_count,
    'created_allocation_count',v_created_allocations,
    'created_grant_count',v_created_grants,
    'reused_grant_count',v_reused_grants,
    'member_count',v_member_count,
    'ready_member_count',v_ready_member_count,
    'auto_mapped_member_count',v_auto_mapped_count,
    'repaired_device_count',v_repaired_device_count,
    'unmatched_member_count',v_unmatched_member_count,
    'ambiguous_member_count',v_ambiguous_member_count
  );
end
$$;
revoke all on function public.assign_platform_rinkel_number_to_teams(uuid,uuid[],text)
  from public,anon,authenticated;
grant execute on function public.assign_platform_rinkel_number_to_teams(uuid,uuid[],text)
  to authenticated;
