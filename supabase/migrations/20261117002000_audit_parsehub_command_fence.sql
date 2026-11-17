begin;
create function public.parsehub_command(p_run_id uuid,p_worker text,p_attempt integer,p_token text,p_operation text,p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v public.parsehub_runs%rowtype; i public.import_runs%rowtype; r jsonb; n integer; bad integer; warnings integer; expected integer;
begin
 select * into v from public.parsehub_runs where id=p_run_id for update;
 if not found or v.status<>'processing' or v.locked_by is distinct from p_worker or v.attempts is distinct from p_attempt or p_token is null
   or v.metadata->>'execution_token' is distinct from p_token or v.locked_at is null or v.locked_at<now()-interval '15 minutes' then raise exception 'parsehub_lease_lost'; end if;
 update public.parsehub_runs set locked_at=now() where id=v.id;
 if v.import_run_id is not null then
   select * into i from public.import_runs where id=v.import_run_id and tenant_id=v.tenant_id for update;
   if not found then raise exception 'parsehub_import_scope_mismatch'; end if;
 end if;
 case p_operation
 when 'ping' then null;
 when 'bind_import' then
   select * into i from public.import_runs where id=(p_payload->>'id')::uuid and tenant_id=v.tenant_id and source_run_id=v.run_token_hash for update;
   if not found or (v.import_run_id is not null and v.import_run_id<>i.id) then raise exception 'parsehub_import_scope_mismatch'; end if;
   update public.parsehub_runs set import_run_id=i.id where id=v.id;
 when 'create_import' then
   if v.import_run_id is not null then raise exception 'parsehub_import_already_bound'; end if;
   if p_payload->>'source_run_id' is distinct from v.run_token_hash or (p_payload->>'import_profile_id')::uuid is distinct from v.import_profile_id then raise exception 'parsehub_import_scope_mismatch'; end if;
   insert into public.import_runs(tenant_id,name,source_type,source_file_path,status,uploaded_by,total_rows,simulation,file_mime_type,file_size_bytes,scan_status,scan_provider,scan_sha256,scan_completed_at,file_sha256,idempotency_key,import_profile_id,import_profile_version_id,profile_version,profile_snapshot,field_mapping,source_provider,source_website,source_project,source_run_id,source_retrieved_at,records_path,target_list_id,validation_report) select x.tenant_id,x.name,x.source_type,x.source_file_path,x.status,x.uploaded_by,x.total_rows,x.simulation,x.file_mime_type,x.file_size_bytes,x.scan_status,x.scan_provider,x.scan_sha256,x.scan_completed_at,x.file_sha256,x.idempotency_key,x.import_profile_id,x.import_profile_version_id,x.profile_version,x.profile_snapshot,x.field_mapping,x.source_provider,x.source_website,x.source_project,x.source_run_id,x.source_retrieved_at,x.records_path,x.target_list_id,x.validation_report from jsonb_populate_record(null::public.import_runs,p_payload||jsonb_build_object('tenant_id',v.tenant_id,'status','validating')) x returning * into i;
   update public.parsehub_runs set import_run_id=i.id where id=v.id;
   r:=jsonb_build_object('id',i.id);
 when 'clear_rows' then
   if i.id is null or i.status<>'validating' then raise exception 'parsehub_import_not_staging'; end if;
   delete from public.import_rows where import_run_id=i.id and tenant_id=v.tenant_id;
 when 'insert_rows' then
   if i.id is null or i.status<>'validating' or jsonb_typeof(p_payload->'rows')<>'array' or jsonb_array_length(p_payload->'rows')>500 then raise exception 'parsehub_import_not_staging'; end if;
   if exists(select 1 from jsonb_array_elements(p_payload->'rows') x where (x->>'tenant_id')::uuid is distinct from v.tenant_id or (x->>'import_run_id')::uuid is distinct from i.id) then raise exception 'parsehub_row_scope_mismatch'; end if;
   insert into public.import_rows(tenant_id,import_run_id,row_number,raw_data,normalized_data,decision,row_status,error_code,errors,warning_codes,source_external_id) select x.tenant_id,x.import_run_id,x.row_number,x.raw_data,x.normalized_data,x.decision,x.row_status,x.error_code,x.errors,x.warning_codes,x.source_external_id from jsonb_populate_recordset(null::public.import_rows,p_payload->'rows') x;
 when 'finalize_import' then
   if i.id is null or i.status<>'validating' then raise exception 'parsehub_import_not_staging'; end if;
   select count(*),count(*) filter(where row_status='invalid'),count(*) filter(where row_status='warning') into n,bad,warnings from public.import_rows where import_run_id=i.id and tenant_id=v.tenant_id;
   expected:=(p_payload->>'total_rows')::integer;
   if expected is null or n<>expected or n<>i.total_rows then raise exception 'parsehub_row_count_mismatch'; end if;
   update public.import_runs set status=(case when bad=n then 'mapping_required' else 'preview_ready' end)::public.import_status,error_count=bad,warning_count=warnings,validation_report=p_payload->'validation_report' where id=i.id;
 when 'link' then
   if i.id is null or i.id is distinct from (p_payload->>'import_run_id')::uuid then raise exception 'parsehub_import_scope_mismatch'; end if;
   update public.parsehub_runs set response_sha256=p_payload->>'response_sha256',response_size_bytes=(p_payload->>'response_size_bytes')::integer,source_retrieved_at=now() where id=v.id;
 when 'commit' then
   r:=public.process_parsehub_import_run(v.id);
 when 'complete' then
   if i.id is null or i.status not in ('completed','preview_ready','mapping_required','validated') then raise exception 'parsehub_import_not_ready'; end if;
   update public.parsehub_runs set status='completed',run_completed_at=now(),locked_at=null,locked_by=null,last_error_code=null,next_attempt_at=null where id=v.id;
 when 'fail' then
   update public.parsehub_runs set status=case when coalesce((p_payload->>'retryable')::boolean,false) and v.attempts<8 then 'queued' else 'failed' end,
     last_error_code=left(p_payload->>'error',200),next_attempt_at=case when coalesce((p_payload->>'retryable')::boolean,false) and v.attempts<8 then now()+make_interval(secs=>greatest(1,least(coalesce((p_payload->>'delay')::integer,60),3600))) else null end,locked_at=null,locked_by=null where id=v.id;
 else raise exception 'unsupported_parsehub_operation';
 end case;
 return coalesce(r,'{}'::jsonb);
end $$;
revoke all on function public.parsehub_command(uuid,text,integer,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.parsehub_command(uuid,text,integer,text,text,jsonb) to service_role;
revoke execute on function public.process_parsehub_import_run(uuid) from service_role;
create or replace function public.claim_parsehub_runs(p_worker text,p_limit integer default 5)
returns setof public.parsehub_runs language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if nullif(trim(p_worker),'') is null then raise exception 'worker_required'; end if;
 update public.parsehub_runs set status='failed',locked_at=null,locked_by=null,last_error_code='crash_attempt_budget_exhausted'
 where id in(select id from public.parsehub_runs where status='processing' and locked_at<now()-interval '15 minutes' and attempts>=8 order by locked_at limit 100 for update skip locked);
 return query with picked as (
  select id from public.parsehub_runs where run_token_ciphertext is not null and attempts<8 and
   ((status='queued' and (next_attempt_at is null or next_attempt_at<=now()) and (locked_at is null or locked_at<now()-interval '15 minutes')) or (status='processing' and locked_at<now()-interval '15 minutes'))
  order by created_at for update skip locked limit greatest(1,least(coalesce(p_limit,5),25))
 ) update public.parsehub_runs pr set status='processing',locked_at=now(),locked_by=left(p_worker,120),attempts=attempts+1,metadata=metadata||jsonb_build_object('execution_token',gen_random_uuid()) from picked where pr.id=picked.id returning pr.*;
end $$;
commit;
