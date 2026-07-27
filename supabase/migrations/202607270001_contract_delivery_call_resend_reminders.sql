begin;

update storage.buckets set file_size_limit=20971520 where id='contract-documents';

-- Canonical contract delivery completion: call provenance, immutable documents,
-- channel-specific deliveries, reusable encrypted tokens and reminder scheduling.

alter table public.product_price_versions
  add column if not exists payment_terms_days integer not null default 30 check(payment_terms_days between 0 and 365),
  add column if not exists terms jsonb not null default '{}'::jsonb;

alter table public.list_dispositions
  add column if not exists contract_eligible boolean not null default false;
update public.list_dispositions
set contract_eligible=true
where key in ('interested','contract','contract_requested','sale','sold','order');

alter table public.calls
  add column if not exists invalidated_at timestamptz,
  add column if not exists invalidated_reason text;

alter table public.contracts
  add column if not exists source_call_id uuid,
  add column if not exists source_type text,
  add column if not exists send_block_reason text,
  add column if not exists prepared_at timestamptz,
  add column if not exists first_sent_at timestamptz,
  add column if not exists last_sent_at timestamptz,
  add column if not exists expires_at timestamptz;

alter table public.contracts drop constraint if exists contracts_source_type_check;
alter table public.contracts add constraint contracts_source_type_check
  check(source_type is null or source_type in ('dialer_call','manual_call','external_manual_call','api_call'));
alter table public.contracts drop constraint if exists contracts_source_call_tenant_fk;
alter table public.contracts add constraint contracts_source_call_tenant_fk
  foreign key(tenant_id,source_call_id) references public.calls(tenant_id,id) on delete restrict;

alter table public.contract_versions
  add column if not exists snapshot_hash text;
update public.contract_versions set snapshot_hash=document_hash where snapshot_hash is null;

alter table public.contract_acceptance_requests
  add column if not exists public_token_ciphertext text,
  add column if not exists canonical_document_id uuid,
  add column if not exists canonical_document_sha256 text,
  add column if not exists declined_at timestamptz,
  add column if not exists cancelled_at timestamptz,
  add column if not exists superseded_at timestamptz;
alter table public.contract_acceptance_requests drop constraint if exists acceptance_requests_canonical_document_tenant_fk;
alter table public.contract_acceptance_requests add constraint acceptance_requests_canonical_document_tenant_fk
  foreign key(tenant_id,canonical_document_id) references public.contract_documents(tenant_id,id) on delete restrict;

alter table public.contract_acceptances
  add column if not exists canonical_document_id uuid,
  add column if not exists canonical_document_sha256 text,
  add column if not exists source_call_id uuid,
  add column if not exists acceptance_text text;
alter table public.contract_acceptances drop constraint if exists contract_acceptances_canonical_document_tenant_fk;
alter table public.contract_acceptances add constraint contract_acceptances_canonical_document_tenant_fk
  foreign key(tenant_id,canonical_document_id) references public.contract_documents(tenant_id,id) on delete restrict;
alter table public.contract_acceptances drop constraint if exists contract_acceptances_source_call_tenant_fk;
alter table public.contract_acceptances add constraint contract_acceptances_source_call_tenant_fk
  foreign key(tenant_id,source_call_id) references public.calls(tenant_id,id) on delete restrict;

alter table public.evidence_packages
  add column if not exists canonical_document_id uuid,
  add column if not exists canonical_document_sha256 text;
alter table public.evidence_packages drop constraint if exists evidence_packages_canonical_document_tenant_fk;
alter table public.evidence_packages add constraint evidence_packages_canonical_document_tenant_fk
  foreign key(tenant_id,canonical_document_id) references public.contract_documents(tenant_id,id) on delete restrict;

alter table public.contract_deliveries drop constraint if exists contract_deliveries_channel_check;
alter table public.contract_deliveries add constraint contract_deliveries_channel_check check(channel in ('sms','email'));
alter table public.contract_deliveries
  add column if not exists acceptance_request_id uuid,
  add column if not exists delivery_kind text not null default 'initial',
  add column if not exists attempt_number integer not null default 1,
  add column if not exists canonical_document_id uuid,
  add column if not exists canonical_document_sha256 text,
  add column if not exists failure_code text,
  add column if not exists failure_message text,
  add column if not exists provider_status text,
  add column if not exists scheduled_at timestamptz not null default now(),
  add column if not exists cancelled_at timestamptz;
