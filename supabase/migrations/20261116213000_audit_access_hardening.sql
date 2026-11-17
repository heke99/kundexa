begin;

create or replace function public.snooze_customer_callback(p_activity_id uuid,p_snoozed_until timestamptz)
returns void language plpgsql security definer set search_path=public as $$
declare v_tenant uuid:=public.current_tenant_id(); v_user uuid:=auth.uid(); v_activity public.activities%rowtype;
begin
  if p_snoozed_until<=now() then raise exception 'future_snooze_required'; end if;
  select * into v_activity from public.activities where tenant_id=v_tenant and id=p_activity_id and type='callback' for update;
  if not found then raise exception 'callback_not_found'; end if;
  if not coalesce(public.is_tenant_admin(v_tenant)
    or (v_activity.callback_scope='personal' and v_activity.assigned_user_id=v_user)
    or (v_activity.claimed_by=v_user and v_activity.claim_expires_at>now())
    or (v_activity.list_id is not null and public.can_manage_customer_list(v_activity.list_id)),false)
  then raise exception 'callback_permission_required'; end if;
  update public.activities set status='open',snoozed_until=p_snoozed_until,claimed_by=null,claim_expires_at=null
    where tenant_id=v_tenant and id=p_activity_id and status in ('open','in_progress');
  if not found then raise exception 'callback_not_open'; end if;
end $$;

create or replace function public.complete_customer_callback(p_activity_id uuid,p_notes text default null)
returns void language plpgsql security definer set search_path=public as $$
declare v_tenant uuid:=public.current_tenant_id(); v_user uuid:=auth.uid(); v_activity public.activities%rowtype;
begin
  select * into v_activity from public.activities where tenant_id=v_tenant and id=p_activity_id and type='callback' for update;
  if not found then raise exception 'callback_not_found'; end if;
  if not coalesce(public.is_tenant_admin(v_tenant)
    or (v_activity.callback_scope='personal' and v_activity.assigned_user_id=v_user)
    or (v_activity.claimed_by=v_user and v_activity.claim_expires_at>now())
    or (v_activity.list_id is not null and public.can_manage_customer_list(v_activity.list_id)),false)
  then raise exception 'callback_permission_required'; end if;
  update public.activities set status='completed',completed_at=now(),handled_at=now(),claimed_by=null,claim_expires_at=null
    where tenant_id=v_tenant and id=p_activity_id and status in ('open','in_progress');
  if not found then raise exception 'callback_not_open'; end if;
  if v_activity.customer_id is not null and nullif(trim(p_notes),'') is not null then
    insert into public.notes(tenant_id,customer_id,body,visibility,note_type,list_id,created_by)
    values(v_tenant,v_activity.customer_id,trim(p_notes),'team','callback',v_activity.list_id,v_user);
  end if;
end $$;

create or replace function public.claim_customer_callback(p_activity_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_tenant uuid:=public.current_tenant_id(); v_user uuid:=auth.uid(); v_activity public.activities%rowtype;
begin
  if v_tenant is null or v_user is null then raise exception 'active_tenant_membership_required'; end if;
  if not public.has_current_role(array['owner','admin','team_lead','sales','backoffice']) then raise exception 'callback_role_required'; end if;
  select * into v_activity from public.activities where tenant_id=v_tenant and id=p_activity_id and type='callback' for update;
  if not found then raise exception 'callback_not_found'; end if;
  if coalesce(v_activity.snoozed_until,v_activity.due_at)>now() then raise exception 'callback_not_due'; end if;
  if v_activity.status='in_progress' and v_activity.claimed_by<>v_user and v_activity.claim_expires_at>now() then raise exception 'callback_already_claimed'; end if;
  if v_activity.callback_scope='personal' and v_activity.assigned_user_id<>v_user then raise exception 'personal_callback_owner_required'; end if;
  if v_activity.callback_scope='global' and v_activity.assigned_team_id is not null and not public.can_operate_in_team(v_activity.assigned_team_id,v_user) then
    raise exception 'callback_team_permission_required';
  end if;
  if v_activity.list_id is not null and not public.can_work_customer_list(v_activity.list_id) then raise exception 'callback_list_permission_required'; end if;
  if v_activity.status not in ('open','in_progress') then raise exception 'callback_not_open'; end if;
  update public.activities set status='in_progress',claimed_by=v_user,claim_expires_at=now()+interval '10 minutes',updated_at=now() where tenant_id=v_tenant and id=p_activity_id;
  return jsonb_build_object('callbackId',v_activity.id,'customerId',v_activity.customer_id,'listId',v_activity.list_id);
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
  if v_message is not null then return v_message; end if;
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
  if v_message is not null then return v_message; end if;
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

create or replace function public.apply_import_row_normalization(p_import_run_id uuid,p_rows jsonb)
returns integer language plpgsql security definer set search_path=public as $$
declare v_tenant uuid:=public.current_tenant_id(); v_user uuid:=auth.uid(); v_count integer:=0;
begin
  if v_tenant is null or v_user is null then raise exception 'authentication_required'; end if;
  if not public.has_current_role(array['owner','admin','team_lead','backoffice']) then raise exception 'import_manage_permission_required'; end if;
  if not exists(select 1 from public.import_runs where tenant_id=v_tenant and id=p_import_run_id) then raise exception 'import_run_not_found'; end if;
  perform 1 from public.import_runs where id=p_import_run_id and tenant_id=v_tenant and status in ('mapping_required','preview_ready','validated','failed') for update;
  if not found then raise exception 'import_not_remappable'; end if;
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

create or replace function public.execute_data_subject_erasure(p_request_id uuid,p_actor uuid default null)
returns jsonb language plpgsql security definer set search_path=public as $$
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
  update public.data_subject_requests set status='completed',completed_at=now(),handled_by=p_actor,processing_notes=case when result->>'legalRetention'='true' then 'Identifierare anonymiserade; juridiskt nödvändiga avtalsuppgifter bevarade.' else 'Tenantunik persondata anonymiserad.' end where id=r.id;
  insert into public.data_subject_request_events(tenant_id,request_id,event_type,details,actor_user_id) values(r.tenant_id,r.id,'erasure_completed',result,p_actor);
  return result;
end $$;
commit;