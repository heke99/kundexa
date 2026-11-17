begin;
insert into storage.buckets(id,name,public) values('raw-payloads','raw-payloads',false) on conflict(id) do nothing;
do $$begin if exists(select 1 from storage.buckets where id='raw-payloads' and public) then raise exception 'raw_payload_bucket_must_be_private';end if;end$$;
create table private.raw_file_deletions (
 job_id uuid primary key,tenant_id uuid not null,raw_payload_id uuid not null,
 storage_path text,bucket text not null check(bucket='raw-payloads'),
 state text not null check(state in ('prepared','completed')),prepared_at timestamptz not null default now(),completed_at timestamptz
);
alter table private.raw_file_deletions enable row level security;
revoke all on private.raw_file_deletions from public,anon,authenticated,service_role;
create function public.queue_raw_payload_file_deletions(p_tenant_id uuid,p_limit integer default 100)
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare r record; n integer:=0;
begin
 for r in select * from public.raw_payloads where tenant_id=p_tenant_id and retention_until<=now() and storage_path is not null
   and metadata->>'storage_bucket'='raw-payloads' and starts_with(storage_path,p_tenant_id::text||'/') and storage_path not like '%..%'
   order by retention_until limit greatest(1,least(coalesce(p_limit,100),1000)) for update skip locked
 loop
  insert into public.outbox_jobs(tenant_id,job_type,aggregate_type,aggregate_id,payload,idempotency_key)
  values(p_tenant_id,'storage.raw_payload_delete','raw_payload',r.id,jsonb_build_object('raw_payload_id',r.id),'raw-payload-delete:'||r.id::text)
  on conflict(tenant_id,idempotency_key) do nothing;
  n:=n+1;
 end loop;
 return n;
