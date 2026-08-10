begin;

-- One canonical contract acceptance/signing generation.  Resends supersede old
-- requests and recipients, call eligibility is snapshotted at send time, and all
-- interactive acceptance channels reduce through record_contract_acceptance_v3.

alter table public.contracts
  add column if not exists acceptance_generation integer not null default 0,
  add column if not exists source_call_eligibility_snapshot jsonb,
  add column if not exists source_call_eligibility_locked_at timestamptz;

alter table public.contracts drop constraint if exists contracts_acceptance_generation_check;
alter table public.contracts add constraint contracts_acceptance_generation_check
  check (acceptance_generation >= 0);

alter table public.contract_versions
  add column if not exists signature_policy_snapshot jsonb;

alter table public.signing_envelopes
  add column if not exists generation integer not null default 0;
alter table public.signing_envelopes drop constraint if exists signing_envelopes_generation_check;
alter table public.signing_envelopes add constraint signing_envelopes_generation_check check(generation >= 0);
create index if not exists signing_envelopes_current_generation_idx
  on public.signing_envelopes(tenant_id,contract_id,generation,status);

alter table public.contract_recipients
  add column if not exists generation integer not null default 0;
alter table public.contract_recipients drop constraint if exists contract_recipients_generation_check;
alter table public.contract_recipients add constraint contract_recipients_generation_check check(generation >= 0);

alter table public.contract_acceptance_requests
  add column if not exists generation integer not null default 0;
alter table public.contract_acceptance_requests drop constraint if exists contract_acceptance_requests_generation_check;
alter table public.contract_acceptance_requests add constraint contract_acceptance_requests_generation_check check(generation >= 0);

create index if not exists contract_recipients_current_generation_idx
  on public.contract_recipients(tenant_id,contract_id,generation,required,status);
create index if not exists contract_acceptance_requests_current_generation_idx
  on public.contract_acceptance_requests(tenant_id,contract_id,generation,status,expires_at desc);

