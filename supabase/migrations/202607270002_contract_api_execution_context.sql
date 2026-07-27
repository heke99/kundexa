begin;

create unique index if not exists audit_logs_contract_api_idempotency_uidx
  on public.audit_logs(tenant_id,action,request_id)
  where request_id is not null and action in (
    'contract.api_created','contract.api_sent','contract.api_reminder_scheduled','contract.api_expiry_extended'
  );

-- A service-role API call may execute a narrowly scoped SECURITY DEFINER wrapper
-- as the API key creator. The tenant context is local to the current transaction
-- and is accepted only while that actor still has an active membership.
create or replace function public.current_tenant_id()
returns uuid
language sql
stable
security definer
set search_path=public
as $$
  select coalesce(
    (
      select t.id
      from public.tenants t
      join public.tenant_memberships m
        on m.tenant_id=t.id and m.user_id=auth.uid() and m.status='active'
      where t.id=nullif(current_setting('app.kundexa_tenant_id',true),'')::uuid
        and t.status in ('trial','active')
    ),
    (
      select p.active_tenant_id
      from public.profiles p
      join public.tenant_memberships m
        on m.tenant_id=p.active_tenant_id and m.user_id=p.id and m.status='active'
      join public.tenants t on t.id=p.active_tenant_id and t.status in ('trial','active')
      where p.id=auth.uid()
    )
  )
$$;

create or replace function public.create_contract_draft_api_v2(
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_contract_number text,
  p_customer_id uuid,
  p_product_id uuid,
  p_price_version_id uuid,
  p_template_id uuid,
  p_template_version_id uuid,
  p_legal_entity_id uuid,
  p_title text,
  p_rendered_body text,
  p_rendered_terms text,
  p_commercial_terms jsonb,
  p_document_hash text,
  p_seller_snapshot jsonb,
  p_counterparty_snapshot jsonb,
  p_source_call_id uuid,
  p_idempotency_key text
) returns uuid
language plpgsql
security definer
set search_path=public
as $$
declare v_contract uuid;
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_required'; end if;
  if nullif(trim(p_idempotency_key),'') is null then raise exception 'idempotency_key_required'; end if;
  if p_actor_user_id is null or not exists(
    select 1 from public.tenant_memberships
    where tenant_id=p_tenant_id and user_id=p_actor_user_id and status='active'
  ) then raise exception 'active_api_actor_membership_required'; end if;
  perform set_config('request.jwt.claim.sub',p_actor_user_id::text,true);
  perform set_config('app.kundexa_tenant_id',p_tenant_id::text,true);
  if public.current_tenant_id() is distinct from p_tenant_id then raise exception 'tenant_context_rejected'; end if;
  if not public.is_contract_call_eligible(p_tenant_id,p_customer_id,p_source_call_id,p_actor_user_id) then
    raise exception 'source_call_not_eligible';
  end if;
  v_contract:=public.create_contract_draft_v2(
    p_contract_number,p_customer_id,p_product_id,p_price_version_id,p_template_id,p_template_version_id,
    p_legal_entity_id,p_title,p_rendered_body,p_rendered_terms,p_commercial_terms,p_document_hash,'api',
    p_seller_snapshot,p_counterparty_snapshot
  );
  update public.contracts set
    source_call_id=p_source_call_id,source_type='api_call',prepared_at=now(),send_block_reason=null
  where tenant_id=p_tenant_id and id=v_contract;
  insert into public.contract_events(tenant_id,contract_id,event_type,actor_user_id,payload)
  values(p_tenant_id,v_contract,'contract.source_call_linked',p_actor_user_id,
    jsonb_build_object('source_call_id',p_source_call_id,'source_type','api_call','api_idempotency_key',p_idempotency_key));
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,request_id,after_data)
  values(p_tenant_id,p_actor_user_id,'contract.api_created','contract',v_contract::text,p_idempotency_key,
    jsonb_build_object('contract_id',v_contract));
  return v_contract;
end $$;

create or replace function public.prepare_contract_delivery_api_v2(
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_contract_id uuid,
  p_channel text,
  p_recipient_name text,
  p_email text,
  p_phone_e164 text,
  p_public_token_hash text,
  p_public_token_ciphertext text,
  p_acceptance_code text,
  p_expires_at timestamptz,
  p_canonical_document_id uuid,
  p_sms_from text,
  p_sms_body text,
  p_email_from text,
  p_email_subject text,
  p_email_text text,
  p_email_html text,
  p_email_attachments jsonb,
  p_reply_to text,
  p_personal_message text,
  p_idempotency_key text
) returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare v_result jsonb;
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_required'; end if;
  if nullif(trim(p_idempotency_key),'') is null then raise exception 'idempotency_key_required'; end if;
  if p_actor_user_id is null or not exists(
    select 1 from public.tenant_memberships
    where tenant_id=p_tenant_id and user_id=p_actor_user_id and status='active'
  ) then raise exception 'active_api_actor_membership_required'; end if;
  perform set_config('request.jwt.claim.sub',p_actor_user_id::text,true);
  perform set_config('app.kundexa_tenant_id',p_tenant_id::text,true);
  v_result:=public.prepare_contract_delivery_v2(
    p_contract_id,p_channel,p_recipient_name,p_email,p_phone_e164,p_public_token_hash,
    p_public_token_ciphertext,p_acceptance_code,p_expires_at,p_canonical_document_id,
    p_sms_from,p_sms_body,p_email_from,p_email_subject,p_email_text,p_email_html,
    p_email_attachments,p_reply_to,p_personal_message
  );
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,request_id,after_data)
  values(p_tenant_id,p_actor_user_id,'contract.api_sent','contract',p_contract_id::text,p_idempotency_key,v_result);
  return v_result;
