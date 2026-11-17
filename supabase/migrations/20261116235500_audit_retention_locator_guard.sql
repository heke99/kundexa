begin;
create or replace function public.run_retention_maintenance(p_tenant_id uuid,p_limit integer default 1000)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare rid uuid; raw_deleted integer:=0; recordings_queued integer:=0; pending_raw_files integer:=0; anonymized integer:=0; policy public.retention_policies%rowtype; c record;
begin
 insert into public.retention_runs(tenant_id) values(p_tenant_id) returning id into rid;
 with doomed as (select id from public.raw_payloads where tenant_id=p_tenant_id and retention_until is not null and retention_until<=now() and storage_path is null order by retention_until limit greatest(1,least(p_limit,10000)))
 update public.raw_payloads rp set payload_ciphertext=null,storage_path=null,metadata=metadata||jsonb_build_object('retentionPurgedAt',now()),parse_error=null from doomed where rp.id=doomed.id;
 get diagnostics raw_deleted=row_count;
 -- Physical recordings are deleted by telephony.retention, with Storage/provider acknowledgement and holds.
 -- Never erase the only locator here. Populate its legacy due date for that existing durable worker.
 update public.call_recordings set retention_delete_at=retention_until
 where tenant_id=p_tenant_id and retention_until<=now() and retention_until is not null
   and (retention_delete_at is null or retention_delete_at>retention_until) and deleted_at is null;
 get diagnostics recordings_queued=row_count;
 select count(*) into pending_raw_files from public.raw_payloads
 where tenant_id=p_tenant_id and retention_until<=now() and storage_path is not null;
 select * into policy from public.retention_policies where tenant_id=p_tenant_id and active and data_category='prospect_personal_data' and action in ('anonymize','delete') order by updated_at desc limit 1;
 if found then
   for c in select cu.id from public.customers cu where cu.tenant_id=p_tenant_id and cu.deleted_at is null and cu.lifecycle in ('prospect','lost','former_customer')
     and cu.updated_at<now()-make_interval(days=>policy.retention_days) and not public.customer_has_legal_retention(p_tenant_id,cu.id)
     order by cu.updated_at limit greatest(1,least(p_limit,10000))
   loop perform public.anonymize_customer_record(p_tenant_id,c.id,'retention_policy:'||policy.id::text,null); anonymized:=anonymized+1; end loop;
 end if;
 update public.retention_runs set status=case when pending_raw_files>0 then 'failed' else 'completed' end,last_error=case when pending_raw_files>0 then 'physical_raw_file_cleanup_required' else null end,deleted_count=raw_deleted,anonymized_count=anonymized,completed_at=now(),details=jsonb_build_object('rawPayloadsPurged',raw_deleted,'recordingsPurged',0,'recordingsQueuedForDeletion',recordings_queued,'pendingRawFiles',pending_raw_files,'customersAnonymized',anonymized) where id=rid;
 return jsonb_build_object('status',case when pending_raw_files>0 then 'failed' else 'completed' end,'runId',rid,'rawPayloadsPurged',raw_deleted,'recordingsPurged',0,'recordingsQueuedForDeletion',recordings_queued,'pendingRawFiles',pending_raw_files,'customersAnonymized',anonymized);
exception when others then update public.retention_runs set status='failed',last_error=sqlerrm,completed_at=now() where id=rid; raise;
end $$;
commit;