create or replace function public.manual_contract_disposition_allowed(
  p_tenant_id uuid,
  p_disposition text
) returns boolean
language sql stable security definer set search_path=public as $$
  select case
    when nullif(trim(coalesce(p_disposition,'')),'') is null then false
    when jsonb_typeof(coalesce(
      (select ts.settings#>'{contracts,manual_call_eligible_dispositions}' from public.tenant_settings ts where ts.tenant_id=p_tenant_id),
      'null'::jsonb
    ))='array'
      then coalesce(
        (select (ts.settings#>'{contracts,manual_call_eligible_dispositions}') ? p_disposition
         from public.tenant_settings ts where ts.tenant_id=p_tenant_id),
        false
      )
    else p_disposition in ('interested','contract','contract_requested','sale','sold','order')
  end
$$;
revoke all on function public.manual_contract_disposition_allowed(uuid,text) from public,anon;
grant execute on function public.manual_contract_disposition_allowed(uuid,text) to authenticated,service_role;

create or replace function public.is_contract_call_eligible(
  p_tenant_id uuid,
  p_customer_id uuid,
  p_call_id uuid,
  p_user_id uuid default auth.uid()
) returns boolean
language sql stable security definer set search_path=public as $$
  select exists(
    select 1
    from public.calls c
    where c.tenant_id=p_tenant_id
      and c.id=p_call_id
      and c.customer_id=p_customer_id
      and c.status='completed'
      and c.answered_at is not null
      and c.ended_at is not null
      and c.ended_at <= now()
      and c.invalidated_at is null
      and c.disposition is not null
      and (
        (c.list_id is not null and exists(
          select 1 from public.list_dispositions d
          where d.tenant_id=c.tenant_id
            and d.list_id=c.list_id
            and d.key=c.disposition
            and d.active
            and d.contract_eligible
        ))
        or (c.list_id is null and public.manual_contract_disposition_allowed(c.tenant_id,c.disposition))
      )
      and (
        p_user_id is null
        or c.user_id=p_user_id
        or public.is_tenant_admin(p_tenant_id)
        or exists(
          select 1 from public.tenant_memberships m
          where m.tenant_id=p_tenant_id and m.user_id=p_user_id and m.status='active'
            and m.role in ('team_lead','contract_manager','backoffice','quality')
        )
        or (c.list_id is not null and public.can_work_customer_list(c.list_id))
      )
  )
$$;

create or replace function public.register_external_manual_call(
  p_customer_id uuid,
  p_phone_e164 text,
  p_direction public.communication_direction,
  p_started_at timestamptz,
  p_ended_at timestamptz,
  p_disposition text,
  p_notes text,
  p_external_reference text default null
) returns uuid language plpgsql security definer set search_path=public as $$
declare
  v_tenant uuid:=public.current_tenant_id();
  v_user uuid:=auth.uid();
  v_call uuid;
  v_customer public.customers%rowtype;
begin
  if v_tenant is null or v_user is null then raise exception 'authentication_required'; end if;
  if not public.can_write_customer(p_customer_id) then raise exception 'customer_write_permission_required'; end if;
  if p_started_at is null or p_ended_at is null or p_ended_at<=p_started_at or p_ended_at>now() then raise exception 'invalid_manual_call_times'; end if;
  if extract(epoch from (p_ended_at-p_started_at)) > 43200 then raise exception 'manual_call_duration_too_long'; end if;
  if not public.manual_contract_disposition_allowed(v_tenant,p_disposition) then
    raise exception 'manual_call_disposition_not_contract_eligible';
  end if;
  if p_phone_e164 is null or p_phone_e164 !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'manual_call_phone_e164_required'; end if;
  if nullif(trim(p_notes),'') is null then raise exception 'manual_call_note_required'; end if;
  select * into v_customer from public.customers where tenant_id=v_tenant and id=p_customer_id and deleted_at is null;
  if not found then raise exception 'customer_not_found'; end if;

  insert into public.calls(
    tenant_id,customer_id,user_id,direction,from_number,to_number,status,disposition,notes,
    started_at,answered_at,ended_at,duration_seconds,callback_token_hash,metadata,purpose,after_call_completed_at
  ) values(
    v_tenant,p_customer_id,v_user,p_direction,
    case when p_direction='outbound' then 'external_manual' else p_phone_e164 end,
    case when p_direction='outbound' then p_phone_e164 else 'external_manual' end,
    'completed',p_disposition,trim(p_notes),p_started_at,p_started_at,p_ended_at,
    greatest(1,floor(extract(epoch from (p_ended_at-p_started_at)))::integer),encode(gen_random_bytes(32),'hex'),
    jsonb_build_object('source','external_manual','registered_manually',true,'external_reference',nullif(trim(p_external_reference),''),'confirmed_real_call',true),
    'contract_delivery',p_ended_at
  ) returning id into v_call;

  insert into public.call_events(tenant_id,call_id,event_type,payload)
  values(v_tenant,v_call,'manual_external_call.registered',jsonb_build_object('registered_by',v_user,'external_reference',nullif(trim(p_external_reference),'')));
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
  values(v_tenant,v_user,'call.external_registered','call',v_call::text,jsonb_build_object('customer_id',p_customer_id,'started_at',p_started_at,'ended_at',p_ended_at,'disposition',p_disposition));
  return v_call;
end $$;

create or replace function public.assert_contract_sendable_v2(
  p_contract_id uuid,
  p_canonical_document_id uuid,
  p_channel text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_tenant uuid:=public.current_tenant_id();
  v_contract public.contracts%rowtype;
  v_doc public.contract_documents%rowtype;
begin
  if v_tenant is null or auth.uid() is null then raise exception 'authentication_required'; end if;
  if p_channel not in ('email','sms','both') then raise exception 'invalid_delivery_channel'; end if;
  select * into v_contract from public.contracts where tenant_id=v_tenant and id=p_contract_id for update;
  if not found then raise exception 'contract_not_found'; end if;
  if not public.can_write_contract(v_contract.id,v_contract.customer_id)
    or not public.has_current_role(array['owner','admin','team_lead','sales','contract_manager']) then
    raise exception 'contract_send_permission_required';
  end if;
  if v_contract.active_version_id is null then raise exception 'active_contract_version_required'; end if;
  if v_contract.status not in ('ready','sent','delivered','opened') then raise exception 'contract_not_sendable:%',v_contract.status; end if;
  if v_contract.source_call_id is null then raise exception 'source_call_required'; end if;
  if v_contract.source_call_eligibility_locked_at is null then
    if not public.is_contract_call_eligible(v_tenant,v_contract.customer_id,v_contract.source_call_id,auth.uid()) then
      raise exception 'source_call_not_eligible';
    end if;
  elsif coalesce(v_contract.source_call_eligibility_snapshot->>'eligible','false')<>'true'
     or (v_contract.source_call_eligibility_snapshot->>'callId') is distinct from v_contract.source_call_id::text then
    raise exception 'source_call_snapshot_invalid';
  end if;
  select * into v_doc from public.contract_documents
  where tenant_id=v_tenant and id=p_canonical_document_id and contract_id=v_contract.id and contract_version_id=v_contract.active_version_id;
  if not found then raise exception 'canonical_document_not_found'; end if;
  if v_doc.document_type not in ('generated_pdf','source_pdf') or v_doc.mime_type<>'application/pdf'
     or coalesce(v_doc.size_bytes,0)<=0 or coalesce(v_doc.size_bytes,0)>20971520 then raise exception 'canonical_document_invalid'; end if;
  if nullif(v_doc.sha256,'') is null then raise exception 'canonical_document_hash_required'; end if;
  if p_channel in ('email','both') then
    if not exists(select 1 from public.tenant_features where tenant_id=v_tenant and feature_key='outbound_email' and enabled) then raise exception 'outbound_email_feature_disabled'; end if;
    if not exists(select 1 from public.tenant_features where tenant_id=v_tenant and feature_key='contract_delivery_email' and enabled) then raise exception 'contract_delivery_email_feature_disabled'; end if;
    if not exists(select 1 from public.tenant_integrations where tenant_id=v_tenant and provider='resend' and status='active') then raise exception 'resend_integration_not_active'; end if;
  end if;
  if p_channel in ('sms','both') then
    if not exists(select 1 from public.tenant_features where tenant_id=v_tenant and feature_key='outbound_sms' and enabled) then raise exception 'outbound_sms_feature_disabled'; end if;
    if not exists(select 1 from public.tenant_features where tenant_id=v_tenant and feature_key='contract_delivery_sms' and enabled) then raise exception 'contract_delivery_sms_feature_disabled'; end if;
  end if;
  return jsonb_build_object(
    'contract_id',v_contract.id,'contract_version_id',v_contract.active_version_id,'customer_id',v_contract.customer_id,
    'source_call_id',v_contract.source_call_id,'canonical_document_id',v_doc.id,'canonical_document_sha256',v_doc.sha256,
    'source_call_snapshot_locked',v_contract.source_call_eligibility_locked_at is not null
  );
end $$;

create or replace function public.protect_locked_contract_call_snapshot() returns trigger
language plpgsql set search_path=public as $$
begin
  if old.source_call_eligibility_locked_at is not null and (
    new.source_call_id is distinct from old.source_call_id
    or new.source_call_eligibility_snapshot is distinct from old.source_call_eligibility_snapshot
    or new.source_call_eligibility_locked_at is distinct from old.source_call_eligibility_locked_at
  ) then
    raise exception 'contract_source_call_snapshot_is_immutable';
  end if;
  return new;
end $$;
drop trigger if exists contracts_source_call_snapshot_immutability on public.contracts;
create trigger contracts_source_call_snapshot_immutability
before update of source_call_id,source_call_eligibility_snapshot,source_call_eligibility_locked_at on public.contracts
for each row execute function public.protect_locked_contract_call_snapshot();

create or replace function public.prepare_contract_delivery_v2(
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
  p_personal_message text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_tenant uuid:=public.current_tenant_id(); v_user uuid:=auth.uid(); v_contract public.contracts%rowtype;
  v_doc public.contract_documents%rowtype; v_recipient uuid; v_request uuid; v_sms uuid; v_email uuid;
  v_delivery_email uuid; v_delivery_sms uuid; v_policy public.contract_reminder_policies%rowtype;
  v_source_type text; v_initial timestamptz:=now(); v_sequence integer:=0; v_generation integer;
  v_call public.calls%rowtype; v_snapshot jsonb; v_signature_policy jsonb; v_signature_method text;
begin
  if v_tenant is null or v_user is null then raise exception 'authentication_required'; end if;
  perform public.assert_contract_sendable_v2(p_contract_id,p_canonical_document_id,p_channel);
  if p_expires_at<=now() then raise exception 'acceptance_expiry_must_be_future'; end if;
  if nullif(trim(p_recipient_name),'') is null then raise exception 'recipient_name_required'; end if;
  if nullif(p_public_token_hash,'') is null or nullif(p_public_token_ciphertext,'') is null then raise exception 'acceptance_token_required'; end if;
  if p_channel in ('email','both') and (p_email is null or p_email_subject is null or p_email_text is null or p_email_html is null) then raise exception 'email_delivery_fields_required'; end if;
  if p_channel in ('sms','both') and (p_phone_e164 is null or p_sms_from is null or p_sms_body is null) then raise exception 'sms_delivery_fields_required'; end if;

  select * into v_contract from public.contracts where tenant_id=v_tenant and id=p_contract_id for update;
  select * into v_doc from public.contract_documents where tenant_id=v_tenant and id=p_canonical_document_id;
  if v_contract.source_call_id is null then raise exception 'source_call_required'; end if;
  select * into v_call from public.calls where tenant_id=v_tenant and id=v_contract.source_call_id;
  if not found then raise exception 'source_call_not_found'; end if;
  if not public.is_contract_call_eligible(v_tenant,v_contract.customer_id,v_contract.source_call_id,v_user) then
    raise exception 'source_call_not_eligible';
  end if;

  select coalesce(
      cv.signature_policy_snapshot,
      tv.signature_policy,
      '{"method":"simple_click","identityAssuranceLevel":"low","orderedSigning":false,"requireFinalProviderDocument":false}'::jsonb
    )
    into v_signature_policy
  from public.contract_versions cv
  left join public.contract_template_versions tv
    on tv.tenant_id=cv.tenant_id and tv.id=cv.template_version_id
  where cv.tenant_id=v_tenant and cv.id=v_contract.active_version_id
  for update of cv;
  if v_signature_policy is null then raise exception 'signature_policy_missing'; end if;
  v_signature_method:=coalesce(v_signature_policy->>'method','simple_click');
  if v_signature_method not in ('simple_click','sms_otp','email_otp','bankid','external_esign') then
    raise exception 'signature_policy_method_invalid:%',v_signature_method;
  end if;
  if v_signature_method in ('bankid','external_esign') then
    raise exception 'signature_policy_requires_external_signing_orchestration';
  end if;
  if v_signature_method='sms_otp' and p_channel not in ('sms','both') then
    raise exception 'sms_otp_requires_sms_delivery';
  end if;
  if v_signature_method='email_otp' and p_channel not in ('email','both') then
    raise exception 'email_otp_requires_email_delivery';
  end if;

  v_snapshot:=jsonb_build_object(
    'eligible',true,
    'callId',v_call.id,
    'customerId',v_call.customer_id,
    'listId',v_call.list_id,
    'userId',v_call.user_id,
    'disposition',v_call.disposition,
    'answeredAt',v_call.answered_at,
    'endedAt',v_call.ended_at,
    'invalidatedAt',v_call.invalidated_at,
    'capturedAt',v_initial,
    'policyVersion','contract-call-eligibility-v3'
  );
  if v_contract.source_call_eligibility_locked_at is null then
    update public.contracts
      set source_call_eligibility_snapshot=v_snapshot,
          source_call_eligibility_locked_at=v_initial
    where tenant_id=v_tenant and id=p_contract_id;
  elsif coalesce(v_contract.source_call_eligibility_snapshot->>'eligible','false')<>'true'
     or (v_contract.source_call_eligibility_snapshot->>'callId') is distinct from v_contract.source_call_id::text then
    raise exception 'source_call_snapshot_invalid';
  end if;

  select case when coalesce((v_call.metadata->>'registered_manually')::boolean,false) then 'external_manual_call'
              when v_call.dialer_session_id is not null then 'dialer_call' else 'manual_call' end
    into v_source_type;

  v_generation:=v_contract.acceptance_generation+1;

  update public.contract_acceptance_requests
    set status='superseded',superseded_at=v_initial
  where tenant_id=v_tenant and contract_id=p_contract_id and status='pending';
  for v_request in
    select id from public.contract_acceptance_requests
    where tenant_id=v_tenant and contract_id=p_contract_id and status='superseded' and superseded_at=v_initial
  loop
    perform public.cancel_contract_reminders(v_request,'superseded');
  end loop;

  update public.contract_recipients
    set required=false,
        status=case when status in ('signed','declined','expired','cancelled') then status else 'cancelled' end
  where tenant_id=v_tenant and contract_id=p_contract_id and required and generation<v_generation;

  insert into public.contract_recipients(tenant_id,contract_id,full_name,email,phone_e164,required,generation)
  values(v_tenant,p_contract_id,trim(p_recipient_name),nullif(lower(trim(p_email)),''),nullif(trim(p_phone_e164),''),true,v_generation)
  returning id into v_recipient;

  insert into public.contract_acceptance_requests(
    tenant_id,contract_id,contract_version_id,recipient_id,public_token_hash,public_token_ciphertext,
    acceptance_code,require_code,method,status,expires_at,call_id,call_ended_at,canonical_document_id,canonical_document_sha256,generation
  ) values(
    v_tenant,p_contract_id,v_contract.active_version_id,v_recipient,p_public_token_hash,p_public_token_ciphertext,
    p_acceptance_code,(v_signature_method in ('sms_otp','email_otp') or p_channel in ('sms','both')),
    case when v_signature_method='sms_otp' then 'sms_otp'::public.acceptance_method
         when v_signature_method='email_otp' then 'email_otp'::public.acceptance_method
         when p_channel in ('sms','both') then 'sms'::public.acceptance_method
         else 'web'::public.acceptance_method end,
    'pending',p_expires_at,v_contract.source_call_id,v_call.ended_at,v_doc.id,v_doc.sha256,v_generation
  ) returning id into v_request;

  update public.contract_versions
  set locked_at=coalesce(locked_at,v_initial),
      snapshot_hash=coalesce(snapshot_hash,document_hash),
      signature_policy_snapshot=coalesce(signature_policy_snapshot,v_signature_policy)
  where tenant_id=v_tenant and id=v_contract.active_version_id;

  if p_channel in ('email','both') then
    insert into public.email_messages(
      tenant_id,customer_id,contract_id,direction,from_address,to_addresses,reply_to_addresses,subject,body_text,body_html,
      status,attachments,created_by,idempotency_key,purpose
    ) values(
      v_tenant,v_contract.customer_id,p_contract_id,'outbound',coalesce(nullif(p_email_from,''),'pending@kundexa.local'),array[lower(trim(p_email))]::citext[],
      case when nullif(trim(p_reply_to),'') is null then '{}'::citext[] else array[lower(trim(p_reply_to))]::citext[] end,
      p_email_subject,p_email_text,p_email_html,'queued',coalesce(p_email_attachments,'[]'::jsonb),v_user,
      'contract-initial/'||v_request::text||'/email','contract_delivery'
    ) returning id into v_email;
    insert into public.contract_deliveries(
      tenant_id,contract_id,contract_version_id,recipient_id,acceptance_request_id,channel,status,email_message_id,
      delivery_kind,attempt_number,canonical_document_id,canonical_document_sha256,idempotency_key,scheduled_at
    ) values(
      v_tenant,p_contract_id,v_contract.active_version_id,v_recipient,v_request,'email','queued',v_email,
      'initial',1,v_doc.id,v_doc.sha256,'contract-initial/'||v_request::text||'/email',v_initial
    ) returning id into v_delivery_email;
    insert into public.outbox_jobs(tenant_id,job_type,aggregate_type,aggregate_id,payload,idempotency_key)
    values(v_tenant,'email.send','email_message',v_email,jsonb_build_object('email_message_id',v_email,'acceptance_request_id',v_request,'delivery_id',v_delivery_email),
      'contract-initial/'||v_request::text||'/email') on conflict(tenant_id,idempotency_key) do nothing;
  end if;

  if p_channel in ('sms','both') then
    insert into public.sms_messages(
      tenant_id,customer_id,contract_id,direction,from_number,to_number,body,status,created_by,idempotency_key,purpose
    ) values(
      v_tenant,v_contract.customer_id,p_contract_id,'outbound',p_sms_from,p_phone_e164,p_sms_body,'queued',v_user,
      'contract-initial/'||v_request::text||'/sms','contract_delivery'
    ) returning id into v_sms;
    insert into public.contract_deliveries(
      tenant_id,contract_id,contract_version_id,recipient_id,acceptance_request_id,channel,status,sms_message_id,
      delivery_kind,attempt_number,canonical_document_id,canonical_document_sha256,idempotency_key,scheduled_at
    ) values(
      v_tenant,p_contract_id,v_contract.active_version_id,v_recipient,v_request,'sms','queued',v_sms,
      'initial',1,v_doc.id,v_doc.sha256,'contract-initial/'||v_request::text||'/sms',v_initial
    ) returning id into v_delivery_sms;
    insert into public.outbox_jobs(tenant_id,job_type,aggregate_type,aggregate_id,payload,idempotency_key)
    values(v_tenant,'sms.send','sms_message',v_sms,jsonb_build_object('sms_message_id',v_sms,'acceptance_request_id',v_request,'delivery_id',v_delivery_sms),
      'contract-initial/'||v_request::text||'/sms') on conflict(tenant_id,idempotency_key) do nothing;
  end if;

  select * into v_policy from public.contract_reminder_policies where tenant_id=v_tenant;
  if found and v_policy.enabled and v_policy.max_automatic_reminders>0 then
    v_sequence:=1;
    insert into public.contract_reminders(tenant_id,contract_id,contract_version_id,acceptance_request_id,recipient_id,sequence_number,channel,kind,scheduled_at,created_by,personal_message,attach_pdf,idempotency_key)
    values(v_tenant,p_contract_id,v_contract.active_version_id,v_request,v_recipient,v_sequence,
      case when p_channel='both' then v_policy.default_channel else p_channel end,'automatic',v_initial+make_interval(hours=>v_policy.first_reminder_after_hours),v_user,p_personal_message,v_policy.attach_pdf,
      'contract-reminder/'||v_request::text||'/1/'||(case when p_channel='both' then v_policy.default_channel else p_channel end))
    on conflict do nothing;
    if v_policy.max_automatic_reminders>=2 then
      v_sequence:=2;
      insert into public.contract_reminders(tenant_id,contract_id,contract_version_id,acceptance_request_id,recipient_id,sequence_number,channel,kind,scheduled_at,created_by,personal_message,attach_pdf,idempotency_key)
      values(v_tenant,p_contract_id,v_contract.active_version_id,v_request,v_recipient,v_sequence,
        case when p_channel='both' then v_policy.default_channel else p_channel end,'automatic',v_initial+make_interval(hours=>v_policy.second_reminder_after_hours),v_user,p_personal_message,v_policy.attach_pdf,
        'contract-reminder/'||v_request::text||'/2/'||(case when p_channel='both' then v_policy.default_channel else p_channel end))
      on conflict do nothing;
    end if;
    if v_policy.max_automatic_reminders>=3 and p_expires_at-v_initial>make_interval(hours=>v_policy.final_reminder_before_expiry_hours) then
      v_sequence:=3;
      insert into public.contract_reminders(tenant_id,contract_id,contract_version_id,acceptance_request_id,recipient_id,sequence_number,channel,kind,scheduled_at,created_by,personal_message,attach_pdf,idempotency_key)
      values(v_tenant,p_contract_id,v_contract.active_version_id,v_request,v_recipient,v_sequence,
        case when p_channel='both' then v_policy.default_channel else p_channel end,'automatic',p_expires_at-make_interval(hours=>v_policy.final_reminder_before_expiry_hours),v_user,p_personal_message,v_policy.attach_pdf,
        'contract-reminder/'||v_request::text||'/3/'||(case when p_channel='both' then v_policy.default_channel else p_channel end))
      on conflict do nothing;
    end if;
  end if;

  update public.contracts set status='sent',source_type=coalesce(source_type,v_source_type),send_block_reason=null,
    prepared_at=coalesce(prepared_at,v_initial),first_sent_at=coalesce(first_sent_at,v_initial),last_sent_at=v_initial,
    expires_at=p_expires_at,acceptance_generation=v_generation
  where tenant_id=v_tenant and id=p_contract_id;

  insert into public.contract_events(tenant_id,contract_id,event_type,actor_user_id,payload)
  values(v_tenant,p_contract_id,'contract.sent',v_user,jsonb_build_object(
    'channel',p_channel,'request_id',v_request,'generation',v_generation,'source_call_id',v_contract.source_call_id,
    'canonical_document_id',v_doc.id,'canonical_document_sha256',v_doc.sha256,'source_call_eligibility_snapshot',v_snapshot,
    'signature_policy',v_signature_policy));
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
  values(v_tenant,v_user,'contract.sent','contract',p_contract_id::text,jsonb_build_object(
    'channel',p_channel,'request_id',v_request,'generation',v_generation,'source_call_id',v_contract.source_call_id,'canonical_document_id',v_doc.id));
  return jsonb_build_object('acceptance_request_id',v_request,'generation',v_generation,'email_delivery_id',v_delivery_email,'sms_delivery_id',v_delivery_sms,'canonical_document_id',v_doc.id);
end $$;

create or replace function public.record_contract_acceptance_v3(
  p_request_id uuid,
  p_method public.acceptance_method,
  p_status public.acceptance_status,
  p_raw_response text default null,
  p_normalized_response text default null,
  p_acceptance_phrase text default null,
  p_acceptance_code text default null,
  p_ip_address inet default null,
  p_user_agent text default null,
  p_provider_message_id text default null,
  p_acceptance_text text default null,
  p_evidence jsonb default '{}'::jsonb
) returns uuid language plpgsql security definer set search_path=public as $$
declare
  v_request public.contract_acceptance_requests%rowtype;
  v_contract public.contracts%rowtype;
  v_recipient public.contract_recipients%rowtype;
  v_version public.contract_versions%rowtype;
  v_acceptance uuid;
  v_now timestamptz:=now();
  v_required_remaining integer;
  v_signature_policy jsonb;
  v_signature_method text;
begin
  if auth.role()<>'service_role' then raise exception 'service_role_required'; end if;
  if p_status not in ('accepted_via_sms','accepted_via_web','declined','manual_review_required') then raise exception 'invalid_acceptance_decision'; end if;

  select * into v_request from public.contract_acceptance_requests where id=p_request_id for update;
  if not found then raise exception 'acceptance_request_not_found'; end if;
  select * into v_contract from public.contracts where tenant_id=v_request.tenant_id and id=v_request.contract_id for update;
  if not found then raise exception 'contract_not_found'; end if;
  select * into v_version from public.contract_versions
    where tenant_id=v_request.tenant_id and id=v_request.contract_version_id and contract_id=v_request.contract_id;
  if not found or v_contract.active_version_id is distinct from v_request.contract_version_id then
    raise exception 'acceptance_request_contract_version_not_current';
  end if;
  select * into v_recipient from public.contract_recipients
    where tenant_id=v_request.tenant_id and id=v_request.recipient_id and contract_id=v_request.contract_id for update;
  if not found then raise exception 'acceptance_recipient_not_found'; end if;

  select id into v_acceptance from public.contract_acceptances where tenant_id=v_request.tenant_id and request_id=v_request.id;
  if v_acceptance is not null then return v_acceptance; end if;
  if v_request.status<>'pending' then raise exception 'acceptance_request_not_pending:%',v_request.status; end if;
  if v_request.generation<>v_contract.acceptance_generation or v_recipient.generation<>v_contract.acceptance_generation then
    raise exception 'acceptance_request_superseded_generation';
  end if;
  if not v_recipient.required or v_recipient.status in ('signed','declined','expired','cancelled') then
    raise exception 'acceptance_recipient_not_current_required';
  end if;
  if v_request.expires_at<=v_now then
    update public.contract_acceptance_requests set status='expired' where id=v_request.id;
    update public.contract_recipients set status='expired',expired_at=v_now where tenant_id=v_request.tenant_id and id=v_request.recipient_id and status not in ('signed','declined','cancelled');
    perform public.cancel_contract_reminders(v_request.id,'expired');
    if not exists(select 1 from public.contract_acceptance_requests r where r.tenant_id=v_request.tenant_id and r.contract_id=v_request.contract_id and r.status='pending' and r.generation=v_contract.acceptance_generation) then
      update public.contracts set status='expired' where tenant_id=v_request.tenant_id and id=v_request.contract_id and status not in ('accepted','signed','active');
    end if;
    raise exception 'acceptance_request_expired';
  end if;
  if v_request.canonical_document_id is null or v_request.canonical_document_sha256 is null then raise exception 'acceptance_request_document_binding_missing'; end if;
  if not exists(
    select 1 from public.contract_documents d
    where d.tenant_id=v_request.tenant_id and d.id=v_request.canonical_document_id
      and d.contract_id=v_request.contract_id and d.contract_version_id=v_request.contract_version_id
      and d.mime_type='application/pdf' and d.sha256=v_request.canonical_document_sha256
  ) then raise exception 'acceptance_request_document_binding_invalid'; end if;
  if v_contract.source_call_id is null
     or coalesce(v_contract.source_call_eligibility_snapshot->>'eligible','false')<>'true'
     or (v_contract.source_call_eligibility_snapshot->>'callId') is distinct from v_contract.source_call_id::text
     or v_contract.source_call_eligibility_locked_at is null then
    raise exception 'source_call_snapshot_missing_or_invalid';
  end if;

  v_signature_policy:=coalesce(
    v_version.signature_policy_snapshot,
    '{"method":"simple_click","identityAssuranceLevel":"low","orderedSigning":false,"requireFinalProviderDocument":false}'::jsonb
  );
  v_signature_method:=coalesce(v_signature_policy->>'method','simple_click');
  if coalesce((v_signature_policy->>'requireFinalProviderDocument')::boolean,false)
     or v_signature_method in ('bankid','external_esign') then
    raise exception 'signature_policy_requires_external_signing';
  end if;
  if p_status in ('accepted_via_sms','accepted_via_web') then
    if v_signature_method='simple_click' and p_method not in ('web','sms') then raise exception 'acceptance_method_not_permitted_by_signature_policy'; end if;
    if v_signature_method='sms_otp' and p_method<>'sms_otp' then raise exception 'sms_otp_required_by_signature_policy'; end if;
    if v_signature_method='email_otp' and p_method<>'email_otp' then raise exception 'email_otp_required_by_signature_policy'; end if;
  end if;
  if p_status in ('accepted_via_sms','accepted_via_web') and v_request.require_code then
    if nullif(trim(coalesce(p_acceptance_code,'')),'') is null then raise exception 'acceptance_code_required'; end if;
    if upper(trim(p_acceptance_code)) is distinct from upper(trim(coalesce(v_request.acceptance_code,''))) then raise exception 'acceptance_code_invalid'; end if;
  end if;

  insert into public.contract_acceptances(
    tenant_id,request_id,contract_id,contract_version_id,recipient_id,method,status,raw_response,normalized_response,
    acceptance_phrase,acceptance_code,ip_address,user_agent,provider_message_id,evidence,accepted_at,
    canonical_document_id,canonical_document_sha256,source_call_id,acceptance_text
  ) values(
    v_request.tenant_id,v_request.id,v_request.contract_id,v_request.contract_version_id,v_request.recipient_id,p_method,p_status,p_raw_response,p_normalized_response,
    p_acceptance_phrase,case when p_acceptance_code is null then null else '[verified]' end,p_ip_address,p_user_agent,p_provider_message_id,
    coalesce(p_evidence,'{}'::jsonb)||jsonb_build_object(
      'generation',v_request.generation,
      'source_call_eligibility_snapshot',v_contract.source_call_eligibility_snapshot,
      'signature_policy',v_signature_policy,
      'acceptance_code_verified',v_request.require_code and p_status in ('accepted_via_sms','accepted_via_web')
    ),
    case when p_status in ('accepted_via_sms','accepted_via_web') then v_now else null end,
    v_request.canonical_document_id,v_request.canonical_document_sha256,v_contract.source_call_id,p_acceptance_text
  ) returning id into v_acceptance;

  update public.contract_acceptance_requests set status=p_status,
    accepted_at=case when p_status in ('accepted_via_sms','accepted_via_web') then v_now else null end,
    declined_at=case when p_status='declined' then v_now else null end
  where id=v_request.id;
  if p_status in ('accepted_via_sms','accepted_via_web','declined') then
    perform public.cancel_contract_reminders(v_request.id,case when p_status='declined' then 'declined' else 'accepted' end);
  end if;

  insert into public.audit_logs(tenant_id,action,entity_type,entity_id,after_data)
  values(v_request.tenant_id,'contract.acceptance_recorded','contract_acceptance',v_acceptance::text,
    jsonb_build_object('contract_id',v_request.contract_id,'request_id',v_request.id,'recipient_id',v_request.recipient_id,
      'generation',v_request.generation,'method',p_method,'status',p_status,'signature_method',v_signature_method,
      'acceptance_code_verified',v_request.require_code and p_status in ('accepted_via_sms','accepted_via_web')));

  if p_status in ('accepted_via_sms','accepted_via_web') then
    select count(*)::integer into v_required_remaining
    from public.contract_recipients r
    where r.tenant_id=v_request.tenant_id and r.contract_id=v_request.contract_id
      and r.generation=v_contract.acceptance_generation and r.required and r.status<>'signed';
    if v_required_remaining=0 then
      update public.contracts set status='accepted',accepted_at=coalesce(accepted_at,v_now)
      where tenant_id=v_request.tenant_id and id=v_request.contract_id;
    else
      update public.contracts set status='signing'
      where tenant_id=v_request.tenant_id and id=v_request.contract_id and status not in ('signed','active');
    end if;
    insert into public.contract_events(tenant_id,contract_id,event_type,payload)
    values(v_request.tenant_id,v_request.contract_id,'contract.'||p_status::text,jsonb_build_object(
      'accepted_at',v_now,'request_id',v_request.id,'acceptance_id',v_acceptance,'generation',v_request.generation,
      'canonical_document_id',v_request.canonical_document_id,'source_call_id',v_contract.source_call_id,
      'signature_policy',v_signature_policy));
    insert into public.outbox_jobs(tenant_id,job_type,aggregate_type,aggregate_id,payload,idempotency_key,priority)
    values(v_request.tenant_id,'evidence.generate','contract',v_request.contract_id,jsonb_build_object('contract_id',v_request.contract_id,'acceptance_request_id',v_request.id,'acceptance_id',v_acceptance),'evidence.generate:'||v_request.id::text,20)
    on conflict(tenant_id,idempotency_key) do nothing;
    insert into public.outbox_jobs(tenant_id,job_type,aggregate_type,aggregate_id,payload,idempotency_key,priority)
    values(v_request.tenant_id,'contract.confirmation','contract',v_request.contract_id,jsonb_build_object('contract_id',v_request.contract_id,'request_id',v_request.id,'acceptance_id',v_acceptance),'contract.confirmation:'||v_request.id::text,30)
    on conflict(tenant_id,idempotency_key) do nothing;
  elsif p_status='declined' then
    update public.contracts set status='declined' where tenant_id=v_request.tenant_id and id=v_request.contract_id;
    insert into public.contract_events(tenant_id,contract_id,event_type,payload)
    values(v_request.tenant_id,v_request.contract_id,'contract.declined',jsonb_build_object('request_id',v_request.id,'acceptance_id',v_acceptance,'generation',v_request.generation));
  end if;
  return v_acceptance;
end $$;

-- Keep old internal callers safe by routing them through the v3 reducer.
create or replace function public.record_contract_acceptance_v2(
  p_request_id uuid,
  p_method public.acceptance_method,
  p_status public.acceptance_status,
  p_raw_response text default null,
  p_normalized_response text default null,
  p_acceptance_phrase text default null,
  p_acceptance_code text default null,
  p_ip_address inet default null,
  p_user_agent text default null,
  p_provider_message_id text default null,
  p_acceptance_text text default null,
  p_evidence jsonb default '{}'::jsonb
) returns uuid language sql security definer set search_path=public as $$
  select public.record_contract_acceptance_v3(
    p_request_id,p_method,p_status,p_raw_response,p_normalized_response,p_acceptance_phrase,p_acceptance_code,
    p_ip_address,p_user_agent,p_provider_message_id,p_acceptance_text,p_evidence
  )
$$;

create or replace function public.activate_completed_contract(p_contract_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_tenant uuid:=public.current_tenant_id();
  v_user uuid:=auth.uid();
  v_contract public.contracts%rowtype;
  v_version public.contract_versions%rowtype;
  v_policy jsonb;
  v_method text;
  v_now timestamptz:=now();
  v_final_document uuid;
begin
  if v_tenant is null or v_user is null then raise exception 'authentication_required'; end if;
  if not public.has_current_role(array['owner','admin','contract_manager']) then raise exception 'contract_activate_permission_required'; end if;
  select * into v_contract from public.contracts where tenant_id=v_tenant and id=p_contract_id for update;
  if not found then raise exception 'contract_not_found'; end if;
  if not public.can_access_contract(v_contract.id) then raise exception 'contract_access_denied'; end if;
  if v_contract.status='active' then return jsonb_build_object('contract_id',v_contract.id,'status','active','already_active',true); end if;
  if v_contract.status not in ('accepted','signed') then raise exception 'contract_not_completed:%',v_contract.status; end if;
  select * into v_version from public.contract_versions where tenant_id=v_tenant and id=v_contract.active_version_id and contract_id=v_contract.id;
  if not found or v_version.locked_at is null then raise exception 'locked_contract_version_required'; end if;
  v_policy:=coalesce(v_version.signature_policy_snapshot,'{"method":"simple_click","identityAssuranceLevel":"low","orderedSigning":false,"requireFinalProviderDocument":false}'::jsonb);
  v_method:=coalesce(v_policy->>'method','simple_click');

  if exists(
    select 1 from public.contract_recipients r
    where r.tenant_id=v_tenant and r.contract_id=v_contract.id and r.generation=v_contract.acceptance_generation
      and r.required and r.status<>'signed'
  ) then raise exception 'required_contract_recipients_incomplete'; end if;

  if not exists(
    select 1 from public.evidence_packages e
    where e.tenant_id=v_tenant and e.contract_id=v_contract.id and e.contract_version_id=v_contract.active_version_id
      and e.status='completed'
  ) then raise exception 'completed_evidence_package_required'; end if;

  if coalesce((v_policy->>'requireFinalProviderDocument')::boolean,false) or v_method in ('bankid','external_esign') then
    select e.final_document_id into v_final_document
    from public.signing_envelopes e
    where e.tenant_id=v_tenant and e.contract_id=v_contract.id and e.contract_version_id=v_contract.active_version_id
      and e.generation=v_contract.acceptance_generation and e.status='completed' and e.final_document_id is not null
    order by e.completed_at desc nulls last limit 1;
    if v_final_document is null then raise exception 'completed_current_signing_envelope_required'; end if;
    if not exists(
      select 1 from public.contract_documents d
      where d.tenant_id=v_tenant and d.id=v_final_document and d.contract_id=v_contract.id
        and d.contract_version_id=v_contract.active_version_id and d.document_type='signed_pdf'
        and d.mime_type='application/pdf' and nullif(d.sha256,'') is not null
    ) then raise exception 'final_signed_document_hash_required'; end if;
    if exists(
      select 1 from public.signing_events se join public.signing_envelopes e on e.tenant_id=se.tenant_id and e.id=se.envelope_id
      where e.tenant_id=v_tenant and e.contract_id=v_contract.id and e.generation=v_contract.acceptance_generation
        and se.processing_status<>'ignored' and (not se.verified or se.processing_status<>'processed')
    ) then raise exception 'unresolved_signing_events_present'; end if;
  end if;

  update public.contracts set status='active',activated_at=coalesce(activated_at,v_now),updated_at=v_now
    where tenant_id=v_tenant and id=v_contract.id;
  update public.customers set lifecycle='customer',updated_at=v_now
    where tenant_id=v_tenant and id=v_contract.customer_id and lifecycle in ('prospect','lead');
  insert into public.contract_events(tenant_id,contract_id,event_type,actor_user_id,payload)
  values(v_tenant,v_contract.id,'contract.activated',v_user,jsonb_build_object('activated_at',v_now,'generation',v_contract.acceptance_generation,'signature_policy',v_policy,'final_document_id',v_final_document));
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
  values(v_tenant,v_user,'contract.activated','contract',v_contract.id::text,jsonb_build_object('activated_at',v_now,'generation',v_contract.acceptance_generation,'signature_method',v_method,'final_document_id',v_final_document));
  return jsonb_build_object('contract_id',v_contract.id,'status','active','activated_at',v_now);
end $$;

revoke all on function public.activate_completed_contract(uuid) from public,anon;
grant execute on function public.activate_completed_contract(uuid) to authenticated,service_role;

revoke all on function public.record_contract_acceptance_v3(uuid,public.acceptance_method,public.acceptance_status,text,text,text,text,inet,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.record_contract_acceptance_v3(uuid,public.acceptance_method,public.acceptance_status,text,text,text,text,inet,text,text,text,jsonb) to service_role;

revoke all on function public.record_contract_acceptance_v2(uuid,public.acceptance_method,public.acceptance_status,text,text,text,text,inet,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.record_contract_acceptance_v2(uuid,public.acceptance_method,public.acceptance_status,text,text,text,text,inet,text,text,text,jsonb) to service_role;

commit;
