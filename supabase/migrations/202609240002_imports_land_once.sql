begin;

-- En import landar en gång, och bara där den ska.
--
-- Genomgången 2026-09-23 av `process_import_run` i produktion:
-- 1. En återimport skrev över ringläget: låsta, återkomster och nya försök blev
--    `pending` igen, så samma kund ringdes två gånger.
-- 2. Varje listplats loggades som "skapad", även när den bara uppdaterades. En
--    rollback raderade därför platser som fanns före importen.
-- 3. Felhanteraren satte `failed` och kastade sedan felet vidare, vilket rullade
--    tillbaka statusen. Körningen stod kvar som "bearbetas".
-- 4. De unika idempotensnycklarna gällde även misslyckade och återställda
--    körningar, så samma fil kunde aldrig importeras igen.
-- 5. Teamledare och backoffice hade full skrivrätt på importtabellerna och kunde
--    sätta `scan_status='clean'` på en oskannad fil. Skrivningarna går nu via
--    servern och RPC:erna; användare får läsa.
--
-- Matchningen ändras inte: en rad med org.nr prövas bara mot org.nr. Två bolag
-- kan dela växelnummer, och dubblettrapporten visar kollisionerna före commit.

do $migration$
declare
  v_definition text;
  v_declare constant text := $a$  v_row_decision text;
begin$a$;
  v_state constant text := $a$        state=case when public.customer_list_members.state in ('completed','dialing','after_call') then public.customer_list_members.state else excluded.state end,updated_at=now();
      if found then$a$;
  v_loop constant text := $a$  for v_row in select * from public.import_rows where tenant_id=v_tenant and import_run_id=p_import_run_id order by row_number for update loop$a$;
  v_handler constant text := $a$exception when others then
  if v_tenant is not null then
    update public.import_runs set status='failed',catalog_sync_status='failed',completed_at=now(),validation_report=validation_report||jsonb_build_object('execution_error',sqlerrm) where id=p_import_run_id;
  end if;
  raise;
end$a$;
begin
  select pg_get_functiondef('public.process_import_run(uuid)'::regprocedure) into v_definition;
  if position('imports_land_once' in v_definition) > 0 then return; end if;
  if position(v_declare in v_definition) = 0 then raise exception 'process_import_run_declare_anchor_missing'; end if;
  if position(v_state in v_definition) = 0 then raise exception 'process_import_run_state_anchor_missing'; end if;
  if position(v_loop in v_definition) = 0 then raise exception 'process_import_run_loop_anchor_missing'; end if;
  if position(v_handler in v_definition) = 0 then raise exception 'process_import_run_handler_anchor_missing'; end if;

  v_definition := replace(v_definition, v_declare, $r$  v_row_decision text;
  v_inserted boolean;
  v_processing boolean:=false; -- imports_land_once
begin$r$);

  -- 1 och 2. Ringläget lämnas i fred, och bara en ny plats loggas som skapad.
  v_definition := replace(v_definition, v_state, $r$        state=case when public.customer_list_members.state in ('pending','blocked') then excluded.state else public.customer_list_members.state end,updated_at=now()
      returning (xmax=0) into v_inserted;
      if v_inserted then$r$);

  v_definition := replace(v_definition, v_loop, $r$  v_processing:=true;
$r$ || v_loop);

  -- 3. Ett fel under bearbetningen sparas. Kroppens skrivningar rullas ändå
  -- tillbaka av undantagsblocket; bara statusraden blir kvar.
  v_definition := replace(v_definition, v_handler, $r$exception when others then
  if v_processing then
    update public.import_runs set status='failed',catalog_sync_status='failed',completed_at=now(),
      validation_report=coalesce(validation_report,'{}'::jsonb)||jsonb_build_object('execution_error',sqlerrm,'execution_error_state',sqlstate)
    where id=p_import_run_id;
    return jsonb_build_object('failed',true,'error',sqlerrm);
  end if;
  raise;
end$r$);

  execute v_definition;
end
$migration$;

-- ParseHub committar bara en felfri körning, som filimporten. Annars landade de
-- giltiga raderna och felraderna försvann ur sikte utan att någon såg dem.
do $migration$
declare
  v_definition text;
  v_anchor constant text := $a$  if not v_auto then return jsonb_build_object('automaticCommit',false); end if;$a$;
begin
  select pg_get_functiondef('public.process_parsehub_import_run(uuid)'::regprocedure) into v_definition;
  if position('rows_with_errors' in v_definition) > 0 then return; end if;
  if position(v_anchor in v_definition) = 0 then raise exception 'process_parsehub_import_run_anchor_missing'; end if;
  execute replace(v_definition, v_anchor, v_anchor || $r$
  if exists(select 1 from public.import_rows r where r.tenant_id=v_tenant and r.import_run_id=v_import_run and r.decision='error') then
    return jsonb_build_object('automaticCommit',false,'reason','rows_with_errors');
  end if;$r$);
end
$migration$;

-- 4. Samma fil får köras igen när den förra körningen misslyckades eller återställdes.
drop index if exists public.import_runs_idempotency_idx;
create unique index import_runs_idempotency_idx on public.import_runs(tenant_id, idempotency_key)
  where idempotency_key is not null and status not in ('failed','rolled_back','cancelled');
drop index if exists public.import_runs_execution_idempotency_uidx;
create unique index import_runs_execution_idempotency_uidx on public.import_runs(tenant_id, execution_idempotency_key)
  where execution_idempotency_key is not null and status not in ('failed','rolled_back','cancelled');

-- 5. Användare läser importerna; servern och RPC:erna skriver.
drop policy if exists import_runs_ops_all on public.import_runs;
drop policy if exists import_rows_ops_all on public.import_rows;
drop policy if exists import_change_sets_import_ops on public.import_change_sets;
drop policy if exists import_runs_ops_select on public.import_runs;
drop policy if exists import_rows_ops_select on public.import_rows;
drop policy if exists import_change_sets_ops_select on public.import_change_sets;
create policy import_runs_ops_select on public.import_runs for select to authenticated
  using (tenant_id = public.current_tenant_id() and public.has_current_role(array['owner','admin','team_lead','backoffice']));
create policy import_rows_ops_select on public.import_rows for select to authenticated
  using (tenant_id = public.current_tenant_id() and public.has_current_role(array['owner','admin','team_lead','backoffice']));
create policy import_change_sets_ops_select on public.import_change_sets for select to authenticated
  using (tenant_id = public.current_tenant_id() and public.has_current_role(array['owner','admin','team_lead','backoffice']));
revoke insert, update, delete on public.import_runs, public.import_rows, public.import_change_sets from authenticated, anon;

commit;
