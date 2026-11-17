begin;

create or replace function public.record_platform_worker_heartbeat(
  p_worker_key text,
  p_worker_id text,
  p_status text,
  p_started_at timestamptz,
  p_finished_at timestamptz,
  p_fetched_count integer,
  p_processed_count integer,
  p_failed_count integer,
  p_requeued_count integer,
  p_error_code text default null,
  p_error_message text default null,
  p_metadata jsonb default '{}'::jsonb
) returns void
language plpgsql
security definer
set search_path=public
as $$
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then raise exception 'service_role_required'; end if;
  insert into public.platform_worker_heartbeats(
    worker_key,worker_id,status,started_at,finished_at,last_success_at,
    fetched_count,processed_count,failed_count,requeued_count,
    last_error_code,last_error_message,metadata,updated_at
  ) values(
    p_worker_key,left(p_worker_id,200),p_status,p_started_at,p_finished_at,
    case when p_status in ('healthy','degraded') then p_finished_at else null end,
    greatest(coalesce(p_fetched_count,0),0),greatest(coalesce(p_processed_count,0),0),
    greatest(coalesce(p_failed_count,0),0),greatest(coalesce(p_requeued_count,0),0),
    left(p_error_code,100),left(p_error_message,500),coalesce(p_metadata,'{}'::jsonb),now()
  )
  on conflict(worker_key) do update set
    worker_id=excluded.worker_id,status=excluded.status,started_at=excluded.started_at,
    finished_at=excluded.finished_at,
    last_success_at=coalesce(excluded.last_success_at,public.platform_worker_heartbeats.last_success_at),
    fetched_count=excluded.fetched_count,processed_count=excluded.processed_count,
    failed_count=excluded.failed_count,requeued_count=excluded.requeued_count,
    last_error_code=excluded.last_error_code,last_error_message=excluded.last_error_message,
    metadata=case when excluded.status='running' then public.platform_worker_heartbeats.metadata||excluded.metadata else excluded.metadata end,updated_at=now()
  where excluded.started_at>=public.platform_worker_heartbeats.started_at;
end $$;

create or replace function public.claim_outbox_jobs(p_worker text,p_limit integer default 25)
returns setof public.outbox_jobs language plpgsql security definer set search_path=public,extensions,pg_temp as $$
begin
  if nullif(btrim(p_worker),'') is null then raise exception 'worker_required'; end if;
  update public.outbox_jobs set status='dead_letter',last_error='outbox_attempts_exhausted',locked_at=null,locked_by=null
    where attempts>=max_attempts and (status in ('pending','failed') or (status='processing' and coalesce(locked_at,created_at)<now()-interval '5 minutes'));
  return query with picked as (
    select id from public.outbox_jobs where
      (status in ('pending','failed') and attempts<max_attempts and available_at<=now())
      or (status='processing' and attempts<max_attempts and coalesce(locked_at,created_at)<now()-interval '5 minutes')
    order by priority,created_at for update skip locked limit greatest(1,least(p_limit,100))
  ) update public.outbox_jobs j set status='processing',locked_at=now(),locked_by=p_worker,attempts=j.attempts+1
    from picked where j.id=picked.id returning j.*;
end $$;

