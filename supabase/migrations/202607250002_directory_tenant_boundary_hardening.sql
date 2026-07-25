begin;

-- Tenant-parameterized directory projections are server-only. Exposing these
-- SECURITY DEFINER functions to authenticated clients lets a caller substitute
-- another tenant_id and bypass that tenant's license projection.
revoke all on function public.directory_search_summary_for_tenant(uuid,jsonb) from public,anon,authenticated;
revoke all on function public.directory_search_v2_for_tenant(uuid,jsonb,integer,integer) from public,anon,authenticated;
revoke all on function public.directory_visible_fields_for_tenant(uuid,uuid) from public,anon,authenticated;
revoke all on function public.directory_entity_projection_for_tenant(uuid,uuid) from public,anon,authenticated;
revoke all on function public.directory_source_attribution_for_tenant(uuid,uuid) from public,anon,authenticated;
grant execute on function public.directory_search_summary_for_tenant(uuid,jsonb) to service_role;
grant execute on function public.directory_search_v2_for_tenant(uuid,jsonb,integer,integer) to service_role;
grant execute on function public.directory_visible_fields_for_tenant(uuid,uuid) to service_role;
grant execute on function public.directory_entity_projection_for_tenant(uuid,uuid) to service_role;
grant execute on function public.directory_source_attribution_for_tenant(uuid,uuid) to service_role;

-- Preserve the established implementation as an owner-only internal function,
-- then expose an active-tenant wrapper and a tenant-explicit service wrapper.
alter function public.refresh_segment_materialization(uuid,uuid)
  rename to refresh_segment_materialization_internal;
revoke all on function public.refresh_segment_materialization_internal(uuid,uuid)
  from public,anon,authenticated,service_role;

create function public.refresh_segment_materialization(
  p_segment_id uuid,
  p_actor uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_segment_tenant uuid;
  v_result jsonb;
begin
  -- Trusted owner calls from workers have no user claim. This signature is not
  -- executable directly by anon or service_role.
  if auth.uid() is null then
    return public.refresh_segment_materialization_internal(p_segment_id,p_actor);
  end if;
  select tenant_id into v_segment_tenant
  from public.segments
  where id=p_segment_id;
  if not found or v_segment_tenant is distinct from public.current_tenant_id() then
    raise exception 'segment_not_found';
  end if;
  if not public.has_current_role(array['owner','admin','team_lead','backoffice']) then
    raise exception 'segment_manage_permission_required';
  end if;
  if p_actor is not null and p_actor is distinct from auth.uid() then
    raise exception 'segment_actor_mismatch';
  end if;
  v_result:=public.refresh_segment_materialization_internal(p_segment_id,auth.uid());
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
  values(v_segment_tenant,auth.uid(),'segment.materialized','segment',p_segment_id::text,v_result);
  return v_result;
end $$;
revoke all on function public.refresh_segment_materialization(uuid,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.refresh_segment_materialization(uuid,uuid) to authenticated;

create function public.refresh_segment_materialization_for_tenant(
  p_tenant_id uuid,
  p_segment_id uuid,
  p_actor uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare v_result jsonb;
begin
  if p_tenant_id is null or not exists(
    select 1 from public.segments where id=p_segment_id and tenant_id=p_tenant_id
  ) then
    raise exception 'segment_not_found';
  end if;
  v_result:=public.refresh_segment_materialization_internal(p_segment_id,p_actor);
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
  values(p_tenant_id,p_actor,'segment.materialized','segment',p_segment_id::text,v_result);
  return v_result;
end $$;
revoke all on function public.refresh_segment_materialization_for_tenant(uuid,uuid,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.refresh_segment_materialization_for_tenant(uuid,uuid,uuid) to service_role;

alter function public.materialize_segment_to_campaign(uuid,uuid,uuid)
  rename to materialize_segment_to_campaign_internal;
revoke all on function public.materialize_segment_to_campaign_internal(uuid,uuid,uuid)
  from public,anon,authenticated,service_role;

create function public.materialize_segment_to_campaign(
  p_segment_id uuid,
  p_campaign_id uuid,
  p_actor uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_tenant uuid;
  v_result jsonb;
begin
  if auth.uid() is null then raise exception 'authenticated_user_required'; end if;
  select tenant_id into v_tenant
  from public.segments
  where id=p_segment_id and tenant_id=public.current_tenant_id();
  if not found or not exists(
    select 1 from public.campaigns where id=p_campaign_id and tenant_id=v_tenant
  ) then
    raise exception 'segment_or_campaign_not_found';
  end if;
  if not public.has_current_role(array['owner','admin','team_lead','backoffice']) then
    raise exception 'segment_manage_permission_required';
  end if;
  if p_actor is not null and p_actor is distinct from auth.uid() then
    raise exception 'segment_actor_mismatch';
  end if;
  v_result:=public.materialize_segment_to_campaign_internal(p_segment_id,p_campaign_id,auth.uid());
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
  values(v_tenant,auth.uid(),'segment.sent_to_campaign','campaign',p_campaign_id::text,
    jsonb_build_object('segment_id',p_segment_id,'result',v_result));
  return v_result;
end $$;
revoke all on function public.materialize_segment_to_campaign(uuid,uuid,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.materialize_segment_to_campaign(uuid,uuid,uuid) to authenticated;

create function public.materialize_segment_to_campaign_for_tenant(
  p_tenant_id uuid,
  p_segment_id uuid,
  p_campaign_id uuid,
  p_actor uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare v_result jsonb;
begin
  if p_tenant_id is null
    or not exists(select 1 from public.segments where id=p_segment_id and tenant_id=p_tenant_id)
    or not exists(select 1 from public.campaigns where id=p_campaign_id and tenant_id=p_tenant_id)
  then
    raise exception 'segment_or_campaign_not_found';
  end if;
  v_result:=public.materialize_segment_to_campaign_internal(p_segment_id,p_campaign_id,p_actor);
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
  values(p_tenant_id,p_actor,'segment.sent_to_campaign','campaign',p_campaign_id::text,
    jsonb_build_object('segment_id',p_segment_id,'result',v_result));
  return v_result;
end $$;
revoke all on function public.materialize_segment_to_campaign_for_tenant(uuid,uuid,uuid,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.materialize_segment_to_campaign_for_tenant(uuid,uuid,uuid,uuid) to service_role;

commit;