alter table public.contract_deliveries drop constraint if exists contract_deliveries_delivery_kind_check;
alter table public.contract_deliveries add constraint contract_deliveries_delivery_kind_check check(delivery_kind in (
  'initial','automatic_reminder','manual_reminder','manual_resend','acceptance_confirmation','expiry_notice'
));
alter table public.contract_deliveries drop constraint if exists contract_deliveries_attempt_number_check;
alter table public.contract_deliveries add constraint contract_deliveries_attempt_number_check check(attempt_number between 1 and 100);
alter table public.contract_deliveries drop constraint if exists contract_deliveries_acceptance_request_tenant_fk;
alter table public.contract_deliveries add constraint contract_deliveries_acceptance_request_tenant_fk
  foreign key(tenant_id,acceptance_request_id) references public.contract_acceptance_requests(tenant_id,id) on delete restrict;
alter table public.contract_deliveries drop constraint if exists contract_deliveries_canonical_document_tenant_fk;
alter table public.contract_deliveries add constraint contract_deliveries_canonical_document_tenant_fk
  foreign key(tenant_id,canonical_document_id) references public.contract_documents(tenant_id,id) on delete restrict;

alter table public.email_messages
  add column if not exists reply_to_addresses citext[] not null default '{}',
  add column if not exists bcc_addresses citext[] not null default '{}',
  add column if not exists provider_status text,
  add column if not exists failure_code text,
  add column if not exists clicked_at timestamptz,
  add column if not exists delayed_at timestamptz,
  add column if not exists bounced_at timestamptz,
  add column if not exists complained_at timestamptz,
  add column if not exists suppressed_at timestamptz;

alter table public.contract_deliveries
  add column if not exists clicked_at timestamptz,
  add column if not exists delayed_at timestamptz,
  add column if not exists bounced_at timestamptz,
  add column if not exists complained_at timestamptz,
  add column if not exists suppressed_at timestamptz;

-- Nullable idempotency keys can still use a non-partial unique index (Postgres permits
-- multiple NULL values). This allows deterministic ON CONFLICT inference from workers.
drop index if exists public.email_messages_tenant_idempotency_uidx;
create unique index email_messages_tenant_idempotency_uidx
  on public.email_messages(tenant_id,idempotency_key);
drop index if exists public.sms_messages_tenant_idempotency_uidx;
create unique index sms_messages_tenant_idempotency_uidx
  on public.sms_messages(tenant_id,idempotency_key);
drop index if exists public.contract_deliveries_tenant_idempotency_uidx;
create unique index contract_deliveries_tenant_idempotency_uidx
  on public.contract_deliveries(tenant_id,idempotency_key);

create or replace function public.prevent_locked_contract_version_update() returns trigger
language plpgsql as $$
begin
  if old.locked_at is not null and row(
    new.title,new.rendered_body,new.rendered_terms,new.commercial_terms,new.document_hash,new.snapshot_hash
  ) is distinct from row(
    old.title,old.rendered_body,old.rendered_terms,old.commercial_terms,old.document_hash,old.snapshot_hash
  ) then
    raise exception 'locked_contract_version_is_immutable';
  end if;
  return new;
end $$;

alter table public.tenant_integrations drop constraint if exists tenant_integrations_status_check;
alter table public.tenant_integrations add constraint tenant_integrations_status_check
  check(status in ('inactive','pending','active','error','revoked'));

create table if not exists public.contract_reminder_policies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  enabled boolean not null default true,
  first_reminder_after_hours integer not null default 24 check(first_reminder_after_hours between 1 and 8760),
  second_reminder_after_hours integer not null default 72 check(second_reminder_after_hours between 1 and 8760),
  final_reminder_before_expiry_hours integer not null default 24 check(final_reminder_before_expiry_hours between 1 and 8760),
  max_automatic_reminders integer not null default 3 check(max_automatic_reminders between 0 and 10),
  default_channel text not null default 'email' check(default_channel in ('email','sms','both')),
  quiet_hours_start time not null default '20:00',
  quiet_hours_end time not null default '08:00',
  timezone text not null default 'Europe/Stockholm',
  attach_pdf boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(tenant_id), unique(tenant_id,id)
);

