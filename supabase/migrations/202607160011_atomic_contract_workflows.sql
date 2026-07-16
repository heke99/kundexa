begin;

alter table public.contracts
  add column if not exists sales_channel text not null default 'other'
    check (sales_channel in ('telephone','web','email','in_person','partner','api','other')),
  add column if not exists accepted_at timestamptz,
  add column if not exists activated_at timestamptz;

-- Complete the high-risk tenant-composite foreign-key chain.
create unique index if not exists contract_versions_tenant_id_id_uidx on public.contract_versions(tenant_id,id);
create unique index if not exists deals_tenant_id_id_uidx on public.deals(tenant_id,id);

alter table public.contracts drop constraint if exists contracts_active_version_tenant_fk;
alter table public.contracts add constraint contracts_active_version_tenant_fk
  foreign key (tenant_id,active_version_id) references public.contract_versions(tenant_id,id)
  deferrable initially deferred;

alter table public.sms_messages drop constraint if exists sms_messages_contract_tenant_fk;
alter table public.sms_messages add constraint sms_messages_contract_tenant_fk
  foreign key (tenant_id,contract_id) references public.contracts(tenant_id,id) on delete restrict;

alter table public.email_messages drop constraint if exists email_messages_customer_tenant_fk;
alter table public.email_messages add constraint email_messages_customer_tenant_fk
  foreign key (tenant_id,customer_id) references public.customers(tenant_id,id) on delete restrict;
alter table public.email_messages drop constraint if exists email_messages_contract_tenant_fk;
alter table public.email_messages add constraint email_messages_contract_tenant_fk
  foreign key (tenant_id,contract_id) references public.contracts(tenant_id,id) on delete restrict;

alter table public.activities drop constraint if exists activities_deal_tenant_fk;
alter table public.activities add constraint activities_deal_tenant_fk
  foreign key (tenant_id,deal_id) references public.deals(tenant_id,id) on delete cascade;
alter table public.activities drop constraint if exists activities_contract_tenant_fk;
alter table public.activities add constraint activities_contract_tenant_fk
  foreign key (tenant_id,contract_id) references public.contracts(tenant_id,id) on delete cascade;

-- Create the contract and immutable first version in one transaction.
create or replace function public.create_contract_draft(
  p_contract_number text,
  p_customer_id uuid,
  p_product_id uuid,
  p_price_version_id uuid,
  p_title text,
  p_rendered_body text,
  p_rendered_terms text,
  p_commercial_terms jsonb,
  p_document_hash text,
  p_sales_channel text default 'other'
)
returns uuid
language plpgsql security definer set search_path=public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_user uuid := auth.uid();
  v_contract uuid;
  v_version uuid;
  v_customer_type public.customer_type;
  v_audience text;
  v_value numeric := coalesce((p_commercial_terms->>'recurring_fee')::numeric,0);
