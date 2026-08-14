-- Service-only boundaries and definer bypass hardening.
--
-- Two SECURITY DEFINER entity-merge functions could be invoked by any
-- authenticated caller with an explicit tenant id, so the tenant argument is now
-- cross-validated against real admin membership (service_role stays exempt as the
-- trusted server identity). The remaining internal helpers -- geographic derivation,
-- retention checks, entity rebuild, quality recalculation and source priority --
-- are pipeline internals, not tenant-facing RPCs, and are restricted to service_role.
--
-- The trailing `alter function ... set search_path` statements close definer
-- search_path injection on the small utility/trigger functions that were created
-- before the project made an explicit search_path mandatory.

create or replace function public.merge_master_entities(p_tenant_id uuid, p_target uuid, p_source uuid, p_actor uuid)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare d uuid; snap jsonb;
begin
  if p_target=p_source then raise exception 'merge_entities_must_differ'; end if;
  if auth.role() is distinct from 'service_role' and not public.is_tenant_admin(p_tenant_id) then raise exception 'admin_required'; end if;
  if not exists(select 1 from public.directory_entity_for_tenant(p_tenant_id,p_target)) or not exists(select 1 from public.directory_entity_for_tenant(p_tenant_id,p_source)) then raise exception 'entity_not_accessible'; end if;
  select jsonb_build_object('sourceLinks',coalesce(jsonb_agg(esl.source_entity_id),'[]'::jsonb),'identityKeys',coalesce((select jsonb_agg(id) from public.identity_keys where tenant_id=p_tenant_id and master_entity_id=p_source),'[]'::jsonb)) into snap from public.entity_source_links esl where esl.master_entity_id=p_source;
  insert into public.merge_decisions(tenant_id,target_entity_id,source_entity_id,decision,snapshot,decided_by) values(p_tenant_id,p_target,p_source,'merged',coalesce(snap,'{}'),p_actor) returning id into d;
  insert into public.entity_source_links(master_entity_id,source_entity_id,match_method,confidence,manually_verified) select p_target,source_entity_id,'manual_merge',confidence,true from public.entity_source_links where master_entity_id=p_source on conflict do nothing;
  delete from public.entity_source_links where master_entity_id=p_source;
  update public.identity_keys set master_entity_id=p_target,updated_at=now() where tenant_id=p_tenant_id and master_entity_id=p_source and not exists(select 1 from public.identity_keys x where x.tenant_id=p_tenant_id and x.master_entity_id=p_target and x.key_type=public.identity_keys.key_type and x.normalized_value=public.identity_keys.normalized_value);
  update public.master_entities set merged_into_id=p_target,merged_at=now(),updated_at=now() where id=p_source;
  update public.duplicate_candidates set status='merged',reviewed_by=p_actor,reviewed_at=now() where tenant_id=p_tenant_id and ((left_entity_id=p_target and right_entity_id=p_source) or (left_entity_id=p_source and right_entity_id=p_target));
  perform public.rebuild_master_entity(p_target); return d;
end $function$;

create or replace function public.undo_master_entity_merge(p_decision_id uuid, p_actor uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare d public.merge_decisions%rowtype; sid text;
begin
 select * into d from public.merge_decisions where id=p_decision_id and decision='merged' and undone_at is null for update; if not found then raise exception 'merge_decision_not_found'; end if;
 if auth.role() is distinct from 'service_role' and not public.is_tenant_admin(d.tenant_id) then raise exception 'admin_required'; end if;
 for sid in select jsonb_array_elements_text(coalesce(d.snapshot->'sourceLinks','[]'::jsonb)) loop
   insert into public.entity_source_links(master_entity_id,source_entity_id,match_method,confidence,manually_verified) values(d.source_entity_id,sid::uuid,'merge_undo',1,true) on conflict do nothing;
   delete from public.entity_source_links where master_entity_id=d.target_entity_id and source_entity_id=sid::uuid;
 end loop;
 update public.master_entities set merged_into_id=null,merged_at=null,updated_at=now() where id=d.source_entity_id;
 update public.merge_decisions set undone_by=p_actor,undone_at=now(),decision='undone' where id=d.id;
end $function$;

revoke all on function public.merge_master_entities(p_tenant_id uuid, p_target uuid, p_source uuid, p_actor uuid) from public,anon;
grant execute on function public.merge_master_entities(p_tenant_id uuid, p_target uuid, p_source uuid, p_actor uuid) to authenticated;
grant execute on function public.merge_master_entities(p_tenant_id uuid, p_target uuid, p_source uuid, p_actor uuid) to service_role;

revoke all on function public.undo_master_entity_merge(p_decision_id uuid, p_actor uuid) from public,anon,authenticated;
grant execute on function public.undo_master_entity_merge(p_decision_id uuid, p_actor uuid) to service_role;
revoke all on function public.apply_geographic_derived_value(p_entity_id uuid, p_source_entity_id uuid, p_permission_id uuid, p_field_key text, p_value jsonb, p_confidence numeric) from public,anon,authenticated;
grant execute on function public.apply_geographic_derived_value(p_entity_id uuid, p_source_entity_id uuid, p_permission_id uuid, p_field_key text, p_value jsonb, p_confidence numeric) to service_role;
revoke all on function public.customer_has_legal_retention(p_tenant_id uuid, p_customer_id uuid) from public,anon,authenticated;
grant execute on function public.customer_has_legal_retention(p_tenant_id uuid, p_customer_id uuid) to service_role;
revoke all on function public.rebuild_master_entity(p_entity_id uuid) from public,anon,authenticated;
grant execute on function public.rebuild_master_entity(p_entity_id uuid) to service_role;
revoke all on function public.recalculate_data_quality(p_entity_id uuid) from public,anon,authenticated;
grant execute on function public.recalculate_data_quality(p_entity_id uuid) to service_role;
revoke all on function public.source_priority_for(p_tenant uuid, p_field text, p_source_class text) from public,anon,authenticated;
grant execute on function public.source_priority_for(p_tenant uuid, p_field text, p_source_class text) to service_role;

alter function public.delivery_status_rank(p_status text) set search_path = public, pg_temp;
alter function public.haversine_km(p_lat1 numeric, p_lon1 numeric, p_lat2 numeric, p_lon2 numeric) set search_path = public, pg_temp;
alter function public.normalize_geo_token(p_value text) set search_path = public, pg_temp;
alter function public.normalize_identity_value(p_type text, p_value text) set search_path = public, pg_temp;
alter function public.prevent_locked_contract_version_update() set search_path = public, pg_temp;
alter function public.prevent_tenant_move() set search_path = public, pg_temp;
alter function public.safe_uuid(p_value text) set search_path = public, pg_temp;
alter function public.touch_updated_at() set search_path = public, pg_temp;