create table if not exists public.contract_reminders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  contract_id uuid not null,
  contract_version_id uuid not null,
  acceptance_request_id uuid not null,
  recipient_id uuid not null,
  sequence_number integer not null check(sequence_number between 1 and 100),
  channel text not null check(channel in ('email','sms','both')),
  kind text not null check(kind in ('automatic','manual')),
  status text not null default 'scheduled' check(status in ('scheduled','queued','sent','cancelled','failed','skipped')),
  scheduled_at timestamptz not null,
  sent_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  email_message_id uuid,
  sms_message_id uuid,
  created_by uuid references auth.users(id) on delete set null,
  personal_message text,
  attach_pdf boolean not null default true,
  idempotency_key text,
  created_at timestamptz not null default now(),
  unique(tenant_id,id),
  foreign key(tenant_id,contract_id) references public.contracts(tenant_id,id) on delete cascade,
  foreign key(tenant_id,contract_version_id) references public.contract_versions(tenant_id,id) on delete restrict,
  foreign key(tenant_id,acceptance_request_id) references public.contract_acceptance_requests(tenant_id,id) on delete cascade,
  foreign key(tenant_id,recipient_id) references public.contract_recipients(tenant_id,id) on delete restrict,
  foreign key(tenant_id,email_message_id) references public.email_messages(tenant_id,id) on delete set null,
  foreign key(tenant_id,sms_message_id) references public.sms_messages(tenant_id,id) on delete set null
);
create unique index if not exists contract_reminders_auto_sequence_uidx
  on public.contract_reminders(tenant_id,acceptance_request_id,sequence_number,channel)
  where kind='automatic';
create unique index if not exists contract_reminders_tenant_idempotency_uidx
  on public.contract_reminders(tenant_id,idempotency_key);
create index if not exists contract_reminders_due_idx
  on public.contract_reminders(status,scheduled_at) where status='scheduled';

insert into public.contract_reminder_policies(tenant_id,timezone)
select id,coalesce(timezone,'Europe/Stockholm') from public.tenants
on conflict(tenant_id) do nothing;

create or replace function public.bootstrap_contract_delivery_defaults() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  insert into public.contract_reminder_policies(tenant_id,timezone)
  values(new.id,coalesce(new.timezone,'Europe/Stockholm')) on conflict(tenant_id) do nothing;
  return new;
end $$;
drop trigger if exists tenant_contract_delivery_defaults on public.tenants;
create trigger tenant_contract_delivery_defaults after insert on public.tenants
for each row execute function public.bootstrap_contract_delivery_defaults();

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
        exists(
          select 1 from public.list_dispositions d
          where d.tenant_id=c.tenant_id
            and (c.list_id is null or d.list_id=c.list_id)
            and d.key=c.disposition
            and d.active
            and d.contract_eligible
        )
        or (
          c.list_id is null
          and c.disposition in ('interested','contract','contract_requested','sale','sold','order')
          and not exists(
            select 1 from public.list_dispositions d0
            where d0.tenant_id=c.tenant_id and d0.key=c.disposition and d0.active
          )
        )
      )
      and (
        p_user_id is null
        or c.user_id=p_user_id
        or public.is_tenant_admin(p_tenant_id)
        or exists(select 1 from public.tenant_memberships m where m.tenant_id=p_tenant_id and m.user_id=p_user_id and m.status='active' and m.role in ('team_lead','contract_manager','backoffice','quality'))
        or (c.list_id is not null and public.can_work_customer_list(c.list_id))
      )
  )
$$;

create or replace function public.get_contract_call_eligibility(p_customer_id uuid,p_call_id uuid)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v_tenant uuid:=public.current_tenant_id(); v_call public.calls%rowtype; v_reason text;
begin
  if v_tenant is null or auth.uid() is null then raise exception 'authentication_required'; end if;
  select * into v_call from public.calls where tenant_id=v_tenant and id=p_call_id;
  if not found then return jsonb_build_object('eligible',false,'reason','call_not_found'); end if;
  if v_call.customer_id is distinct from p_customer_id then v_reason:='call_customer_mismatch';
  elsif v_call.status<>'completed' then v_reason:='call_not_completed';
  elsif v_call.answered_at is null then v_reason:='call_not_answered';
  elsif v_call.ended_at is null then v_reason:='call_not_ended';
  elsif v_call.ended_at>now() then v_reason:='call_end_in_future';
  elsif v_call.invalidated_at is not null then v_reason:='call_invalidated';
  elsif not public.is_contract_call_eligible(v_tenant,p_customer_id,p_call_id,auth.uid()) then v_reason:='call_disposition_not_contract_eligible_or_access_denied';
  else return jsonb_build_object('eligible',true,'reason',null,'call_id',v_call.id,'ended_at',v_call.ended_at,'disposition',v_call.disposition); end if;
  return jsonb_build_object('eligible',false,'reason',v_reason);