begin
  if v_user is null or v_tenant is null then raise exception 'authentication_required'; end if;
  if not public.can_write_customer(p_customer_id) then raise exception 'customer_write_permission_required'; end if;
  if p_sales_channel not in ('telephone','web','email','in_person','partner','api','other') then raise exception 'invalid_sales_channel'; end if;

  select customer_type into v_customer_type
  from public.customers
  where tenant_id=v_tenant and id=p_customer_id and deleted_at is null;
  if not found then raise exception 'customer_not_found'; end if;
  v_audience := case when v_customer_type='person' then 'B2C' else 'B2B' end;

  if p_product_id is not null and not exists(select 1 from public.products where tenant_id=v_tenant and id=p_product_id and active) then
    raise exception 'product_not_found';
  end if;
  if p_price_version_id is not null and not exists(
    select 1 from public.product_price_versions
    where tenant_id=v_tenant and id=p_price_version_id and (p_product_id is null or product_id=p_product_id)
  ) then raise exception 'price_version_not_found'; end if;

  insert into public.contracts(
    tenant_id,contract_number,customer_id,product_id,owner_user_id,audience,status,title,value,currency,
    binding_months,notice_months,sales_channel
  ) values (
    v_tenant,p_contract_number,p_customer_id,p_product_id,v_user,v_audience,'draft',p_title,v_value,
    coalesce(p_commercial_terms->>'currency','SEK'),
    nullif(p_commercial_terms->>'binding_months','')::integer,
    nullif(p_commercial_terms->>'notice_months','')::integer,
    p_sales_channel
  ) returning id into v_contract;

  insert into public.contract_versions(
    tenant_id,contract_id,version,price_version_id,title,rendered_body,rendered_terms,commercial_terms,document_hash,created_by
  ) values (
    v_tenant,v_contract,1,p_price_version_id,p_title,p_rendered_body,p_rendered_terms,
    coalesce(p_commercial_terms,'{}'::jsonb),p_document_hash,v_user
  ) returning id into v_version;

  update public.contracts set active_version_id=v_version,status='ready' where tenant_id=v_tenant and id=v_contract;
  insert into public.contract_events(tenant_id,contract_id,event_type,actor_user_id,payload)
    values(v_tenant,v_contract,'contract.created',v_user,jsonb_build_object('version',1,'sales_channel',p_sales_channel));
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
    values(v_tenant,v_user,'contract.created','contract',v_contract::text,jsonb_build_object('contract_number',p_contract_number,'version_id',v_version));
  return v_contract;
end
$$;

-- Prepare recipient, acceptance request, messages, outbox jobs and delivery atomically.
create or replace function public.prepare_contract_delivery(
  p_contract_id uuid,
  p_channel text,
  p_recipient_name text,
  p_email text,
  p_phone_e164 text,
  p_public_token_hash text,
  p_acceptance_code text,
  p_expires_at timestamptz,
  p_call_id uuid,
  p_call_ended_at timestamptz,
  p_sms_from text,
  p_sms_body text,
  p_email_from text,
  p_email_subject text,
  p_email_body text
)
returns uuid
language plpgsql security definer set search_path=public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_user uuid := auth.uid();
  v_contract public.contracts%rowtype;
  v_recipient uuid;
  v_request uuid;
  v_sms uuid;
  v_email uuid;
