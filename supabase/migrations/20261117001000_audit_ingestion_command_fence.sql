begin;
create function public.ingestion_command(p_run_id uuid,p_worker text,p_attempt integer,p_token text,p_operation text,p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v public.ingestion_runs%rowtype; r jsonb; raw_id uuid;
begin
 select * into v from public.ingestion_runs where id=p_run_id for update;
 if not found or v.status<>'running' or v.locked_by is distinct from p_worker or v.attempts is distinct from p_attempt
   or p_token is null or v.metadata->>'execution_token' is distinct from p_token or v.locked_at is null or v.locked_at<now()-interval '15 minutes' then raise exception 'ingestion_lease_lost'; end if;
 update public.ingestion_runs set locked_at=now() where id=v.id;
 case p_operation
 when 'reserve_provider_ingestion_usage' then
   r:=public.reserve_provider_ingestion_usage(v.id,coalesce((p_payload->>'p_units')::integer,1));
 when 'record_ingestion_raw_payload' then
   raw_id:=public.record_ingestion_raw_payload(v.id,p_payload->>'p_external_identifier',p_payload->>'p_content_type',(p_payload->>'p_http_status')::integer,p_payload->>'p_request_id',p_payload->'p_response_headers',(p_payload->>'p_source_timestamp')::timestamptz,p_payload->>'p_payload_sha256',p_payload->>'p_payload_ciphertext',p_payload->>'p_storage_path',p_payload->'p_metadata');
   r:=to_jsonb(raw_id);
 when 'complete_ingestion_record' then
   r:=public.complete_ingestion_record(v.id,(p_payload->>'p_raw_payload_id')::uuid,p_payload->>'p_external_identifier',p_payload->'p_facts',p_payload->'p_canonical',p_payload->>'p_page_fingerprint',(p_payload->>'p_source_timestamp')::timestamptz);
   if r->>'masterEntityId' is not null then perform public.normalize_master_entity_geography((r->>'masterEntityId')::uuid); end if;
 when 'raw_status' then
   update public.raw_payloads set parse_status='failed',parse_error=left(p_payload->>'error',4000)
   where id=(p_payload->>'id')::uuid and ingestion_run_id=v.id and tenant_id=v.tenant_id;
   if not found then raise exception 'ingestion_raw_scope_mismatch'; end if;
 when 'checkpoint' then
   update public.crawl_checkpoints set last_page=p_payload->>'page',last_successful_step='page_completed',remaining_capacity=greatest(0,(p_payload->>'remaining')::integer),updated_at=now()
   where ingestion_run_id=v.id and tenant_id=v.tenant_id and crawl_plan_id is null;
   update public.ingestion_runs set current_page=p_payload->>'page',next_page=p_payload->>'next',parser_fingerprint=p_payload->>'fingerprint' where id=v.id;
 when 'complete_ingestion_run' then
   perform public.complete_ingestion_run(v.id,p_payload->>'p_next_page',p_payload->'p_metadata');
 when 'fail_ingestion_run' then
   perform public.fail_ingestion_run(v.id,p_payload->>'p_error',coalesce((p_payload->>'p_retryable')::boolean,false),coalesce((p_payload->>'p_delay_seconds')::integer,60),(p_payload->>'p_raw_payload_id')::uuid,p_payload->'p_details');
 else raise exception 'unsupported_ingestion_operation';
 end case;
 return coalesce(r,'{}'::jsonb);
end $$;
revoke all on function public.ingestion_command(uuid,text,integer,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.ingestion_command(uuid,text,integer,text,text,jsonb) to service_role;
-- Old RPC signatures cannot bless an unfenced worker after a rolling upgrade.
revoke execute on function public.record_ingestion_raw_payload(uuid,text,text,integer,text,jsonb,timestamptz,text,text,text,jsonb),public.complete_ingestion_record(uuid,uuid,text,jsonb,jsonb,text,timestamptz),public.complete_ingestion_run(uuid,text,jsonb),public.fail_ingestion_run(uuid,text,boolean,integer,uuid,jsonb),public.reserve_provider_ingestion_usage(uuid,integer) from service_role;
create or replace function public.claim_ingestion_runs(p_worker text,p_limit integer default 5)
returns setof public.ingestion_runs language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if nullif(trim(p_worker),'') is null then raise exception 'worker_required'; end if;
 update public.ingestion_runs set status='failed',completed_at=now(),locked_at=null,locked_by=null,last_error='crash_attempt_budget_exhausted'
 where id in(select id from public.ingestion_runs where status='running' and locked_at<now()-interval '15 minutes' and attempts>=max_attempts order by locked_at limit 100 for update skip locked);
 return query with picked as (
  select id from public.ingestion_runs where completed_at is null and attempts<max_attempts and
    ((status in ('scheduled','failed') and next_attempt_at<=now() and (locked_at is null or locked_at<now()-interval '15 minutes')) or (status='running' and locked_at<now()-interval '15 minutes'))
  order by created_at limit greatest(1,least(coalesce(p_limit,5),25)) for update skip locked
 ) update public.ingestion_runs ir set status='running',locked_at=now(),locked_by=left(p_worker,200),attempts=attempts+1,started_at=coalesce(started_at,now()),metadata=metadata||jsonb_build_object('execution_token',gen_random_uuid()) from picked where ir.id=picked.id returning ir.*;
end $$;
commit;