end $$;

create or replace function public.resolve_contract_eligible_calls(p_customer_id uuid)
returns table(
  id uuid, started_at timestamptz, answered_at timestamptz, ended_at timestamptz,
  duration_seconds integer, direction public.communication_direction, disposition text,
  notes text, user_id uuid, list_id uuid, registered_manually boolean, external_reference text,
  has_recording boolean
) language sql stable security definer set search_path=public as $$
  select c.id,c.started_at,c.answered_at,c.ended_at,c.duration_seconds,c.direction,c.disposition,c.notes,c.user_id,c.list_id,
    coalesce((c.metadata->>'registered_manually')::boolean,false),c.metadata->>'external_reference',
    exists(select 1 from public.call_recordings r where r.tenant_id=c.tenant_id and r.call_id=c.id and r.status='stored')
  from public.calls c
  where c.tenant_id=public.current_tenant_id() and c.customer_id=p_customer_id
    and public.is_contract_call_eligible(c.tenant_id,p_customer_id,c.id,auth.uid())
  order by c.ended_at desc
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
declare v_tenant uuid:=public.current_tenant_id(); v_user uuid:=auth.uid(); v_call uuid; v_customer public.customers%rowtype;
begin
  if v_tenant is null or v_user is null then raise exception 'authentication_required'; end if;
  if not public.can_write_customer(p_customer_id) then raise exception 'customer_write_permission_required'; end if;
  if p_started_at is null or p_ended_at is null or p_ended_at<=p_started_at or p_ended_at>now() then raise exception 'invalid_manual_call_times'; end if;
  if extract(epoch from (p_ended_at-p_started_at)) > 43200 then raise exception 'manual_call_duration_too_long'; end if;
  if not exists(
    select 1 from public.list_dispositions d
    where d.tenant_id=v_tenant and d.key=p_disposition and d.active and d.contract_eligible
  ) and p_disposition not in ('interested','contract','contract_requested','sale','sold','order') then
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
declare v_tenant uuid:=public.current_tenant_id(); v_contract public.contracts%rowtype; v_doc public.contract_documents%rowtype;
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
  if not public.is_contract_call_eligible(v_tenant,v_contract.customer_id,v_contract.source_call_id,auth.uid()) then raise exception 'source_call_not_eligible'; end if;
  select * into v_doc from public.contract_documents where tenant_id=v_tenant and id=p_canonical_document_id and contract_id=v_contract.id and contract_version_id=v_contract.active_version_id;
  if not found then raise exception 'canonical_document_not_found'; end if;
  if v_doc.document_type not in ('generated_pdf','source_pdf') or v_doc.mime_type<>'application/pdf' or coalesce(v_doc.size_bytes,0)<=0 or coalesce(v_doc.size_bytes,0)>20971520 then raise exception 'canonical_document_invalid'; end if;
  if nullif(v_doc.sha256,'') is null then raise exception 'canonical_document_hash_required'; end if;
  if p_channel in ('email','both') then
    if not exists(select 1 from public.tenant_features where tenant_id=v_tenant and feature_key='outbound_email' and enabled) then raise exception 'outbound_email_feature_disabled'; end if;
    if not exists(select 1 from public.tenant_features where tenant_id=v_tenant and feature_key='contract_delivery_email' and enabled) then raise exception 'contract_delivery_email_feature_disabled'; end if;
    if not exists(
      select 1 from public.tenant_integrations
      where tenant_id=v_tenant and provider='resend' and status='active'
    ) then raise exception 'resend_integration_not_active'; end if;
  end if;
  if p_channel in ('sms','both') then
    if not exists(select 1 from public.tenant_features where tenant_id=v_tenant and feature_key='outbound_sms' and enabled) then raise exception 'outbound_sms_feature_disabled'; end if;
    if not exists(select 1 from public.tenant_features where tenant_id=v_tenant and feature_key='contract_delivery_sms' and enabled) then raise exception 'contract_delivery_sms_feature_disabled'; end if;
  end if;
  return jsonb_build_object('contract_id',v_contract.id,'contract_version_id',v_contract.active_version_id,'customer_id',v_contract.customer_id,'source_call_id',v_contract.source_call_id,'canonical_document_id',v_doc.id,'canonical_document_sha256',v_doc.sha256);