begin
  if v_user is null or v_tenant is null then raise exception 'authentication_required'; end if;
  if p_channel not in ('sms','email','both') then raise exception 'invalid_delivery_channel'; end if;

  select * into v_contract from public.contracts
  where tenant_id=v_tenant and id=p_contract_id
  for update;
  if not found then raise exception 'contract_not_found'; end if;
  if not public.can_write_contract(v_contract.id,v_contract.customer_id) then raise exception 'contract_send_permission_required'; end if;
  if v_contract.active_version_id is null then raise exception 'active_contract_version_required'; end if;
  if v_contract.status not in ('ready','sent','delivered','opened') then raise exception 'contract_not_sendable:%',v_contract.status; end if;
  if p_expires_at <= now() then raise exception 'acceptance_expiry_must_be_future'; end if;
  if p_channel in ('sms','both') and (p_phone_e164 is null or p_sms_from is null or p_sms_body is null) then raise exception 'sms_delivery_fields_required'; end if;
  if p_channel in ('email','both') and (p_email is null or p_email_subject is null or p_email_body is null) then raise exception 'email_delivery_fields_required'; end if;
  if v_contract.audience='B2C' and v_contract.sales_channel='telephone' and p_call_ended_at is null then
    raise exception 'b2c_telephone_call_must_end_before_acceptance_request';
  end if;

  update public.contract_acceptance_requests
    set status='superseded'
    where tenant_id=v_tenant and contract_id=p_contract_id and status='pending';

  insert into public.contract_recipients(tenant_id,contract_id,full_name,email,phone_e164)
    values(v_tenant,p_contract_id,p_recipient_name,p_email,p_phone_e164)
    returning id into v_recipient;

  insert into public.contract_acceptance_requests(
    tenant_id,contract_id,contract_version_id,recipient_id,public_token_hash,acceptance_code,require_code,method,
    status,expires_at,call_id,call_ended_at
  ) values (
    v_tenant,p_contract_id,v_contract.active_version_id,v_recipient,p_public_token_hash,p_acceptance_code,
    p_channel in ('sms','both'),case when p_channel in ('sms','both') then 'sms'::public.acceptance_method else 'web'::public.acceptance_method end,
    'pending',p_expires_at,p_call_id,p_call_ended_at
  ) returning id into v_request;

  update public.contract_versions
    set locked_at=coalesce(locked_at,now())
    where tenant_id=v_tenant and id=v_contract.active_version_id;

  if p_channel in ('sms','both') then
    insert into public.sms_messages(
      tenant_id,customer_id,contract_id,direction,from_number,to_number,body,status,created_by
    ) values (
      v_tenant,v_contract.customer_id,p_contract_id,'outbound',p_sms_from,p_phone_e164,p_sms_body,'queued',v_user
    ) returning id into v_sms;
    insert into public.outbox_jobs(tenant_id,job_type,aggregate_type,aggregate_id,payload,idempotency_key)
      values(v_tenant,'sms.send','sms_message',v_sms,jsonb_build_object('sms_message_id',v_sms,'acceptance_request_id',v_request),'sms.send:'||v_sms::text);
  end if;

  if p_channel in ('email','both') then
    insert into public.email_messages(
      tenant_id,customer_id,contract_id,direction,from_address,to_addresses,subject,body_text,status,created_by
    ) values (
      v_tenant,v_contract.customer_id,p_contract_id,'outbound',coalesce(p_email_from,'pending@kundexa.local'),array[p_email]::citext[],p_email_subject,p_email_body,'queued',v_user
    ) returning id into v_email;
    insert into public.outbox_jobs(tenant_id,job_type,aggregate_type,aggregate_id,payload,idempotency_key)
      values(v_tenant,'email.send','email_message',v_email,jsonb_build_object('email_message_id',v_email,'acceptance_request_id',v_request),'email.send:'||v_email::text);
  end if;

  insert into public.contract_deliveries(
    tenant_id,contract_id,contract_version_id,recipient_id,channel,status,sms_message_id,email_message_id
  ) values (
    v_tenant,p_contract_id,v_contract.active_version_id,v_recipient,p_channel,'queued',v_sms,v_email
  );

  update public.contracts set status='sent' where tenant_id=v_tenant and id=p_contract_id;
  insert into public.contract_events(tenant_id,contract_id,event_type,actor_user_id,payload)
    values(v_tenant,p_contract_id,'contract.sent',v_user,jsonb_build_object('channel',p_channel,'request_id',v_request));
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
    values(v_tenant,v_user,'contract.sent','contract',p_contract_id::text,jsonb_build_object('channel',p_channel,'request_id',v_request));
  return v_request;
end
$$;

-- Single idempotent decision point for public web and provider SMS acceptances.
create or replace function public.record_contract_acceptance(
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
  p_evidence jsonb default '{}'::jsonb
)
returns uuid
language plpgsql security definer set search_path=public
as $$
declare
  v_request public.contract_acceptance_requests%rowtype;
  v_acceptance uuid;
  v_now timestamptz := now();