create or replace function public.anonymize_customer_record(p_tenant_id uuid,p_customer_id uuid,p_reason text,p_actor uuid default null)
returns jsonb language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare c public.customers%rowtype; token text; retained boolean; removed_master integer:=0;
begin
  select * into c from public.customers where tenant_id=p_tenant_id and id=p_customer_id for update;
  if not found then return jsonb_build_object('anonymized',false,'reason','customer_not_found'); end if;
  retained:=public.customer_has_legal_retention(p_tenant_id,p_customer_id);
  if retained then return jsonb_build_object('anonymized',false,'legalRetention',true,'reason','legal_retention_review_required'); end if;
  token:=substr(encode(digest(c.id::text||p_tenant_id::text,'sha256'),'hex'),1,12);
  if c.phone_e164 is not null or c.email is not null then
    insert into public.compliance_blocks(tenant_id,customer_id,phone_e164,email,channels,reason,source,active,created_by)
    select p_tenant_id,null,c.phone_e164,c.email,array['call','sms','email'],coalesce(p_reason,'retention_anonymization'),'retention',true,p_actor
    where not exists(select 1 from public.compliance_blocks b where b.tenant_id=p_tenant_id and b.active and b.source='retention' and (b.phone_e164=c.phone_e164 or b.email=c.email));
  end if;
  delete from public.contact_people where tenant_id=p_tenant_id and customer_id=p_customer_id;
  delete from public.notes where tenant_id=p_tenant_id and customer_id=p_customer_id;
  delete from public.customer_tags where tenant_id=p_tenant_id and customer_id=p_customer_id;
  delete from public.customer_list_members where tenant_id=p_tenant_id and customer_id=p_customer_id;
  update public.activities set title='Raderad aktivitet',description=null,metadata='{}'::jsonb where tenant_id=p_tenant_id and customer_id=p_customer_id and contract_id is null;
  update public.calls set from_number='[redacted]',to_number='[redacted]',notes=null,metadata='{}'::jsonb where tenant_id=p_tenant_id and customer_id=p_customer_id;
  update public.sms_messages set from_number='[redacted]',to_number='[redacted]',body='[redacted]' where tenant_id=p_tenant_id and customer_id=p_customer_id and contract_id is null;
  update public.email_messages set to_addresses=array['redacted@invalid.local']::citext[],cc_addresses='{}',subject='[redacted]',body_text=null,body_html=null,attachments='[]'::jsonb where tenant_id=p_tenant_id and customer_id=p_customer_id and contract_id is null;
  delete from public.master_entities me using public.tenant_entities te,public.data_providers dp
    where te.tenant_id=p_tenant_id and te.customer_id=p_customer_id and me.id=te.master_entity_id and me.cache_scope='tenant' and me.data_provider_id=dp.id and dp.source_class='tenant_import';
  get diagnostics removed_master=row_count;
  update public.customers set display_name='Raderad kund '||token,first_name=null,last_name=null,company_name=null,personal_identity_number=null,organization_number=case when retained then organization_number else null end,
    email=null,phone_e164=null,alternate_phone_e164=null,website=null,address_line1=null,address_line2=null,postal_code=null,city=null,municipality=null,county=null,latitude=null,longitude=null,current_supplier=null,
    source_name=null,source_external_id=null,source_retrieved_at=null,source_verified_at=null,marketing_allowed=false,legal_basis=null,do_not_call=true,do_not_sms=true,do_not_email=true,blocked_reason=coalesce(p_reason,'retention_anonymization'),
    assigned_user_id=null,assigned_team_id=null,campaign_id=null,custom_fields='{}'::jsonb,deleted_at=coalesce(deleted_at,now()),updated_at=now() where tenant_id=p_tenant_id and id=p_customer_id;
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data) values(p_tenant_id,p_actor,'customer.anonymized','customer',p_customer_id::text,jsonb_build_object('reason',p_reason,'legalRetention',retained,'tenantMasterEntitiesRemoved',removed_master));
  return jsonb_build_object('anonymized',true,'legalRetention',retained,'tenantMasterEntitiesRemoved',removed_master);
end $$;

create or replace function public.execute_data_subject_erasure(p_request_id uuid,p_actor uuid default null)
returns jsonb language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare r public.data_subject_requests%rowtype; result jsonb;
begin
  select * into r from public.data_subject_requests where id=p_request_id for update;
  if not found then raise exception 'data_subject_request_not_found'; end if;
  if p_actor is null or not exists(select 1 from public.tenant_memberships m join public.tenants t on t.id=m.tenant_id where m.tenant_id=r.tenant_id and m.user_id=p_actor and m.status='active' and m.role in ('owner','admin') and t.status in ('active','trial')) then raise exception 'erasure_actor_permission_required'; end if;
  if r.request_type<>'erasure' then raise exception 'data_subject_request_not_erasure'; end if;
  if r.identity_verified_at is null then raise exception 'identity_verification_required'; end if;
  if r.customer_id is null then raise exception 'data_subject_request_customer_missing'; end if;
  if auth.uid() is not null and not public.is_tenant_admin(r.tenant_id) then raise exception 'admin_required'; end if;
  update public.data_subject_requests set status='processing',handled_by=p_actor where id=r.id;
  insert into public.data_subject_request_events(tenant_id,request_id,event_type,details,actor_user_id) values(r.tenant_id,r.id,'erasure_started','{}',p_actor);
  result:=public.anonymize_customer_record(r.tenant_id,r.customer_id,'data_subject_erasure',p_actor);
  if not coalesce((result->>'anonymized')::boolean,false) then raise exception 'erasure_requires_retention_review'; end if;
  update public.data_subject_requests set status='completed',completed_at=now(),handled_by=p_actor,processing_notes=case when result->>'legalRetention'='true' then 'Identifierare anonymiserade; juridiskt nödvändiga avtalsuppgifter bevarade.' else 'Tenantunik persondata anonymiserad.' end where id=r.id;
  insert into public.data_subject_request_events(tenant_id,request_id,event_type,details,actor_user_id) values(r.tenant_id,r.id,'erasure_completed',result,p_actor);
  return result;
