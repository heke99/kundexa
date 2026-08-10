begin;

-- Restrict sensitive operational ledgers to roles that actually need the data.
drop policy if exists email_delivery_events_member_read on public.email_delivery_events;
create policy email_delivery_events_privileged_read on public.email_delivery_events for select to authenticated
using (
  tenant_id=public.current_tenant_id()
  and public.has_current_role(array['owner','admin','contract_manager','backoffice'])
  and exists(
    select 1 from public.email_messages m
    where m.tenant_id=email_delivery_events.tenant_id and m.id=email_delivery_events.email_message_id
      and (m.contract_id is null or public.can_access_contract(m.contract_id))
  )
);

-- Canonical-data internals contain identity keys, raw parser quality signals and GDPR/retention evidence.
-- Ordinary sellers/team leads consume directory/customer projections instead of these internal ledgers.
do $$
declare t text;
begin
  foreach t in array array['identity_keys','merge_decisions','parser_observations','retention_runs','data_subject_requests'] loop
    execute format('drop policy if exists %I_member_select on public.%I',t,t);
    execute format('drop policy if exists %I_admin_write on public.%I',t,t);
    execute format(
      'create policy %I_privileged_select on public.%I for select to authenticated using (tenant_id=public.current_tenant_id() and public.has_current_role(array[''owner'',''admin'',''backoffice'']))',
      t,t
    );
    execute format(
      'create policy %I_privileged_write on public.%I for all to authenticated using (tenant_id=public.current_tenant_id() and public.has_current_role(array[''owner'',''admin'',''backoffice''])) with check (tenant_id=public.current_tenant_id() and public.has_current_role(array[''owner'',''admin'',''backoffice'']))',
      t,t
    );
  end loop;
end $$;

-- Rinkel allocation inventory is not a tenant-wide seller directory. A seller sees
-- only granted numbers; tenant-wide provider allocations remain administrative.
drop policy if exists rinkel_number_allocations_tenant_read on public.rinkel_number_allocations;
create policy rinkel_number_allocations_scoped_read on public.rinkel_number_allocations for select to authenticated
using(
  tenant_id=public.current_tenant_id()
  and (
    public.is_tenant_admin(tenant_id)
    or exists(
      select 1 from public.rinkel_number_grants g
      where g.tenant_id=rinkel_number_allocations.tenant_id
        and g.number_allocation_id=rinkel_number_allocations.id
        and g.active and g.access_level in ('dial','manage')
        and (
          g.user_id=auth.uid()
          or g.team_id in (
            select tm.team_id from public.team_members tm
            where tm.tenant_id=rinkel_number_allocations.tenant_id and tm.user_id=auth.uid()
              and not tm.assignment_paused and public.can_operate_in_team(tm.team_id,auth.uid())
          )
        )
    )
  )
);

drop policy if exists rinkel_number_grants_tenant_read on public.rinkel_number_grants;
create policy rinkel_number_grants_scoped_read on public.rinkel_number_grants for select to authenticated
using(
  tenant_id=public.current_tenant_id()
  and (
    public.is_tenant_admin(tenant_id)
    or user_id=auth.uid()
    or team_id in (
      select tm.team_id from public.team_members tm
      where tm.tenant_id=rinkel_number_grants.tenant_id and tm.user_id=auth.uid()
        and not tm.assignment_paused and public.can_operate_in_team(tm.team_id,auth.uid())
    )
  )
);

-- Broad provider inventory is explicitly an admin projection.
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
  and public.is_tenant_admin(public.current_tenant_id())
$$;
revoke all on function public.get_tenant_rinkel_resources() from public,anon;
grant execute on function public.get_tenant_rinkel_resources() to authenticated;