end $$;
create function public.raw_payload_deletion_command(p_job_id uuid,p_worker text,p_attempt integer,p_operation text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare j public.outbox_jobs%rowtype; r public.raw_payloads%rowtype; d private.raw_file_deletions%rowtype;
begin
 select * into j from public.outbox_jobs where id=p_job_id and job_type='storage.raw_payload_delete' and status='processing'
   and locked_by=p_worker and attempts=p_attempt and locked_at>=now()-interval '5 minutes' for update;
 if not found then raise exception 'outbox_lease_lost'; end if;
 perform pg_advisory_xact_lock(hashtextextended(j.tenant_id::text,0));
 select * into r from public.raw_payloads where tenant_id=j.tenant_id and id=j.aggregate_id for update;
 if not found then raise exception 'raw_payload_not_found'; end if;
 select * into d from private.raw_file_deletions where job_id=j.id for update;
 if d.state='completed' then return jsonb_build_object('completed',true); end if;
 if r.retention_until is null or r.retention_until>now() then raise exception 'raw_payload_retention_not_due'; end if;
 if exists(select 1 from public.legal_holds where tenant_id=j.tenant_id and active and (ends_at is null or ends_at>now())) then raise exception 'raw_payload_legal_hold'; end if;
 if p_operation='prepare' then
   if not exists(select 1 from storage.buckets where id='raw-payloads' and not public) then raise exception 'raw_payload_bucket_must_be_private';end if;
   if r.storage_path is null or r.metadata->>'storage_bucket' is distinct from 'raw-payloads' or not starts_with(r.storage_path,j.tenant_id::text||'/') or r.storage_path like '%..%' then raise exception 'raw_payload_storage_contract_required'; end if;
   if d.job_id is not null and d.storage_path is distinct from r.storage_path then raise exception 'raw_payload_locator_changed'; end if;
   insert into private.raw_file_deletions(job_id,tenant_id,raw_payload_id,storage_path,bucket,state)
   values(j.id,j.tenant_id,r.id,r.storage_path,'raw-payloads','prepared') on conflict(job_id) do nothing;
   return jsonb_build_object('bucket','raw-payloads','path',r.storage_path);
 elsif p_operation='acknowledge' then
   if d.state is distinct from 'prepared' or d.storage_path is distinct from r.storage_path then raise exception 'raw_payload_deletion_not_prepared'; end if;
   update public.raw_payloads set storage_path=null,payload_ciphertext=null,parse_error=null,metadata=metadata||jsonb_build_object('retentionPurgedAt',now(),'physicalDeletionConfirmedAt',now()) where id=r.id;
   update private.raw_file_deletions set state='completed',storage_path=null,completed_at=now() where job_id=j.id;
   insert into public.audit_logs(tenant_id,action,entity_type,entity_id,after_data) values(j.tenant_id,'raw_payload.physical_deleted','raw_payload',r.id::text,jsonb_build_object('job_id',j.id,'bucket','raw-payloads'));
   return jsonb_build_object('completed',true);
 end if;
 raise exception 'unsupported_raw_deletion_operation';
end $$;
-- Serialize the hold decision with the deletion submission decision. An uncertain
-- external deletion must be reconciled before claiming a new hold protects it.
create function private.guard_raw_deletion_hold() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if new.active and (new.ends_at is null or new.ends_at>now()) then
  perform pg_advisory_xact_lock(hashtextextended(new.tenant_id::text,0));
  if exists(select 1 from private.raw_file_deletions where tenant_id=new.tenant_id and state='prepared') then raise exception 'raw_file_deletion_in_flight_requires_reconciliation'; end if;
 end if;
 return new;
end $$;
revoke all on function private.guard_raw_deletion_hold() from public,anon,authenticated;
create trigger raw_deletion_hold_guard before insert or update on public.legal_holds for each row execute function private.guard_raw_deletion_hold();
revoke all on function public.queue_raw_payload_file_deletions(uuid,integer),public.raw_payload_deletion_command(uuid,text,integer,text) from public,anon,authenticated;
grant execute on function public.queue_raw_payload_file_deletions(uuid,integer),public.raw_payload_deletion_command(uuid,text,integer,text) to service_role;
create or replace function public.run_retention_maintenance(p_tenant_id uuid,p_limit integer default 1000)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare rid uuid; raw_deleted integer:=0; recordings_queued integer:=0; pending_raw_files integer:=0; queued_raw_files integer:=0; blocked_raw_files integer:=0; anonymized integer:=0; policy public.retention_policies%rowtype; c record;
begin
 insert into public.retention_runs(tenant_id) values(p_tenant_id) returning id into rid;
 with doomed as (select id from public.raw_payloads where tenant_id=p_tenant_id and retention_until is not null and retention_until<=now() and storage_path is null and not (metadata ? 'retentionPurgedAt') order by retention_until limit greatest(1,least(p_limit,10000)))
 update public.raw_payloads rp set payload_ciphertext=null,storage_path=null,metadata=metadata||jsonb_build_object('retentionPurgedAt',now()),parse_error=null from doomed where rp.id=doomed.id;
 get diagnostics raw_deleted=row_count;
 -- Physical recordings are deleted by telephony.retention, with Storage/provider acknowledgement and holds.
 -- Never erase the only locator here. Populate its legacy due date for that existing durable worker.
 update public.call_recordings set retention_delete_at=retention_until
 where tenant_id=p_tenant_id and retention_until<=now() and retention_until is not null
   and (retention_delete_at is null or retention_delete_at>retention_until) and deleted_at is null;
 get diagnostics recordings_queued=row_count;
 queued_raw_files:=public.queue_raw_payload_file_deletions(p_tenant_id,p_limit);
 select count(*) into pending_raw_files from public.raw_payloads
 where tenant_id=p_tenant_id and retention_until<=now() and storage_path is not null;
 select count(*) into blocked_raw_files from public.raw_payloads where tenant_id=p_tenant_id and retention_until<=now() and storage_path is not null
   and (metadata->>'storage_bucket' is distinct from 'raw-payloads' or not starts_with(storage_path,p_tenant_id::text||'/') or storage_path like '%..%');
 select * into policy from public.retention_policies where tenant_id=p_tenant_id and active and data_category='prospect_personal_data' and action in ('anonymize','delete') order by updated_at desc limit 1;
 if found then
   for c in select cu.id from public.customers cu where cu.tenant_id=p_tenant_id and cu.deleted_at is null and cu.lifecycle in ('prospect','lost','former_customer')
     and cu.updated_at<now()-make_interval(days=>policy.retention_days) and not public.customer_has_legal_retention(p_tenant_id,cu.id)
     order by cu.updated_at limit greatest(1,least(p_limit,10000))
   loop perform public.anonymize_customer_record(p_tenant_id,c.id,'retention_policy:'||policy.id::text,null); anonymized:=anonymized+1; end loop;
 end if;
 update public.retention_runs set status=case when blocked_raw_files>0 then 'failed' else 'completed' end,last_error=case when blocked_raw_files>0 then 'physical_raw_file_cleanup_required' else null end,deleted_count=raw_deleted,anonymized_count=anonymized,completed_at=now(),details=jsonb_build_object('rawPayloadsPurged',raw_deleted,'recordingsPurged',0,'recordingsQueuedForDeletion',recordings_queued,'pendingRawFiles',pending_raw_files,'queuedRawFiles',queued_raw_files,'blockedRawFiles',blocked_raw_files,'customersAnonymized',anonymized) where id=rid;
 return jsonb_build_object('status',case when blocked_raw_files>0 then 'failed' else 'completed' end,'runId',rid,'rawPayloadsPurged',raw_deleted,'recordingsPurged',0,'recordingsQueuedForDeletion',recordings_queued,'pendingRawFiles',pending_raw_files,'queuedRawFiles',queued_raw_files,'blockedRawFiles',blocked_raw_files,'customersAnonymized',anonymized);
exception when others then update public.retention_runs set status='failed',last_error=sqlerrm,completed_at=now() where id=rid; raise;
end $$;
commit;