end $$;

create or replace function public.data_subject_export_for_request(p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare r public.data_subject_requests%rowtype; result jsonb;
begin
  select * into r from public.data_subject_requests where id=p_request_id;
  if not found or r.customer_id is null then raise exception 'data_subject_request_customer_missing'; end if;
  if auth.uid() is not null and not public.is_tenant_admin(r.tenant_id) then raise exception 'admin_required'; end if;
  select jsonb_build_object(
    'requestId',r.id,'generatedAt',now(),'customer',(select to_jsonb(c)-'personal_identity_number' from public.customers c where c.tenant_id=r.tenant_id and c.id=r.customer_id),
    'notes',coalesce((select jsonb_agg(to_jsonb(x)) from public.notes x where x.tenant_id=r.tenant_id and x.customer_id=r.customer_id),'[]'::jsonb),
    'contactPeople',coalesce((select jsonb_agg(to_jsonb(x)) from public.contact_people x where x.tenant_id=r.tenant_id and x.customer_id=r.customer_id),'[]'::jsonb),
    'activities',coalesce((select jsonb_agg(to_jsonb(x)) from public.activities x where x.tenant_id=r.tenant_id and x.customer_id=r.customer_id),'[]'::jsonb),
    'calls',coalesce((select jsonb_agg(to_jsonb(x)) from public.calls x where x.tenant_id=r.tenant_id and x.customer_id=r.customer_id),'[]'::jsonb),
    'sms',coalesce((select jsonb_agg(to_jsonb(x)) from public.sms_messages x where x.tenant_id=r.tenant_id and x.customer_id=r.customer_id),'[]'::jsonb),
    'email',coalesce((select jsonb_agg(to_jsonb(x)) from public.email_messages x where x.tenant_id=r.tenant_id and x.customer_id=r.customer_id),'[]'::jsonb),
    'contracts',coalesce((select jsonb_agg(to_jsonb(x)) from public.contracts x where x.tenant_id=r.tenant_id and x.customer_id=r.customer_id),'[]'::jsonb),
    'permissions',coalesce((select jsonb_agg(to_jsonb(x)) from public.contact_permissions x where x.tenant_id=r.tenant_id and x.customer_id=r.customer_id),'[]'::jsonb),
    'nixChecks',coalesce((select jsonb_agg(to_jsonb(x)) from public.nix_checks x where x.tenant_id=r.tenant_id and x.customer_id=r.customer_id),'[]'::jsonb)
  ) into result;
  return result;
end $$;

create or replace function public.queue_email_message(
  p_customer_id uuid,
  p_subject text,
  p_body text,
  p_idempotency_key text,
  p_purpose text default 'direct_marketing'
)
returns uuid
language plpgsql security definer set search_path=public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_user uuid := auth.uid();
  v_customer public.customers%rowtype;
  v_message uuid;
begin
  if v_user is null or v_tenant is null then raise exception 'authentication_required'; end if;
  if not public.has_current_role(array['owner','admin','team_lead','sales','contract_manager','backoffice']) then raise exception 'message_send_permission_required'; end if;
  if nullif(trim(p_subject),'') is null or nullif(trim(p_body),'') is null then raise exception 'email_content_required'; end if;
  if nullif(trim(p_idempotency_key),'') is null then raise exception 'idempotency_key_required'; end if;
  if not coalesce(public.can_write_customer(p_customer_id),false) then raise exception 'customer_access_denied'; end if;
  select id into v_message from public.email_messages where tenant_id=v_tenant and idempotency_key=p_idempotency_key;
  if v_message is not null then if not exists(select 1 from public.email_messages m where m.id=v_message and m.customer_id=p_customer_id and m.subject=p_subject and m.body_text=p_body and m.purpose=p_purpose) then raise exception 'idempotency_payload_conflict'; end if; return v_message; end if;
  select * into v_customer from public.customers where tenant_id=v_tenant and id=p_customer_id and deleted_at is null;
  if not found or v_customer.email is null then raise exception 'customer_email_missing'; end if;
  insert into public.email_messages(
    tenant_id,customer_id,direction,from_address,to_addresses,subject,body_text,status,created_by,idempotency_key,purpose
  ) values (
    v_tenant,p_customer_id,'outbound','pending@kundexa.local',array[v_customer.email]::citext[],p_subject,p_body,'queued',v_user,p_idempotency_key,p_purpose
  ) returning id into v_message;
  insert into public.outbox_jobs(tenant_id,job_type,aggregate_type,aggregate_id,payload,idempotency_key)
    values(v_tenant,'email.send','email_message',v_message,jsonb_build_object('email_message_id',v_message),'email.send:'||v_message::text);
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
    values(v_tenant,v_user,'email.queued','email_message',v_message::text,jsonb_build_object('customer_id',p_customer_id,'purpose',p_purpose));
  return v_message;
end
$$;

create or replace function public.queue_sms_message(
  p_customer_id uuid,
  p_body text,
  p_idempotency_key text,
  p_purpose text default 'direct_marketing'
)
returns uuid
language plpgsql security definer set search_path=public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_user uuid := auth.uid();
  v_customer public.customers%rowtype;
  v_number text;
  v_message uuid;
begin
  if v_user is null or v_tenant is null then raise exception 'authentication_required'; end if;
  if not public.has_current_role(array['owner','admin','team_lead','sales','contract_manager','backoffice']) then raise exception 'message_send_permission_required'; end if;
  if nullif(trim(p_body),'') is null then raise exception 'sms_body_required'; end if;
  if nullif(trim(p_idempotency_key),'') is null then raise exception 'idempotency_key_required'; end if;
  if not coalesce(public.can_write_customer(p_customer_id),false) then raise exception 'customer_access_denied'; end if;
  select id into v_message from public.sms_messages where tenant_id=v_tenant and idempotency_key=p_idempotency_key;
  if v_message is not null then if not exists(select 1 from public.sms_messages m where m.id=v_message and m.customer_id=p_customer_id and m.body=p_body and m.purpose=p_purpose) then raise exception 'idempotency_payload_conflict'; end if; return v_message; end if;
  select * into v_customer from public.customers where tenant_id=v_tenant and id=p_customer_id and deleted_at is null;
  if not found or v_customer.phone_e164 is null then raise exception 'customer_phone_missing'; end if;
  if v_customer.phone_e164 !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'customer_phone_invalid'; end if;
  select number_e164 into v_number from public.phone_numbers
    where tenant_id=v_tenant and supports_sms and status='active'
    order by created_at,id limit 1;
  if v_number is null then raise exception 'sms_sender_missing'; end if;
  insert into public.sms_messages(
    tenant_id,customer_id,direction,from_number,to_number,body,status,created_by,idempotency_key,purpose
  ) values (
    v_tenant,p_customer_id,'outbound',v_number,v_customer.phone_e164,p_body,'queued',v_user,p_idempotency_key,p_purpose
  ) returning id into v_message;
  insert into public.outbox_jobs(tenant_id,job_type,aggregate_type,aggregate_id,payload,idempotency_key)
    values(v_tenant,'sms.send','sms_message',v_message,jsonb_build_object('sms_message_id',v_message),'sms.send:'||v_message::text);
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
    values(v_tenant,v_user,'sms.queued','sms_message',v_message::text,jsonb_build_object('customer_id',p_customer_id,'purpose',p_purpose));
  return v_message;
end
$$;

commit;