-- Seller projection: only the caller IDs that are effective for the current actor.
-- Tenant-wide grants are intentionally included because they are explicit grants
-- to every active tenant member; team grants require an operational team assignment.
create or replace function public.get_current_user_rinkel_numbers()
returns jsonb
language sql
stable
security definer
set search_path=public
as $$
with accessible as (
  select distinct on (a.id)
    a.id allocation_id,
    n.id number_id,
    n.external_number_id,
    n.phone_number_e164,
    n.display_name,
    n.recording_enabled,
    g.id grant_id,
    case when g.user_id=auth.uid() then 'user' when g.team_id is not null then 'team' else 'tenant' end access_source,
    (g.is_default or a.id=m.default_number_allocation_id or a.id=p.default_number_allocation_id) is_default
  from public.rinkel_number_allocations a
  join public.platform_rinkel_numbers n on n.id=a.rinkel_number_id and n.active
  join public.rinkel_number_grants g
    on g.tenant_id=a.tenant_id
   and g.number_allocation_id=a.id
   and g.active
   and g.access_level in ('dial','manage')
  left join public.rinkel_user_mappings_v2 m
    on m.tenant_id=a.tenant_id
   and m.kundexa_user_id=auth.uid()
   and m.active
  left join public.telephony_policies p on p.tenant_id=a.tenant_id
  where a.tenant_id=public.current_tenant_id()
    and a.status='active'
    and a.valid_to is null
    and public.is_tenant_member(a.tenant_id)
    and (
      g.user_id=auth.uid()
      or (g.user_id is null and g.team_id is null)
      or g.team_id in (
        select tm.team_id
        from public.team_members tm
        where tm.tenant_id=a.tenant_id
          and tm.user_id=auth.uid()
          and not tm.assignment_paused
          and public.can_operate_in_team(tm.team_id,auth.uid())
      )
    )
  order by a.id,
    case when g.user_id=auth.uid() then 1 when g.team_id is not null then 2 else 3 end,
    g.is_default desc,g.created_at,g.id
)
select coalesce(jsonb_agg(jsonb_build_object(
  'allocationId',allocation_id,
  'numberId',number_id,
  'providerNumberId',external_number_id,
  'number',phone_number_e164,
  'displayName',display_name,
  'recordingEnabled',recording_enabled,
  'isDefault',is_default,
  'accessSource',access_source,
  'grantId',grant_id
) order by is_default desc,phone_number_e164,allocation_id),'[]'::jsonb)
from accessible
$$;

-- Team-lead projection contains only teams the actor actually manages and
-- members whose tenant membership is currently active.
create or replace function public.get_managed_team_rinkel_resources()
returns jsonb
language sql
stable
security definer
set search_path=public
as $$
select coalesce(jsonb_agg(jsonb_build_object(
  'teamId',t.id,
  'teamName',t.name,
  'numberAllocationId',t.rinkel_number_allocation_id,
  'members',coalesce((
    select jsonb_agg(jsonb_build_object(
      'userId',tm.user_id,
      'teamRole',tm.role,
      'assignmentPaused',tm.assignment_paused,
      'hasActiveMapping',exists(
        select 1 from public.rinkel_user_mappings_v2 m
        where m.tenant_id=t.tenant_id and m.kundexa_user_id=tm.user_id and m.active
      )
    ) order by tm.created_at)
    from public.team_members tm
    join public.tenant_memberships membership
      on membership.tenant_id=tm.tenant_id
     and membership.user_id=tm.user_id
     and membership.status='active'
    where tm.tenant_id=t.tenant_id and tm.team_id=t.id
  ),'[]'::jsonb)
) order by t.name),'[]'::jsonb)
from public.teams t
where t.tenant_id=public.current_tenant_id()
  and t.status='active'
  and public.can_manage_team(t.id)
$$;

-- Storage authorization mirrors the product recording permission and object scope.
drop policy if exists recordings_privileged_scoped_read on storage.objects;
create policy recordings_privileged_scoped_read on storage.objects for select to authenticated using (
  bucket_id='call-recordings'
  and (storage.foldername(name))[1]=public.current_tenant_id()::text
  and public.has_current_role(array['owner','admin','team_lead','sales','quality'])
  and public.can_access_call(public.safe_uuid((storage.foldername(name))[2]))
);

revoke all on function public.get_current_user_rinkel_numbers() from public,anon;
grant execute on function public.get_current_user_rinkel_numbers() to authenticated;
revoke all on function public.get_managed_team_rinkel_resources() from public,anon;
grant execute on function public.get_managed_team_rinkel_resources() to authenticated;

commit;
