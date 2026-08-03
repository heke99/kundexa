begin;

-- A central number may be made available in several companies. Within each
-- company the access is granted to one or more teams. The previous index made
-- an active number globally exclusive and therefore caused a later assignment
-- to revoke the earlier company assignment.
drop index if exists public.rinkel_number_allocations_one_active_uidx;

-- Remove duplicate active allocations before adding the tenant-scoped guard.
with ranked as (
  select id,
         row_number() over (
           partition by rinkel_number_id, tenant_id
           order by valid_from desc, created_at desc, id desc
         ) as position
  from public.rinkel_number_allocations
  where status = 'active' and valid_to is null
)
update public.rinkel_number_allocations allocation
set status = 'revoked',
    valid_to = now(),
    updated_at = now(),
    allocation_reason = concat_ws(' · ', allocation_reason, 'Automatiskt avduplicerad vid delad teamåtkomst')
from ranked
where ranked.id = allocation.id
  and ranked.position > 1;

create unique index if not exists rinkel_number_allocations_one_active_tenant_uidx
  on public.rinkel_number_allocations(rinkel_number_id, tenant_id)
  where status = 'active' and valid_to is null;

-- PostgreSQL treats NULL values as distinct in a regular UNIQUE constraint.
-- These partial indexes make active team-wide and company-wide grants truly
-- idempotent.
with ranked as (
  select id,
         row_number() over (
           partition by number_allocation_id, team_id, access_level
           order by is_default desc, created_at, id
         ) as position
  from public.rinkel_number_grants
  where active and team_id is not null and user_id is null
)
update public.rinkel_number_grants grant_row
set active = false,
    is_default = false,
    updated_at = now()
from ranked
where ranked.id = grant_row.id
  and ranked.position > 1;

with ranked as (
  select id,
         row_number() over (
           partition by number_allocation_id, access_level
           order by is_default desc, created_at, id
         ) as position
  from public.rinkel_number_grants
  where active and team_id is null and user_id is null
)
update public.rinkel_number_grants grant_row
set active = false,
    is_default = false,
    updated_at = now()
from ranked
where ranked.id = grant_row.id
  and ranked.position > 1;

create unique index if not exists rinkel_number_grants_active_team_access_uidx
  on public.rinkel_number_grants(number_allocation_id, team_id, access_level)
  where active and team_id is not null and user_id is null;

create unique index if not exists rinkel_number_grants_active_tenant_access_uidx
  on public.rinkel_number_grants(number_allocation_id, access_level)
  where active and team_id is null and user_id is null;