end $$;

create or replace function public.cancel_contract_reminders(
  p_acceptance_request_id uuid,
  p_reason text
) returns integer language plpgsql security definer set search_path=public as $$
declare v_count integer;
begin
  update public.contract_reminders set status='cancelled',cancelled_at=now(),cancel_reason=left(coalesce(p_reason,'request_closed'),200)
  where acceptance_request_id=p_acceptance_request_id and status in ('scheduled','queued');
  get diagnostics v_count=row_count;
  update public.outbox_jobs set status='cancelled',completed_at=now(),last_error=left(coalesce(p_reason,'request_closed'),500)
  where status in ('pending','failed') and payload->>'acceptance_request_id'=p_acceptance_request_id::text
    and job_type in ('contract.reminder.dispatch','email.send','sms.send');
  return v_count;
end $$;

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
  v_source_type text; v_initial timestamptz:=now(); v_sequence integer:=0;
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
  select case when coalesce((c.metadata->>'registered_manually')::boolean,false) then 'external_manual_call'
              when c.dialer_session_id is not null then 'dialer_call' else 'manual_call' end
    into v_source_type from public.calls c where c.tenant_id=v_tenant and c.id=v_contract.source_call_id;

  update public.contract_acceptance_requests set status='superseded',superseded_at=now()
  where tenant_id=v_tenant and contract_id=p_contract_id and status='pending';
  for v_request in select id from public.contract_acceptance_requests where tenant_id=v_tenant and contract_id=p_contract_id and status='superseded' and superseded_at>=now()-interval '2 seconds'
  loop perform public.cancel_contract_reminders(v_request,'superseded'); end loop;

  insert into public.contract_recipients(tenant_id,contract_id,full_name,email,phone_e164)
  values(v_tenant,p_contract_id,trim(p_recipient_name),nullif(lower(trim(p_email)),''),nullif(trim(p_phone_e164),'')) returning id into v_recipient;

  insert into public.contract_acceptance_requests(
    tenant_id,contract_id,contract_version_id,recipient_id,public_token_hash,public_token_ciphertext,
    acceptance_code,require_code,method,status,expires_at,call_id,call_ended_at,canonical_document_id,canonical_document_sha256
  ) values(
    v_tenant,p_contract_id,v_contract.active_version_id,v_recipient,p_public_token_hash,p_public_token_ciphertext,
    p_acceptance_code,p_channel in ('sms','both'),case when p_channel in ('sms','both') then 'sms'::public.acceptance_method else 'web'::public.acceptance_method end,
    'pending',p_expires_at,v_contract.source_call_id,(select ended_at from public.calls where tenant_id=v_tenant and id=v_contract.source_call_id),v_doc.id,v_doc.sha256
  ) returning id into v_request;

  update public.contract_versions set locked_at=coalesce(locked_at,now()),snapshot_hash=coalesce(snapshot_hash,document_hash)
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
    prepared_at=coalesce(prepared_at,now()),first_sent_at=coalesce(first_sent_at,now()),last_sent_at=now(),expires_at=p_expires_at
  where tenant_id=v_tenant and id=p_contract_id;
  insert into public.contract_events(tenant_id,contract_id,event_type,actor_user_id,payload)
  values(v_tenant,p_contract_id,'contract.sent',v_user,jsonb_build_object('channel',p_channel,'request_id',v_request,'source_call_id',v_contract.source_call_id,'canonical_document_id',v_doc.id,'canonical_document_sha256',v_doc.sha256));
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
  values(v_tenant,v_user,'contract.sent','contract',p_contract_id::text,jsonb_build_object('channel',p_channel,'request_id',v_request,'source_call_id',v_contract.source_call_id,'canonical_document_id',v_doc.id));
  return jsonb_build_object('acceptance_request_id',v_request,'email_delivery_id',v_delivery_email,'sms_delivery_id',v_delivery_sms,'canonical_document_id',v_doc.id);
end $$;