end $$;

create or replace function public.schedule_manual_contract_reminder_api_v2(
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_contract_id uuid,
  p_channel text,
  p_personal_message text,
  p_attach_pdf boolean,
  p_idempotency_key text
) returns uuid
language plpgsql
security definer
set search_path=public
as $$
declare v_reminder uuid;
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_required'; end if;
  if nullif(trim(p_idempotency_key),'') is null then raise exception 'idempotency_key_required'; end if;
  if p_actor_user_id is null or not exists(
    select 1 from public.tenant_memberships
    where tenant_id=p_tenant_id and user_id=p_actor_user_id and status='active'
  ) then raise exception 'active_api_actor_membership_required'; end if;
  perform set_config('request.jwt.claim.sub',p_actor_user_id::text,true);
  perform set_config('app.kundexa_tenant_id',p_tenant_id::text,true);
  v_reminder:=public.schedule_manual_contract_reminder(
    p_contract_id,p_channel,p_personal_message,p_attach_pdf,p_idempotency_key
  );
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,request_id,after_data)
  values(p_tenant_id,p_actor_user_id,'contract.api_reminder_scheduled','contract',p_contract_id::text,p_idempotency_key,
    jsonb_build_object('reminder_id',v_reminder));
  return v_reminder;
end $$;

create or replace function public.extend_contract_acceptance_expiry_api_v2(
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_contract_id uuid,
  p_expires_at timestamptz,
  p_idempotency_key text
) returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare v_request public.contract_acceptance_requests%rowtype;
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_required'; end if;
  if nullif(trim(p_idempotency_key),'') is null then raise exception 'idempotency_key_required'; end if;
  if p_expires_at<=now() then raise exception 'acceptance_expiry_must_be_future'; end if;
  if p_actor_user_id is null or not exists(
    select 1 from public.tenant_memberships
    where tenant_id=p_tenant_id and user_id=p_actor_user_id and status='active'
      and role in ('owner','admin','team_lead','contract_manager')
  ) then raise exception 'contract_expiry_permission_required'; end if;
  select * into v_request from public.contract_acceptance_requests
  where tenant_id=p_tenant_id and contract_id=p_contract_id and status='pending'
  order by created_at desc limit 1 for update;
  if not found then raise exception 'pending_acceptance_request_not_found'; end if;
  update public.contract_acceptance_requests set expires_at=p_expires_at where id=v_request.id;
  update public.contracts set expires_at=p_expires_at where tenant_id=p_tenant_id and id=p_contract_id;
  update public.contract_reminders r set scheduled_at=p_expires_at-make_interval(hours=>policy.final_reminder_before_expiry_hours)
  from public.contract_reminder_policies policy
  where policy.tenant_id=p_tenant_id and r.tenant_id=p_tenant_id and r.acceptance_request_id=v_request.id
    and r.kind='automatic' and r.sequence_number=3 and r.status='scheduled';
  insert into public.contract_events(tenant_id,contract_id,event_type,actor_user_id,payload)
  values(p_tenant_id,p_contract_id,'contract.expiry_extended',p_actor_user_id,
    jsonb_build_object('previous_expires_at',v_request.expires_at,'expires_at',p_expires_at));
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,before_data,after_data)
  values(p_tenant_id,p_actor_user_id,'contract.expiry_extended','contract',p_contract_id::text,
    jsonb_build_object('expires_at',v_request.expires_at),jsonb_build_object('expires_at',p_expires_at));
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,request_id,after_data)
  values(p_tenant_id,p_actor_user_id,'contract.api_expiry_extended','contract',p_contract_id::text,p_idempotency_key,
    jsonb_build_object('acceptance_request_id',v_request.id,'expires_at',p_expires_at));
  return jsonb_build_object('contract_id',p_contract_id,'acceptance_request_id',v_request.id,'expires_at',p_expires_at);
end $$;

revoke all on function public.create_contract_draft_api_v2(uuid,uuid,text,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,jsonb,text,jsonb,jsonb,uuid,text) from public,anon,authenticated;
revoke all on function public.prepare_contract_delivery_api_v2(uuid,uuid,uuid,text,text,text,text,text,text,text,timestamptz,uuid,text,text,text,text,text,text,jsonb,text,text,text) from public,anon,authenticated;
revoke all on function public.schedule_manual_contract_reminder_api_v2(uuid,uuid,uuid,text,text,boolean,text) from public,anon,authenticated;
revoke all on function public.extend_contract_acceptance_expiry_api_v2(uuid,uuid,uuid,timestamptz,text) from public,anon,authenticated;
grant execute on function public.create_contract_draft_api_v2(uuid,uuid,text,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,jsonb,text,jsonb,jsonb,uuid,text) to service_role;
grant execute on function public.prepare_contract_delivery_api_v2(uuid,uuid,uuid,text,text,text,text,text,text,text,timestamptz,uuid,text,text,text,text,text,text,jsonb,text,text,text) to service_role;
grant execute on function public.schedule_manual_contract_reminder_api_v2(uuid,uuid,uuid,text,text,boolean,text) to service_role;
grant execute on function public.extend_contract_acceptance_expiry_api_v2(uuid,uuid,uuid,timestamptz,text) to service_role;

commit;
