begin;

-- En import återställs bara i det egna företaget.
--
-- `rollback_import_run` läste körningens status med tenantfilter men skrev den
-- utan (FAILURE-0105). För ett id i ett annat företag blev statusen NULL,
-- `NULL not in (…)` stoppade ingenting, och den avslutande UPDATE:n markerade
-- det andra företagets import som `rolled_back`. Nu nekas ett okänt id, och
-- skrivningen har samma tenantfilter som läsningen.
do $migration$
declare
  v_definition text;
  v_status_check constant text := $a$  if v_status not in ('completed','completed_with_warnings') then raise exception 'import_not_rollbackable'; end if;$a$;
  v_final_update constant text := $a$validation_report||jsonb_build_object('rollback_at',now(),'rollback_count',v_rolled,'rollback_skipped',v_skipped) where id=p_import_run_id;$a$;
begin
  select pg_get_functiondef('public.rollback_import_run(uuid)'::regprocedure) into v_definition;
  if position('rollback_stays_in_tenant' in v_definition) > 0 then return; end if;
  if position(v_status_check in v_definition) = 0 then raise exception 'rollback_import_run_status_anchor_missing'; end if;
  if position(v_final_update in v_definition) = 0 then raise exception 'rollback_import_run_update_anchor_missing'; end if;
  v_definition := replace(v_definition, v_status_check, $r$  -- rollback_stays_in_tenant
  if v_status is null then raise exception 'import_run_not_found'; end if;
$r$ || v_status_check);
  v_definition := replace(v_definition, v_final_update,
    $r$validation_report||jsonb_build_object('rollback_at',now(),'rollback_count',v_rolled,'rollback_skipped',v_skipped) where id=p_import_run_id and tenant_id=v_tenant;$r$);
  execute v_definition;
end
$migration$;

-- Resten av importens tabeller: användare läser, servern och RPC:erna skriver.
--
-- 202609240002 tog bort användarnas skrivrätt på körningar, rader och
-- ändringslogg. Samma `for all`-policy låg kvar på konflikter, mållistor och
-- ParseHub-körningar och -projekt, som bara skrivs av tjänsteklienten och
-- SECURITY DEFINER-funktionerna. En teamledare kunde alltså fortfarande ändra
-- en ParseHub-körning eller en konfliktrad direkt via PostgREST.
do $$
declare t text;
begin
  foreach t in array array['parsehub_projects','parsehub_runs','import_merge_conflicts','import_run_list_targets'] loop
    execute format('drop policy if exists %I_import_ops on public.%I', t, t);
    execute format('drop policy if exists %I_import_ops_select on public.%I', t, t);
    execute format('create policy %I_import_ops_select on public.%I for select to authenticated using (tenant_id=public.current_tenant_id() and public.has_current_role(array[''owner'',''admin'',''team_lead'',''backoffice'']))', t, t);
    execute format('revoke insert, update, delete on public.%I from authenticated, anon', t);
  end loop;
end $$;

commit;