create or replace function public.schedule_manual_contract_reminder(
  p_contract_id uuid,
  p_channel text,
  p_personal_message text,
  p_attach_pdf boolean,
  p_idempotency_key text
) returns uuid language plpgsql security definer set search_path=public as $$
declare v_tenant uuid:=public.current_tenant_id(); v_user uuid:=auth.uid(); v_request public.contract_acceptance_requests%rowtype; v_sequence integer; v_id uuid;
begin
  if v_tenant is null or v_user is null then raise exception 'authentication_required'; end if;
  if not public.can_write_contract(p_contract_id,null)
    or not public.has_current_role(array['owner','admin','team_lead','contract_manager','sales']) then
    raise exception 'contract_remind_permission_required';
  end if;
  if p_channel not in ('email','sms','both') then raise exception 'invalid_delivery_channel'; end if;
  if nullif(trim(p_idempotency_key),'') is null then raise exception 'idempotency_key_required'; end if;
  select id into v_id from public.contract_reminders where tenant_id=v_tenant and idempotency_key=p_idempotency_key;
  if v_id is not null then return v_id; end if;
  select * into v_request from public.contract_acceptance_requests where tenant_id=v_tenant and contract_id=p_contract_id and status='pending' order by created_at desc limit 1 for update;
  if not found then raise exception 'active_acceptance_request_required'; end if;
  if v_request.expires_at<=now() then raise exception 'acceptance_request_expired'; end if;
  select coalesce(max(sequence_number),0)+1 into v_sequence from public.contract_reminders where tenant_id=v_tenant and acceptance_request_id=v_request.id;
  insert into public.contract_reminders(tenant_id,contract_id,contract_version_id,acceptance_request_id,recipient_id,sequence_number,channel,kind,status,scheduled_at,created_by,personal_message,attach_pdf,idempotency_key)
  values(v_tenant,p_contract_id,v_request.contract_version_id,v_request.id,v_request.recipient_id,v_sequence,p_channel,'manual','scheduled',now(),v_user,nullif(trim(p_personal_message),''),p_attach_pdf,p_idempotency_key)
  on conflict(tenant_id,idempotency_key) do update set idempotency_key=excluded.idempotency_key
  returning id into v_id;
  insert into public.outbox_jobs(tenant_id,job_type,aggregate_type,aggregate_id,payload,idempotency_key,priority)
  values(v_tenant,'contract.reminder.dispatch','contract_reminder',v_id,jsonb_build_object('reminder_id',v_id,'acceptance_request_id',v_request.id),p_idempotency_key,25)
  on conflict(tenant_id,idempotency_key) do nothing;
  insert into public.contract_events(tenant_id,contract_id,event_type,actor_user_id,payload)
  values(v_tenant,p_contract_id,'contract.reminder_scheduled',v_user,jsonb_build_object('reminder_id',v_id,'channel',p_channel,'kind','manual'));
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
  values(v_tenant,v_user,'contract.reminder_scheduled','contract',p_contract_id::text,jsonb_build_object('reminder_id',v_id,'channel',p_channel));
  return v_id;
end $$;

create or replace function public.enqueue_due_contract_reminders(p_limit integer default 100)
returns integer language plpgsql security definer set search_path=public as $$
declare v_count integer;
begin
  with due as (
    select r.id,r.tenant_id,r.acceptance_request_id
    from public.contract_reminders r
    join public.contract_acceptance_requests a on a.tenant_id=r.tenant_id and a.id=r.acceptance_request_id
    where r.status='scheduled' and r.scheduled_at<=now() and a.status='pending' and a.expires_at>now()
    order by r.scheduled_at for update skip locked limit greatest(1,least(p_limit,500))
  ), updated as (
    update public.contract_reminders r set status='queued'
    from due d where r.id=d.id returning r.id,r.tenant_id,r.acceptance_request_id
  )
  insert into public.outbox_jobs(tenant_id,job_type,aggregate_type,aggregate_id,payload,idempotency_key,priority)
  select tenant_id,'contract.reminder.dispatch','contract_reminder',id,jsonb_build_object('reminder_id',id,'acceptance_request_id',acceptance_request_id),
    'contract-reminder-dispatch/'||id::text,25 from updated
  on conflict(tenant_id,idempotency_key) do nothing;
  get diagnostics v_count=row_count;
  update public.contract_reminders r set status='cancelled',cancelled_at=now(),cancel_reason='acceptance_request_closed'
  where r.status in ('scheduled','queued') and exists(select 1 from public.contract_acceptance_requests a where a.tenant_id=r.tenant_id and a.id=r.acceptance_request_id and (a.status<>'pending' or a.expires_at<=now()));
  update public.contract_acceptance_requests set status='expired' where status='pending' and expires_at<=now();
  update public.contracts c set status='expired' where status in ('sent','delivered','opened') and exists(select 1 from public.contract_acceptance_requests a where a.tenant_id=c.tenant_id and a.contract_id=c.id and a.status='expired');
  return v_count;
