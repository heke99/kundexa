begin;

-- FAILURE-0047 — automatic ParseHub commit derives its tenant from a UI selection.
--
-- `process_parsehub_import_run` impersonated the import profile's creator with
-- `set_config('request.jwt.claim.sub',...)` and nothing else, so `process_import_run`
-- resolved the tenant through `current_tenant_id()`'s fallback branch: the *profile*
-- row's `active_tenant_id`, i.e. whichever tenant that person last selected in the web
-- UI. For a user who belongs to more than one tenant, an automatic import for tenant A
-- fails with `import_run_not_found` whenever they happen to be looking at tenant B, and
-- it starts working again when they switch back — the run's own tenant never entered the
-- decision. If the creator has since left the tenant, automatic commit is dead for good.
--
-- The service execution context added for the contract API already solves this: set
-- `app.kundexa_tenant_id` to the resource's tenant, and `current_tenant_id()` accepts it
-- only while that actor still holds an active membership in an active tenant. Use the
-- same mechanism here, so the tenant comes from the import run and the actor is
-- cross-validated against it (AGENTS.md: authenticated flows derive tenant from active
-- membership; explicit tenant parameters are service-only and must be cross-validated).
--
-- The actor is also allowed to fall back. `process_import_run` requires one of
-- owner/admin/team_lead/backoffice, so a profile whose creator has left or been demoted
-- would otherwise strand every future run; an active owner or admin of the run's own
-- tenant commits it instead, and the audit trail records who it actually was.
create or replace function public.process_parsehub_import_run(p_parsehub_run_id uuid)
returns jsonb
language plpgsql security definer set search_path=public as $$
declare
  v_tenant uuid;
  v_import_run uuid;
  v_profile uuid;
  v_creator uuid;
  v_actor uuid;
  v_auto boolean;
  v_result jsonb;
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then raise exception 'service_role_required'; end if;

  select pr.tenant_id,pr.import_run_id,pr.import_profile_id,ip.created_by,ip.automatic_commit
  into v_tenant,v_import_run,v_profile,v_creator,v_auto
  from public.parsehub_runs pr
  join public.import_profiles ip on ip.tenant_id=pr.tenant_id and ip.id=pr.import_profile_id
  where pr.id=p_parsehub_run_id and pr.status='processing'
  for update of pr;
  if v_import_run is null or v_profile is null then raise exception 'parsehub_import_not_ready'; end if;
  if not v_auto then return jsonb_build_object('automaticCommit',false); end if;

  -- The profile creator commits when they still hold a committing role in this tenant.
  select m.user_id into v_actor
  from public.tenant_memberships m
  where m.tenant_id=v_tenant and m.user_id=v_creator and m.status='active'
    and m.role in ('owner','admin','team_lead','backoffice');

  -- Otherwise an active administrator of the run's own tenant does, deterministically.
  if v_actor is null then
    select m.user_id into v_actor
    from public.tenant_memberships m
    where m.tenant_id=v_tenant and m.status='active' and m.role in ('owner','admin')
    order by (m.role='owner') desc,m.joined_at,m.user_id
    limit 1;
  end if;
  if v_actor is null then raise exception 'parsehub_profile_actor_missing'; end if;

  perform set_config('request.jwt.claim.sub',v_actor::text,true);
  perform set_config('app.kundexa_tenant_id',v_tenant::text,true);
  if public.current_tenant_id() is distinct from v_tenant then raise exception 'tenant_context_rejected'; end if;

  v_result:=public.process_import_run(v_import_run);
  return coalesce(v_result,'{}'::jsonb)||jsonb_build_object(
    'automaticCommit',true,
    'committedBy',v_actor,
    'committedByProfileCreator',v_actor=v_creator
  );
end $$;
revoke all on function public.process_parsehub_import_run(uuid) from public,anon,authenticated;
grant execute on function public.process_parsehub_import_run(uuid) to service_role;

commit;
