begin;

create or replace function public.process_import_run(p_import_run_id uuid)
returns jsonb
language plpgsql security definer set search_path=public
as $$
declare
  v_tenant_id uuid;
  v_status public.import_status;
  v_name text;
  v_created_by uuid:=auth.uid();
  v_row record;
  v_data jsonb;
  v_existing_id uuid;
  v_new_id uuid;
  v_created_ids uuid[]:='{}'::uuid[];
  v_new integer:=0;
  v_duplicates integer:=0;
  v_blocked integer:=0;
  v_errors integer:=0;
begin
  select tenant_id,status,name into v_tenant_id,v_status,v_name
  from public.import_runs
  where id=p_import_run_id and tenant_id=public.current_tenant_id()
  for update;

  if v_tenant_id is null then raise exception 'import_run_not_found'; end if;
  if not public.has_current_role(array['owner','admin','team_lead','backoffice']) then raise exception 'permission_denied'; end if;
  if v_status<>'preview_ready' then raise exception 'import_run_not_ready'; end if;

  update public.import_runs set status='processing',simulation=false,started_at=now() where id=p_import_run_id;

  for v_row in
    select * from public.import_rows
    where tenant_id=v_tenant_id and import_run_id=p_import_run_id
    order by row_number
    for update
  loop
    if v_row.decision<>'ready' then
      if v_row.decision='error' then v_errors:=v_errors+1; end if;
      continue;
    end if;
    v_data:=coalesce(v_row.normalized_data,'{}'::jsonb);
    v_existing_id:=null;

    if exists(
      select 1 from public.compliance_blocks b
      where b.tenant_id=v_tenant_id and b.active
        and (b.expires_at is null or b.expires_at>now())
        and (
          (nullif(v_data->>'phone_e164','') is not null and b.phone_e164=v_data->>'phone_e164')
          or (nullif(v_data->>'email','') is not null and b.email=v_data->>'email')
        )
    ) then
      update public.import_rows set decision='blocked' where id=v_row.id;
      v_blocked:=v_blocked+1;
      continue;
    end if;

    select c.id into v_existing_id
    from public.customers c
    where c.tenant_id=v_tenant_id and c.deleted_at is null
      and (
        (nullif(v_data->>'organization_number','') is not null and c.organization_number=v_data->>'organization_number')
        or (nullif(v_data->>'phone_e164','') is not null and c.phone_e164=v_data->>'phone_e164')
        or (nullif(v_data->>'email','') is not null and c.email=v_data->>'email')
      )
    order by c.updated_at desc
    limit 1;

    if v_existing_id is not null then
      update public.import_rows set decision='duplicate',matched_customer_id=v_existing_id where id=v_row.id;
      v_duplicates:=v_duplicates+1;
      continue;
    end if;

    insert into public.customers(
      tenant_id,customer_type,lifecycle,display_name,email,phone_e164,organization_number,
      city,county,industry,sni_code,source_name,source_external_id,source_retrieved_at,created_by
    ) values (
      v_tenant_id,
      case when v_data->>'customer_type'='person' then 'person'::public.customer_type else 'company'::public.customer_type end,
      'prospect',
      nullif(v_data->>'display_name',''),
      nullif(v_data->>'email',''),
      nullif(v_data->>'phone_e164',''),
      nullif(v_data->>'organization_number',''),
      nullif(v_data->>'city',''),
      nullif(v_data->>'county',''),
      nullif(v_data->>'industry',''),
      nullif(v_data->>'sni_code',''),
      'csv:'||v_name,
      v_row.id::text,
      now(),
      v_created_by
    ) returning id into v_new_id;

    update public.import_rows set decision='inserted',matched_customer_id=v_new_id where id=v_row.id;
    v_created_ids:=array_append(v_created_ids,v_new_id);
    v_new:=v_new+1;
  end loop;

  update public.import_runs
  set status='completed',new_count=v_new,updated_count=0,duplicate_count=v_duplicates,
      blocked_count=v_blocked,error_count=v_errors,
      rollback_data=jsonb_build_object('created_customer_ids',to_jsonb(v_created_ids)),
      validation_report=validation_report||jsonb_build_object('processed_at',now(),'new',v_new,'duplicates',v_duplicates,'blocked',v_blocked,'errors',v_errors),
      completed_at=now()
  where id=p_import_run_id;

  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
  values(v_tenant_id,v_created_by,'import.completed','import_run',p_import_run_id,
    jsonb_build_object('new',v_new,'duplicates',v_duplicates,'blocked',v_blocked,'errors',v_errors));

  return jsonb_build_object('new',v_new,'duplicates',v_duplicates,'blocked',v_blocked,'errors',v_errors);
exception when others then
  if v_tenant_id is not null then
    update public.import_runs set status='failed',completed_at=now(),validation_report=validation_report||jsonb_build_object('execution_error',sqlerrm) where id=p_import_run_id;
  end if;
  raise;
end
$$;

create or replace function public.rollback_import_run(p_import_run_id uuid)
returns integer
language plpgsql security definer set search_path=public
as $$
declare
  v_tenant_id uuid;
  v_ids uuid[];
  v_count integer:=0;
begin
  select tenant_id,array(select jsonb_array_elements_text(coalesce(rollback_data->'created_customer_ids','[]'::jsonb))::uuid)
  into v_tenant_id,v_ids
  from public.import_runs
  where id=p_import_run_id and tenant_id=public.current_tenant_id() and status='completed'
  for update;
  if v_tenant_id is null then raise exception 'completed_import_not_found'; end if;
  if not public.has_current_role(array['owner','admin']) then raise exception 'permission_denied'; end if;

  update public.customers
  set deleted_at=now(),updated_at=now()
  where tenant_id=v_tenant_id and id=any(coalesce(v_ids,'{}'::uuid[]))
    and not exists(select 1 from public.contracts c where c.tenant_id=v_tenant_id and c.customer_id=customers.id and c.status not in ('draft','cancelled'));
  get diagnostics v_count=row_count;

  update public.import_runs set status='rolled_back',validation_report=validation_report||jsonb_build_object('rolled_back_at',now(),'customers_soft_deleted',v_count) where id=p_import_run_id;
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
  values(v_tenant_id,auth.uid(),'import.rolled_back','import_run',p_import_run_id,jsonb_build_object('customers_soft_deleted',v_count));
  return v_count;
end
$$;

revoke all on function public.process_import_run(uuid) from public,anon;
revoke all on function public.rollback_import_run(uuid) from public,anon;
grant execute on function public.process_import_run(uuid) to authenticated;
grant execute on function public.rollback_import_run(uuid) to authenticated;

commit;
