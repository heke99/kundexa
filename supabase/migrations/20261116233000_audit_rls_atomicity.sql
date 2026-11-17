begin;
-- Remove permissive predecessors; role-scoped policies remain authoritative.
drop policy if exists teams_member_select on public.teams;
drop policy if exists team_members_member_select on public.team_members;

create or replace function private.audit_customer_update_atomic()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if old is distinct from new then
    insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
    values(new.tenant_id,auth.uid(),'customer.updated_atomic','customer',new.id::text,
      jsonb_build_object('fields',(select coalesce(jsonb_agg(n.key),'[]'::jsonb) from jsonb_each(to_jsonb(new)) n where n.value is distinct from to_jsonb(old)->n.key)));
  end if;
  return new;
end $$;
revoke all on function private.audit_customer_update_atomic() from public,anon,authenticated;
create trigger customer_update_atomic_audit after update on public.customers
for each row execute function private.audit_customer_update_atomic();
create or replace function public.apply_import_row_normalization(p_import_run_id uuid,p_rows jsonb)
returns integer language plpgsql security definer set search_path=public as $$
declare v_tenant uuid:=public.current_tenant_id(); v_user uuid:=auth.uid(); v_count integer:=0;
begin
  if v_tenant is null or v_user is null then raise exception 'authentication_required'; end if;
  if not public.has_current_role(array['owner','admin','team_lead','backoffice']) then raise exception 'import_manage_permission_required'; end if;
  if not exists(select 1 from public.import_runs where tenant_id=v_tenant and id=p_import_run_id) then raise exception 'import_run_not_found'; end if;
  perform 1 from public.import_runs where id=p_import_run_id and tenant_id=v_tenant and status in ('mapping_required','preview_ready','validated','failed','validating') for update;
  if not found then raise exception 'import_not_remappable'; end if;
  if exists(select 1 from public.import_runs where id=p_import_run_id and status='validating'
    and validation_report->>'normalization_token' is distinct from p_rows->0->>'normalization_token') then raise exception 'normalization_attempt_lost'; end if;
  if jsonb_typeof(coalesce(p_rows,'[]'::jsonb))<>'array' or jsonb_array_length(coalesce(p_rows,'[]'::jsonb))>500 then raise exception 'invalid_import_row_batch'; end if;

  with incoming as (
    select * from jsonb_to_recordset(coalesce(p_rows,'[]'::jsonb)) as x(
      id bigint, normalized_data jsonb, decision text, row_status text, error_code text, errors jsonb, warning_codes jsonb, source_external_id text
    )
  ), changed as (
    update public.import_rows r set
      normalized_data=coalesce(i.normalized_data,'{}'::jsonb),
      decision=i.decision, row_status=i.row_status, error_code=i.error_code,
      errors=coalesce(i.errors,'[]'::jsonb), warning_codes=coalesce(i.warning_codes,'[]'::jsonb),
      source_external_id=i.source_external_id, processing_ms=null
    from incoming i
    where r.tenant_id=v_tenant and r.import_run_id=p_import_run_id and r.id=i.id
    returning r.id
  ) select count(*) into v_count from changed;
  return v_count;
end $$;
commit;