end $$;


create or replace function public.dead_letter_outbox_job(p_job_id uuid,p_error text)
returns void language sql security definer set search_path=public as $$
  update public.outbox_jobs set status='dead_letter',last_error=left(p_error,4000),locked_at=null,locked_by=null,completed_at=now()
  where id=p_job_id
$$;

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
) returns uuid language plpgsql security definer set search_path=public as $$
declare v_request public.contract_acceptance_requests%rowtype; v_contract public.contracts%rowtype; v_acceptance uuid; v_now timestamptz:=now();
begin
  if p_status not in ('accepted_via_sms','accepted_via_web','declined','manual_review_required') then raise exception 'invalid_acceptance_decision'; end if;
  select * into v_request from public.contract_acceptance_requests where id=p_request_id for update;
  if not found then raise exception 'acceptance_request_not_found'; end if;
  select * into v_contract from public.contracts where tenant_id=v_request.tenant_id and id=v_request.contract_id for update;
  select id into v_acceptance from public.contract_acceptances where tenant_id=v_request.tenant_id and request_id=v_request.id;
  if v_acceptance is not null then return v_acceptance; end if;
  if v_request.status<>'pending' then raise exception 'acceptance_request_not_pending:%',v_request.status; end if;
  if v_request.expires_at<=v_now then
    update public.contract_acceptance_requests set status='expired' where id=v_request.id;
    perform public.cancel_contract_reminders(v_request.id,'expired');
    update public.contracts set status='expired' where tenant_id=v_request.tenant_id and id=v_request.contract_id and status not in ('accepted','signed','active');
    raise exception 'acceptance_request_expired';
  end if;
  if v_request.canonical_document_id is null or v_request.canonical_document_sha256 is null then raise exception 'acceptance_request_document_binding_missing'; end if;
  if v_contract.source_call_id is null or not public.is_contract_call_eligible(v_request.tenant_id,v_contract.customer_id,v_contract.source_call_id,null) then raise exception 'source_call_no_longer_eligible'; end if;
  insert into public.contract_acceptances(
    tenant_id,request_id,contract_id,contract_version_id,recipient_id,method,status,raw_response,normalized_response,
    acceptance_phrase,acceptance_code,ip_address,user_agent,provider_message_id,evidence,accepted_at,
    canonical_document_id,canonical_document_sha256,source_call_id,acceptance_text
  ) values(
    v_request.tenant_id,v_request.id,v_request.contract_id,v_request.contract_version_id,v_request.recipient_id,p_method,p_status,p_raw_response,p_normalized_response,
    p_acceptance_phrase,p_acceptance_code,p_ip_address,p_user_agent,p_provider_message_id,coalesce(p_evidence,'{}'::jsonb),
    case when p_status in ('accepted_via_sms','accepted_via_web') then v_now else null end,
    v_request.canonical_document_id,v_request.canonical_document_sha256,v_contract.source_call_id,p_acceptance_text
  ) returning id into v_acceptance;
  update public.contract_acceptance_requests set status=p_status,
    accepted_at=case when p_status in ('accepted_via_sms','accepted_via_web') then v_now else null end,
    declined_at=case when p_status='declined' then v_now else null end
  where id=v_request.id;
  perform public.cancel_contract_reminders(v_request.id,case when p_status='declined' then 'declined' else 'accepted' end);
  if p_status in ('accepted_via_sms','accepted_via_web') then
    update public.contracts set status='accepted',accepted_at=v_now where tenant_id=v_request.tenant_id and id=v_request.contract_id;
    insert into public.contract_events(tenant_id,contract_id,event_type,payload)
    values(v_request.tenant_id,v_request.contract_id,'contract.'||p_status::text,jsonb_build_object('accepted_at',v_now,'request_id',v_request.id,'acceptance_id',v_acceptance,'canonical_document_id',v_request.canonical_document_id,'source_call_id',v_contract.source_call_id));
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
  end if;
  return v_acceptance;
end $$;