begin
  if p_status not in ('accepted_via_sms','accepted_via_web','declined','manual_review_required') then
    raise exception 'invalid_acceptance_decision';
  end if;

  select * into v_request from public.contract_acceptance_requests where id=p_request_id for update;
  if not found then raise exception 'acceptance_request_not_found'; end if;

  select id into v_acceptance from public.contract_acceptances
    where tenant_id=v_request.tenant_id and request_id=v_request.id;
  if v_acceptance is not null then return v_acceptance; end if;

  if v_request.status <> 'pending' then raise exception 'acceptance_request_not_pending:%',v_request.status; end if;
  if v_request.expires_at <= v_now then
    update public.contract_acceptance_requests set status='expired' where id=v_request.id;
    update public.contracts set status='expired' where tenant_id=v_request.tenant_id and id=v_request.contract_id and status not in ('accepted','signed','active');
    raise exception 'acceptance_request_expired';
  end if;

  insert into public.contract_acceptances(
    tenant_id,request_id,contract_id,contract_version_id,recipient_id,method,status,raw_response,
    normalized_response,acceptance_phrase,acceptance_code,ip_address,user_agent,provider_message_id,evidence,accepted_at
  ) values (
    v_request.tenant_id,v_request.id,v_request.contract_id,v_request.contract_version_id,v_request.recipient_id,p_method,p_status,p_raw_response,
    p_normalized_response,p_acceptance_phrase,p_acceptance_code,p_ip_address,p_user_agent,p_provider_message_id,coalesce(p_evidence,'{}'::jsonb),
    case when p_status in ('accepted_via_sms','accepted_via_web') then v_now else null end
  ) returning id into v_acceptance;

  update public.contract_acceptance_requests
    set status=p_status,accepted_at=case when p_status in ('accepted_via_sms','accepted_via_web') then v_now else null end
    where id=v_request.id;

  if p_status in ('accepted_via_sms','accepted_via_web') then
    update public.contracts set status='accepted',accepted_at=v_now where tenant_id=v_request.tenant_id and id=v_request.contract_id;
    insert into public.contract_events(tenant_id,contract_id,event_type,payload)
      values(v_request.tenant_id,v_request.contract_id,'contract.'||p_status::text,jsonb_build_object('accepted_at',v_now,'request_id',v_request.id,'acceptance_id',v_acceptance));
    insert into public.outbox_jobs(tenant_id,job_type,aggregate_type,aggregate_id,payload,idempotency_key,priority)
      values(v_request.tenant_id,'evidence.generate','contract',v_request.contract_id,jsonb_build_object('contract_id',v_request.contract_id,'acceptance_request_id',v_request.id,'acceptance_id',v_acceptance),'evidence.generate:'||v_request.id::text,20)
      on conflict(tenant_id,idempotency_key) do nothing;
    insert into public.outbox_jobs(tenant_id,job_type,aggregate_type,aggregate_id,payload,idempotency_key,priority)
      values(v_request.tenant_id,'contract.confirmation','contract',v_request.contract_id,jsonb_build_object('contract_id',v_request.contract_id,'request_id',v_request.id,'acceptance_id',v_acceptance),'contract.confirmation:'||v_request.id::text,30)
      on conflict(tenant_id,idempotency_key) do nothing;
  elsif p_status='declined' then
    update public.contracts set status='declined' where tenant_id=v_request.tenant_id and id=v_request.contract_id;
    insert into public.contract_events(tenant_id,contract_id,event_type,payload)
      values(v_request.tenant_id,v_request.contract_id,'contract.declined',jsonb_build_object('request_id',v_request.id,'acceptance_id',v_acceptance));
  else
    insert into public.contract_events(tenant_id,contract_id,event_type,payload)
      values(v_request.tenant_id,v_request.contract_id,'contract.acceptance_manual_review',jsonb_build_object('request_id',v_request.id,'acceptance_id',v_acceptance));
  end if;

  return v_acceptance;
end
$$;

revoke all on function public.create_contract_draft(text,uuid,uuid,uuid,text,text,text,jsonb,text,text) from public,anon;
revoke all on function public.prepare_contract_delivery(uuid,text,text,text,text,text,text,timestamptz,uuid,timestamptz,text,text,text,text,text) from public,anon;
revoke all on function public.record_contract_acceptance(uuid,public.acceptance_method,public.acceptance_status,text,text,text,text,inet,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.create_contract_draft(text,uuid,uuid,uuid,text,text,text,jsonb,text,text) to authenticated;
grant execute on function public.prepare_contract_delivery(uuid,text,text,text,text,text,text,timestamptz,uuid,timestamptz,text,text,text,text,text) to authenticated;
grant execute on function public.record_contract_acceptance(uuid,public.acceptance_method,public.acceptance_status,text,text,text,text,inet,text,text,jsonb) to service_role;

commit;