-- Keep the legacy resource allocator for user allocations and simple
-- company-wide number access, but make number allocation tenant-scoped and
-- idempotent instead of moving the number away from another company.
create or replace function public.allocate_platform_rinkel_resource(
  p_resource_type text,
  p_resource_id uuid,
  p_tenant_id uuid,
  p_reason text default null
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_id uuid;
  v_previous uuid;
begin
  if v_actor is null or not public.is_platform_role(array[
    'platform_owner'::public.platform_role,
    'platform_admin'::public.platform_role
  ]) then
    raise exception 'PLATFORM_ADMIN_REQUIRED';
  end if;

  if not exists (
    select 1 from public.tenants
    where id = p_tenant_id and status in ('trial', 'active')
  ) then
    raise exception 'TENANT_NOT_ACTIVE';
  end if;

  if p_resource_type = 'user' then
    if not exists (
      select 1 from public.platform_rinkel_users
      where id = p_resource_id and active
    ) then
      raise exception 'RINKEL_USER_INACTIVE';
    end if;

    perform pg_advisory_xact_lock(pg_catalog.hashtextextended('rinkel-user:' || p_resource_id::text, 0));
    select tenant_id into v_previous
    from public.rinkel_user_allocations
    where rinkel_user_id = p_resource_id and status = 'active' and valid_to is null
    for update;

    update public.rinkel_user_allocations
    set status = 'revoked', valid_to = now(), revoked_by = v_actor, updated_at = now()
    where rinkel_user_id = p_resource_id and status = 'active' and valid_to is null;

    update public.rinkel_user_mappings_v2 mapping
    set active = false, updated_at = now()
    where mapping.rinkel_user_allocation_id in (
      select id from public.rinkel_user_allocations
      where rinkel_user_id = p_resource_id and status = 'revoked'
    );

    insert into public.rinkel_user_allocations(
      rinkel_user_id, tenant_id, allocated_by, allocation_reason
    ) values (
      p_resource_id, p_tenant_id, v_actor, p_reason
    ) returning id into v_id;

  elsif p_resource_type = 'number' then
    if not exists (
      select 1 from public.platform_rinkel_numbers
      where id = p_resource_id and active
    ) then
      raise exception 'PHONE_NUMBER_INACTIVE';
    end if;

    perform pg_advisory_xact_lock(
      pg_catalog.hashtextextended('rinkel-number:' || p_resource_id::text || ':' || p_tenant_id::text, 0)
    );

    select id into v_id
    from public.rinkel_number_allocations
    where rinkel_number_id = p_resource_id
      and tenant_id = p_tenant_id
      and status = 'active'
      and valid_to is null
    for update;

    if v_id is null then
      insert into public.rinkel_number_allocations(
        rinkel_number_id, tenant_id, allocated_by, allocation_reason
      ) values (
        p_resource_id, p_tenant_id, v_actor, p_reason
      ) returning id into v_id;
    end if;

    insert into public.rinkel_number_grants(
      tenant_id, number_allocation_id, access_level, active, created_by
    ) values (
      p_tenant_id, v_id, 'dial', true, v_actor
    )
    on conflict (number_allocation_id, access_level)
      where active and team_id is null and user_id is null
    do update set updated_at = now();
  else
    raise exception 'INVALID_RINKEL_RESOURCE_TYPE';
  end if;

  insert into public.platform_audit_logs(
    actor_user_id, action, entity_type, entity_id, tenant_id, reason, metadata
  ) values (
    v_actor,
    'rinkel.resource_allocated',
    'rinkel_' || p_resource_type,
    p_resource_id::text,
    p_tenant_id,
    p_reason,
    pg_catalog.jsonb_build_object('allocation_id', v_id, 'previous_tenant_id', v_previous)
  );

  return v_id;
end
$$;

revoke all on function public.allocate_platform_rinkel_resource(text, uuid, uuid, text) from public, anon;
grant execute on function public.allocate_platform_rinkel_resource(text, uuid, uuid, text) to authenticated;

create or replace function public.assign_platform_rinkel_number_to_teams(
  p_number_id uuid,
  p_team_ids uuid[],
  p_reason text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_team record;
  v_allocation_id uuid;
  v_grant_id uuid;
  v_requested_count integer;
  v_valid_count integer;
  v_created_allocations integer := 0;
  v_created_grants integer := 0;
  v_reused_grants integer := 0;
begin
  if v_actor is null or not public.is_platform_role(array[
    'platform_owner'::public.platform_role,
    'platform_admin'::public.platform_role
  ]) then
    raise exception 'PLATFORM_ADMIN_REQUIRED';
  end if;

  if not exists (
    select 1 from public.platform_rinkel_numbers
    where id = p_number_id and active
  ) then
    raise exception 'PHONE_NUMBER_INACTIVE';
  end if;

  select pg_catalog.count(distinct selected_team_id)::integer
  into v_requested_count
  from pg_catalog.unnest(coalesce(p_team_ids, '{}'::uuid[])) as selected(selected_team_id);

  if v_requested_count = 0 then
    raise exception 'TEAM_SELECTION_REQUIRED';
  end if;

  select pg_catalog.count(*)::integer
  into v_valid_count
  from (
    select distinct teams.id
    from public.teams
    join public.tenants on tenants.id = teams.tenant_id
    where teams.id = any(p_team_ids)
      and teams.status = 'active'
      and tenants.status in ('trial', 'active')
  ) valid_teams;

  if v_valid_count <> v_requested_count then
    raise exception 'ACTIVE_TEAM_SELECTION_INVALID';
  end if;

  for v_team in
    select distinct teams.id, teams.tenant_id, teams.name
    from public.teams
    join public.tenants on tenants.id = teams.tenant_id
    where teams.id = any(p_team_ids)
      and teams.status = 'active'
      and tenants.status in ('trial', 'active')
    order by teams.tenant_id, teams.id
  loop
    perform pg_advisory_xact_lock(
      pg_catalog.hashtextextended('rinkel-number:' || p_number_id::text || ':' || v_team.tenant_id::text, 0)
    );

    select id into v_allocation_id
    from public.rinkel_number_allocations
    where rinkel_number_id = p_number_id
      and tenant_id = v_team.tenant_id
      and status = 'active'
      and valid_to is null
    for update;

    if v_allocation_id is null then
      insert into public.rinkel_number_allocations(
        rinkel_number_id, tenant_id, allocated_by, allocation_reason
      ) values (
        p_number_id, v_team.tenant_id, v_actor, p_reason
      ) returning id into v_allocation_id;
      v_created_allocations := v_created_allocations + 1;
    end if;

    -- Explicit team assignment must not leave an old company-wide grant that
    -- would silently give every user in the company access.
    update public.rinkel_number_grants
    set active = false, is_default = false, updated_at = now()
    where number_allocation_id = v_allocation_id
      and active
      and team_id is null
      and user_id is null
      and access_level = 'dial';

    select id into v_grant_id
    from public.rinkel_number_grants
    where number_allocation_id = v_allocation_id
      and team_id = v_team.id
      and user_id is null
      and access_level = 'dial'
      and active
    for update;

    if v_grant_id is null then
      insert into public.rinkel_number_grants(
        tenant_id, number_allocation_id, team_id, user_id,
        access_level, is_default, active, created_by
      ) values (
        v_team.tenant_id, v_allocation_id, v_team.id, null,
        'dial', true, true, v_actor
      ) returning id into v_grant_id;
      v_created_grants := v_created_grants + 1;
    else
      update public.rinkel_number_grants
      set is_default = true, updated_at = now()
      where id = v_grant_id;
      v_reused_grants := v_reused_grants + 1;
    end if;

    update public.rinkel_number_grants
    set is_default = false, updated_at = now()
    where tenant_id = v_team.tenant_id
      and team_id = v_team.id
      and user_id is null
      and access_level = 'dial'
      and active
      and id <> v_grant_id;

    update public.teams
    set rinkel_number_allocation_id = v_allocation_id,
        updated_at = now()
    where id = v_team.id and tenant_id = v_team.tenant_id;

    insert into public.platform_audit_logs(
      actor_user_id, action, entity_type, entity_id, tenant_id, reason, metadata
    ) values (
      v_actor,
      'rinkel.number_team_granted',
      'rinkel_number_grant',
      v_grant_id::text,
      v_team.tenant_id,
      p_reason,
      pg_catalog.jsonb_build_object(
        'number_id', p_number_id,
        'team_id', v_team.id,
        'team_name', v_team.name,
        'allocation_id', v_allocation_id
      )
    );
  end loop;

  return pg_catalog.jsonb_build_object(
    'selected_team_count', v_requested_count,
    'created_allocation_count', v_created_allocations,
    'created_grant_count', v_created_grants,
    'reused_grant_count', v_reused_grants
  );
end
$$;

revoke all on function public.assign_platform_rinkel_number_to_teams(uuid, uuid[], text) from public, anon;
grant execute on function public.assign_platform_rinkel_number_to_teams(uuid, uuid[], text) to authenticated;

create or replace function public.revoke_platform_rinkel_number_team_grant(
  p_grant_id uuid,
  p_reason text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_grant record;
  v_fallback_allocation_id uuid;
begin
  if v_actor is null or not public.is_platform_role(array[
    'platform_owner'::public.platform_role,
    'platform_admin'::public.platform_role
  ]) then
    raise exception 'PLATFORM_ADMIN_REQUIRED';
  end if;

  select grants.id,
         grants.tenant_id,
         grants.team_id,
         grants.number_allocation_id,
         allocations.rinkel_number_id
  into v_grant
  from public.rinkel_number_grants grants
  join public.rinkel_number_allocations allocations
    on allocations.id = grants.number_allocation_id
  where grants.id = p_grant_id
    and grants.active
    and grants.team_id is not null
    and grants.user_id is null
    and grants.access_level = 'dial'
  for update of grants;

  if v_grant.id is null then
    raise exception 'ACTIVE_TEAM_NUMBER_GRANT_NOT_FOUND';
  end if;

  update public.rinkel_number_grants
  set active = false, is_default = false, updated_at = now()
  where id = v_grant.id;

  if exists (
    select 1 from public.teams
    where id = v_grant.team_id
      and tenant_id = v_grant.tenant_id
      and rinkel_number_allocation_id = v_grant.number_allocation_id
  ) then
    select grants.number_allocation_id
    into v_fallback_allocation_id
    from public.rinkel_number_grants grants
    join public.rinkel_number_allocations allocations
      on allocations.id = grants.number_allocation_id
     and allocations.tenant_id = v_grant.tenant_id
     and allocations.status = 'active'
     and allocations.valid_to is null
    join public.platform_rinkel_numbers numbers
      on numbers.id = allocations.rinkel_number_id
     and numbers.active
    where grants.tenant_id = v_grant.tenant_id
      and grants.team_id = v_grant.team_id
      and grants.user_id is null
      and grants.access_level = 'dial'
      and grants.active
    order by grants.is_default desc, grants.created_at, grants.id
    limit 1;

    update public.teams
    set rinkel_number_allocation_id = v_fallback_allocation_id,
        updated_at = now()
    where id = v_grant.team_id and tenant_id = v_grant.tenant_id;

    if v_fallback_allocation_id is not null then
      update public.rinkel_number_grants
      set is_default = (number_allocation_id = v_fallback_allocation_id),
          updated_at = now()
      where tenant_id = v_grant.tenant_id
        and team_id = v_grant.team_id
        and user_id is null
        and access_level = 'dial'
        and active;
    end if;
  end if;

  insert into public.platform_audit_logs(
    actor_user_id, action, entity_type, entity_id, tenant_id, reason, metadata
  ) values (
    v_actor,
    'rinkel.number_team_grant_revoked',
    'rinkel_number_grant',
    v_grant.id::text,
    v_grant.tenant_id,
    p_reason,
    pg_catalog.jsonb_build_object(
      'number_id', v_grant.rinkel_number_id,
      'team_id', v_grant.team_id,
      'allocation_id', v_grant.number_allocation_id,
      'fallback_allocation_id', v_fallback_allocation_id
    )
  );

  return pg_catalog.jsonb_build_object(
    'revoked_grant_id', v_grant.id,
    'team_id', v_grant.team_id,
    'fallback_allocation_id', v_fallback_allocation_id
  );
end
$$;

revoke all on function public.revoke_platform_rinkel_number_team_grant(uuid, text) from public, anon;
grant execute on function public.revoke_platform_rinkel_number_team_grant(uuid, text) to authenticated;

commit;