create or replace function public.protect_canonical_contract_documents() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  if tg_op='DELETE' then
    if exists(select 1 from public.contract_acceptance_requests r where r.tenant_id=old.tenant_id and r.canonical_document_id=old.id)
      or exists(select 1 from public.contract_deliveries d where d.tenant_id=old.tenant_id and d.canonical_document_id=old.id) then
      raise exception 'canonical_contract_document_is_immutable';
    end if;
    return old;
  end if;
  if row(new.contract_id,new.contract_version_id,new.document_type,new.storage_path,new.mime_type,new.size_bytes,new.sha256)
    is distinct from row(old.contract_id,old.contract_version_id,old.document_type,old.storage_path,old.mime_type,old.size_bytes,old.sha256)
    and (exists(select 1 from public.contract_acceptance_requests r where r.tenant_id=old.tenant_id and r.canonical_document_id=old.id)
      or exists(select 1 from public.contract_deliveries d where d.tenant_id=old.tenant_id and d.canonical_document_id=old.id)) then
    raise exception 'canonical_contract_document_is_immutable';
  end if;
  return new;
end $$;
drop trigger if exists contract_documents_canonical_immutability on public.contract_documents;
create trigger contract_documents_canonical_immutability before update or delete on public.contract_documents
for each row execute function public.protect_canonical_contract_documents();

alter table public.contract_reminder_policies enable row level security;
alter table public.contract_reminders enable row level security;
drop policy if exists contract_reminder_policies_admin_all on public.contract_reminder_policies;
create policy contract_reminder_policies_admin_all on public.contract_reminder_policies for all to authenticated
  using(tenant_id=public.current_tenant_id() and public.has_current_role(array['owner','admin','contract_manager']))
  with check(tenant_id=public.current_tenant_id() and public.has_current_role(array['owner','admin','contract_manager']));
drop policy if exists contract_reminders_member_select on public.contract_reminders;
create policy contract_reminders_member_select on public.contract_reminders for select to authenticated
  using(tenant_id=public.current_tenant_id() and public.can_access_contract(contract_id));
drop policy if exists contract_reminders_member_insert on public.contract_reminders;
create policy contract_reminders_member_insert on public.contract_reminders for insert to authenticated
  with check(tenant_id=public.current_tenant_id() and public.can_write_contract(contract_id,null));

create trigger contract_reminder_policies_touch before update on public.contract_reminder_policies
for each row execute function public.touch_updated_at();

revoke all on function public.is_contract_call_eligible(uuid,uuid,uuid,uuid) from public,anon;
revoke all on function public.get_contract_call_eligibility(uuid,uuid) from public,anon;
revoke all on function public.resolve_contract_eligible_calls(uuid) from public,anon;
revoke all on function public.register_external_manual_call(uuid,text,public.communication_direction,timestamptz,timestamptz,text,text,text) from public,anon;
revoke all on function public.assert_contract_sendable_v2(uuid,uuid,text) from public,anon;
revoke all on function public.prepare_contract_delivery_v2(uuid,text,text,text,text,text,text,text,timestamptz,uuid,text,text,text,text,text,text,jsonb,text,text) from public,anon;
revoke all on function public.schedule_manual_contract_reminder(uuid,text,text,boolean,text) from public,anon;
revoke all on function public.enqueue_due_contract_reminders(integer) from public,anon,authenticated;
revoke all on function public.record_contract_acceptance_v2(uuid,public.acceptance_method,public.acceptance_status,text,text,text,text,inet,text,text,text,jsonb) from public,anon,authenticated;
revoke all on function public.cancel_contract_reminders(uuid,text) from public,anon,authenticated;
revoke all on function public.dead_letter_outbox_job(uuid,text) from public,anon,authenticated;

grant execute on function public.get_contract_call_eligibility(uuid,uuid) to authenticated;
grant execute on function public.resolve_contract_eligible_calls(uuid) to authenticated;
grant execute on function public.register_external_manual_call(uuid,text,public.communication_direction,timestamptz,timestamptz,text,text,text) to authenticated;
grant execute on function public.assert_contract_sendable_v2(uuid,uuid,text) to authenticated;
grant execute on function public.prepare_contract_delivery_v2(uuid,text,text,text,text,text,text,text,timestamptz,uuid,text,text,text,text,text,text,jsonb,text,text) to authenticated;
grant execute on function public.schedule_manual_contract_reminder(uuid,text,text,boolean,text) to authenticated;
grant execute on function public.enqueue_due_contract_reminders(integer) to service_role;
grant execute on function public.record_contract_acceptance_v2(uuid,public.acceptance_method,public.acceptance_status,text,text,text,text,inet,text,text,text,jsonb) to service_role;
grant execute on function public.cancel_contract_reminders(uuid,text) to service_role;
grant execute on function public.dead_letter_outbox_job(uuid,text) to service_role;

commit;
