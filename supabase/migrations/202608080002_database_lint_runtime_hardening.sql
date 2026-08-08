begin;

-- Supabase installs pgcrypto in the extensions schema on hosted projects, while
-- local replay environments may expose it through public. Keep a fixed
-- SECURITY DEFINER search_path but allow either installation layout.
alter function public.complete_ingestion_record(uuid,uuid,text,jsonb,jsonb,text,timestamptz)
  set search_path = public, extensions;
alter function public.apply_geographic_derived_value(uuid,uuid,uuid,text,jsonb,numeric)
  set search_path = public, extensions;
alter function public.normalize_due_geographies(integer)
  set search_path = public, extensions;
alter function public.anonymize_customer_record(uuid,uuid,text,uuid)
  set search_path = public, extensions;
alter function public.normalize_master_entity_geography(uuid)
  set search_path = public, extensions;
alter function public.save_import_profile(uuid,text,text,text,text,text,integer,text,text,uuid,boolean,jsonb,jsonb)
  set search_path = public, extensions;
alter function public.register_external_manual_call(uuid,text,public.communication_direction,timestamptz,timestamptz,text,text,text)
  set search_path = public, extensions;
alter function public.rinkel_reserve_outbound_call(uuid,uuid,text,uuid,uuid,uuid,uuid,text,text)
  set search_path = public, extensions;
alter function public.rinkel_reserve_platform_outbound_call_v2(uuid,uuid,text,uuid,uuid,uuid,uuid,text,text,uuid)
  set search_path = public, extensions;

-- CASE expressions in VALUES are resolved as text unless the enum branches are
-- explicit. Hosted plpgsql_check correctly identifies this as a runtime type
-- error even though the migration itself can be created successfully.
create or replace function public.fail_enrichment_job(
  p_job_id uuid,
  p_stage text,
  p_error text,
  p_retryable boolean default true,
  p_delay_seconds integer default 60,
  p_details jsonb default '{}'::jsonb
)
returns void
language plpgsql security definer set search_path=public
as $$
declare
  v_job public.enrichment_jobs%rowtype;
  v_terminal boolean;
begin
  select * into v_job from public.enrichment_jobs where id=p_job_id for update;
  if not found then raise exception 'enrichment_job_not_found'; end if;
  v_terminal := not p_retryable or v_job.attempts>=v_job.max_attempts;
  update public.enrichment_jobs set
    status=case when v_terminal then 'failed'::public.enrichment_state else 'queued'::public.enrichment_state end,
    next_attempt_at=case when v_terminal then next_attempt_at else now()+make_interval(secs=>greatest(1,p_delay_seconds)) end,
    completed_at=case when v_terminal then now() else null end,locked_at=null,locked_by=null,last_error=left(p_error,4000)
  where id=p_job_id;
  insert into public.enrichment_errors(tenant_id,enrichment_job_id,stage,message,retryable,details)
    values(v_job.tenant_id,p_job_id,coalesce(nullif(p_stage,''),'worker'),left(p_error,4000),p_retryable,coalesce(p_details,'{}'::jsonb));
  delete from public.refresh_locks where enrichment_job_id=p_job_id;
  insert into public.entity_freshness(master_entity_id,state,last_error,updated_at)
    values(
      v_job.master_entity_id,
      case
        when v_terminal then 'stale'::public.directory_freshness_state
        else 'refreshing'::public.directory_freshness_state
      end,
      left(p_error,4000),
      now()
    )
  on conflict(master_entity_id) do update set
    state=excluded.state,last_error=excluded.last_error,updated_at=now();
end
$$;

-- import_rows.id is a bigint identity. The old jsonb record declaration used
-- uuid, which made r.id=i.id invalid on hosted Postgres.
create or replace function public.apply_import_row_normalization(p_import_run_id uuid,p_rows jsonb)
returns integer language plpgsql security definer set search_path=public as $$
declare v_tenant uuid:=public.current_tenant_id(); v_user uuid:=auth.uid(); v_count integer:=0;
begin
  if v_tenant is null or v_user is null then raise exception 'authentication_required'; end if;
  if not public.has_current_role(array['owner','admin','team_lead']) then raise exception 'import_manage_permission_required'; end if;
  if not exists(select 1 from public.import_runs where tenant_id=v_tenant and id=p_import_run_id) then raise exception 'import_run_not_found'; end if;
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
