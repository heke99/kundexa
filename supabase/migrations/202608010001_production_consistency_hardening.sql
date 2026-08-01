begin;

-- KX-007/KX-008/KX-009: imports must never truncate silently and preview/commit are separate executions.
alter table public.import_runs
  add column if not exists validation_fingerprint text,
  add column if not exists execution_idempotency_key text,
  add column if not exists source_row_count integer,
  add column if not exists parsed_row_count integer,
  add column if not exists accepted_row_count integer,
  add column if not exists rejected_row_count integer,
  add column if not exists truncated boolean not null default false,
  add column if not exists truncation_reason text;

create index if not exists import_runs_validation_fingerprint_idx
  on public.import_runs(tenant_id,validation_fingerprint,created_at desc);
create unique index if not exists import_runs_execution_idempotency_uidx
  on public.import_runs(tenant_id,execution_idempotency_key)
  where execution_idempotency_key is not null;


create or replace function public.prevent_truncated_import_execution() returns trigger
language plpgsql set search_path=public as $$
begin
  if new.status='processing' and new.truncated then
    raise exception 'truncated_import_cannot_be_committed';
  end if;
  if new.status='processing' and new.execution_idempotency_key is null then
    raise exception 'execution_idempotency_key_required';
  end if;
  return new;
end $$;

drop trigger if exists import_runs_block_truncated_execution on public.import_runs;
create trigger import_runs_block_truncated_execution
before update of status on public.import_runs
for each row execute function public.prevent_truncated_import_execution();

-- Preserve the existing canonical import function while fixing its customer-type projection.
do $migration$
declare
  v_definition text;
begin
  select pg_get_functiondef('public.process_import_run(uuid)'::regprocedure) into v_definition;
  if position($needle$v_tenant,'company','prospect'$needle$ in v_definition)=0 then
    raise exception 'process_import_run_customer_type_anchor_missing';
  end if;
  v_definition:=replace(
    v_definition,
    $needle$v_tenant,'company','prospect'$needle$,
    $replacement$v_tenant,
        case v_data->>'customer_type'
          when 'person' then 'person'::public.customer_type
          when 'company' then 'company'::public.customer_type
          else null
        end,
        'prospect'$replacement$
  );
  execute v_definition;
end
$migration$;

-- KX-004/KX-005: raw Rinkel events are correlated separately from their processing state.
alter table public.platform_rinkel_webhook_events drop constraint if exists platform_rinkel_webhook_events_status_check;
alter table public.platform_rinkel_webhook_events
  add constraint platform_rinkel_webhook_events_status_check check(status in (
    'received','processing','pending_correlation','processed','conflict','failed','dead_letter'
  )),
  add column if not exists correlation_status text not null default 'pending'
    check(correlation_status in ('pending','correlated','ambiguous','conflict','ignored')),
  add column if not exists correlation_key text,
  add column if not exists correlated_call_id uuid references public.calls(id) on delete set null,
  add column if not exists correlated_attempt_id uuid references public.rinkel_call_attempts_v2(id) on delete set null,
  add column if not exists next_retry_at timestamptz,
  add column if not exists correlation_attempts integer not null default 0;

create index if not exists platform_rinkel_events_pending_correlation_idx
  on public.platform_rinkel_webhook_events(external_call_id,next_retry_at,received_at)
  where status='pending_correlation';

alter table public.calls
  add column if not exists provider_status text,
  add column if not exists provider_cause text,
  add column if not exists provider_state_updated_at timestamptz;

create or replace function public.call_status_rank(p_status text) returns integer
language sql immutable as $$
  select case p_status
    when 'queued' then 0
    when 'requested' then 10
    when 'initiating' then 20
    when 'dial_requested' then 20
    when 'awaiting_provider_event' then 20
    when 'initiated' then 20
    when 'ringing' then 30
    when 'answered' then 40
    when 'in_progress' then 40
    when 'provider_outcome_unknown' then 35
    when 'reconciliation_required' then 45
    when 'completed' then 100
    when 'unanswered' then 100
    when 'busy' then 100
    when 'no_answer' then 100
    when 'failed' then 100
    when 'blocked' then 100
    when 'voicemail' then 100
    when 'outside_business_hours' then 100
    when 'cancelled' then 100
    else 0
  end
$$;

create or replace function public.protect_rinkel_call_projection() returns trigger
language plpgsql set search_path=public as $$
begin
  if old.provider<>'rinkel' or new.provider<>'rinkel' then return new; end if;
  if public.call_status_rank(old.status)=100 and new.status<>old.status then
    new.status:=old.status;
    new.answered_at:=old.answered_at;
    new.ended_at:=old.ended_at;
    new.duration_seconds:=old.duration_seconds;
    new.end_cause:=old.end_cause;
    new.provider_status:=old.provider_status;
    new.provider_cause:=old.provider_cause;
    new.provider_state_updated_at:=old.provider_state_updated_at;
    return new;
  end if;
  if public.call_status_rank(new.status) < public.call_status_rank(old.status)
    or (old.provider_state_updated_at is not null and new.provider_state_updated_at is not null
        and new.provider_state_updated_at < old.provider_state_updated_at) then
      new.status:=old.status;
      new.answered_at:=old.answered_at;
      new.ended_at:=old.ended_at;
      new.duration_seconds:=old.duration_seconds;
      new.end_cause:=old.end_cause;
      new.provider_status:=old.provider_status;
      new.provider_cause:=old.provider_cause;
      new.provider_state_updated_at:=old.provider_state_updated_at;
  end if;
  return new;
end $$;

drop trigger if exists calls_rinkel_projection_monotonic on public.calls;
create trigger calls_rinkel_projection_monotonic before update on public.calls
for each row execute function public.protect_rinkel_call_projection();

create or replace function public.correlate_rinkel_incoming_event(
  p_event_id uuid,p_tenant_id uuid,p_allocation_id uuid,p_number_id uuid,p_from text,p_to text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_event public.platform_rinkel_webhook_events%rowtype;
  v_call public.calls%rowtype;
  v_occurred timestamptz;
begin
  if auth.role()<>'service_role' then raise exception 'service_role_required'; end if;
  select * into v_event from public.platform_rinkel_webhook_events where id=p_event_id for update;
  if not found then raise exception 'rinkel_event_not_found'; end if;
  if v_event.status='processed' and v_event.correlated_call_id is not null then
    return jsonb_build_object('status','processed','call_id',v_event.correlated_call_id,'idempotent_replay',true);
  end if;
  v_occurred:=coalesce(v_event.event_at,v_event.received_at);
  select * into v_call from public.calls
    where tenant_id=p_tenant_id and provider='rinkel' and external_call_id=v_event.external_call_id
    order by created_at desc limit 1 for update;
  if not found then
    insert into public.calls(
      tenant_id,provider,external_call_id,direction,from_number,to_number,status,callback_token_hash,
      metadata,initiated_at,provider_status,provider_state_updated_at
    ) values(
      p_tenant_id,'rinkel',v_event.external_call_id,'inbound',coalesce(nullif(p_from,''),'anonymous'),p_to,'ringing',
      replace(gen_random_uuid()::text,'-',''),
      jsonb_build_object('platform_integration_id',v_event.platform_integration_id,'number_allocation_id',p_allocation_id,'platform_rinkel_number_id',p_number_id),
      v_occurred,'incomingCall',v_occurred
    ) returning * into v_call;
  end if;
  insert into public.call_events(tenant_id,call_id,event_type,provider_event_id,occurred_at,payload)
  values(p_tenant_id,v_call.id,v_event.event_type,v_event.provider_event_id,v_occurred,
    jsonb_build_object('external_call_id',v_event.external_call_id,'number_allocation_id',p_allocation_id))
  on conflict(tenant_id,provider_event_id) do nothing;
  update public.platform_rinkel_webhook_events set
    tenant_id=p_tenant_id,status='processed',correlation_status='correlated',correlated_call_id=v_call.id,
    correlation_key='call:'||v_call.id::text,next_retry_at=null,last_error=null,processed_at=now()
  where id=v_event.id;
  return jsonb_build_object('status','processed','call_id',v_call.id,'tenant_id',p_tenant_id,'idempotent_replay',false);
end $$;
revoke all on function public.correlate_rinkel_incoming_event(uuid,uuid,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.correlate_rinkel_incoming_event(uuid,uuid,uuid,uuid,text,text) to service_role;

create or replace function public.correlate_rinkel_outgoing_event(
  p_event_id uuid,p_attempt_id uuid
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_event public.platform_rinkel_webhook_events%rowtype;
  v_attempt public.rinkel_call_attempts_v2%rowtype;
  v_call public.calls%rowtype;
  v_occurred timestamptz;
begin
  if auth.role()<>'service_role' then raise exception 'service_role_required'; end if;
  select * into v_event from public.platform_rinkel_webhook_events where id=p_event_id for update;
  if not found then raise exception 'rinkel_event_not_found'; end if;
  if v_event.status='processed' and v_event.correlated_call_id is not null then
    return jsonb_build_object('status','processed','call_id',v_event.correlated_call_id,'idempotent_replay',true);
  end if;
  select * into v_attempt from public.rinkel_call_attempts_v2 where id=p_attempt_id for update;
  if not found then raise exception 'rinkel_attempt_not_found'; end if;
  select * into v_call from public.calls where tenant_id=v_attempt.tenant_id and id=v_attempt.call_id for update;
  if not found then raise exception 'rinkel_call_not_found'; end if;
  v_occurred:=coalesce(v_event.event_at,v_event.received_at);
  update public.rinkel_call_attempts_v2 set
    status='matched',external_call_id=v_event.external_call_id,updated_at=now()
  where id=v_attempt.id and tenant_id=v_attempt.tenant_id;
  update public.calls set
    external_call_id=v_event.external_call_id,status='ringing',initiated_at=coalesce(initiated_at,v_occurred),
    provider_status='outgoingCall',provider_state_updated_at=v_occurred
  where id=v_call.id and tenant_id=v_call.tenant_id;
  insert into public.call_events(tenant_id,call_id,event_type,provider_event_id,occurred_at,payload)
  values(v_call.tenant_id,v_call.id,v_event.event_type,v_event.provider_event_id,v_occurred,
    jsonb_build_object('external_call_id',v_event.external_call_id,'attempt_id',v_attempt.id))
  on conflict(tenant_id,provider_event_id) do nothing;
  update public.platform_rinkel_webhook_events set
    tenant_id=v_call.tenant_id,status='processed',correlation_status='correlated',correlated_call_id=v_call.id,
    correlated_attempt_id=v_attempt.id,correlation_key='call:'||v_call.id::text,next_retry_at=null,last_error=null,processed_at=now()
  where id=v_event.id;
  return jsonb_build_object('status','processed','call_id',v_call.id,'tenant_id',v_call.tenant_id,'attempt_id',v_attempt.id,'idempotent_replay',false);
end $$;
revoke all on function public.correlate_rinkel_outgoing_event(uuid,uuid) from public,anon,authenticated;
grant execute on function public.correlate_rinkel_outgoing_event(uuid,uuid) to service_role;

create or replace function public.apply_rinkel_call_event(p_event_id uuid) returns jsonb
language plpgsql security definer set search_path=public as $$
declare
  v_event public.platform_rinkel_webhook_events%rowtype;
  v_call public.calls%rowtype;
  v_occurred timestamptz;
  v_cause text;
  v_status text;
  v_started timestamptz;
begin
  if auth.role()<>'service_role' then raise exception 'service_role_required'; end if;
  select * into v_event from public.platform_rinkel_webhook_events where id=p_event_id for update;
  if not found then raise exception 'rinkel_event_not_found'; end if;
  if v_event.status='processed' then return jsonb_build_object('status','processed','call_id',v_event.correlated_call_id); end if;

  select * into v_call from public.calls
  where provider='rinkel' and external_call_id=v_event.external_call_id
  order by created_at desc limit 1 for update;
  if not found then
    update public.platform_rinkel_webhook_events set
      status='pending_correlation',correlation_status='pending',correlation_attempts=correlation_attempts+1,
      next_retry_at=now()+least(interval '30 minutes',interval '15 seconds' * power(2,least(correlation_attempts,7))),
      last_error='RINKEL_CALL_NOT_CORRELATED',processed_at=null
    where id=v_event.id;
    return jsonb_build_object('status','pending_correlation');
  end if;

  v_occurred:=coalesce(v_event.event_at,v_event.received_at);
  update public.platform_rinkel_webhook_events set
    tenant_id=v_call.tenant_id,correlation_status='correlated',correlated_call_id=v_call.id,
    correlation_key='call:'||v_call.id::text,next_retry_at=null,last_error=null
  where id=v_event.id;

  if v_event.event_type='callStart' then
    update public.calls set
      status='answered',answered_at=least(coalesce(answered_at,v_occurred),v_occurred),
      provider_user_id=coalesce(nullif(v_event.payload->>'userId',''),provider_user_id),
      provider_status='callStart',provider_state_updated_at=v_occurred
    where id=v_call.id and tenant_id=v_call.tenant_id;
  elsif v_event.event_type='callEnd' then
    v_cause:=coalesce(nullif(v_event.payload->>'cause',''),'UNANSWERED');
    v_status:=case v_cause
      when 'ANSWERED' then 'completed'
      when 'CALLCENTER' then 'completed'
      when 'UNANSWERED' then 'unanswered'
      when 'BLACKLISTED' then 'blocked'
      when 'VOICEMAIL' then 'voicemail'
      when 'OUTSIDE_OPERATION_TIMES' then 'outside_business_hours'
      else 'failed'
    end;
    v_started:=coalesce(v_call.answered_at,v_call.initiated_at,v_call.started_at,v_call.created_at,v_occurred);
    update public.calls set
      status=v_status,end_cause=v_cause,ended_at=v_occurred,
      duration_seconds=greatest(0,floor(extract(epoch from (v_occurred-v_started)))::integer),
      recording_status=case when nullif(v_event.payload->>'callRecordingUrl','') is not null then 'available_at_provider' else 'unavailable' end,
      provider_status='callEnd',provider_cause=v_cause,provider_state_updated_at=v_occurred
    where id=v_call.id and tenant_id=v_call.tenant_id;
    update public.rinkel_call_attempts_v2 set status='completed',updated_at=now(),external_call_id=coalesce(external_call_id,v_event.external_call_id)
    where tenant_id=v_call.tenant_id and call_id=v_call.id;
  elsif v_event.event_type='callInsights' then
    insert into public.call_insights(tenant_id,call_id,source,status,sentiment,topics,summary,analysis,generated_at)
    values(v_call.tenant_id,v_call.id,'rinkel','available',nullif(v_event.payload->>'sentiment',''),
      case when jsonb_typeof(v_event.payload->'topics')='array'
        then array(select jsonb_array_elements_text(v_event.payload->'topics')) else '{}'::text[] end,
      nullif(v_event.payload->>'summary',''),
      jsonb_build_object('payload_version',1,'provider_event_id',v_event.provider_event_id),now())
    on conflict(call_id,source) do update set
      status='available',sentiment=excluded.sentiment,topics=excluded.topics,summary=excluded.summary,
      analysis=excluded.analysis,generated_at=excluded.generated_at;
    update public.calls set insights_status='available' where id=v_call.id and tenant_id=v_call.tenant_id;
  end if;

  insert into public.call_events(tenant_id,call_id,event_type,provider_event_id,occurred_at,payload)
  values(v_call.tenant_id,v_call.id,v_event.event_type,v_event.provider_event_id,v_occurred,
    jsonb_build_object('external_call_id',v_event.external_call_id,'provider_event_id',v_event.provider_event_id))
  on conflict(tenant_id,provider_event_id) do nothing;

  update public.platform_rinkel_webhook_events set
    status='processed',correlation_status='correlated',processed_at=now(),last_error=null
  where id=v_event.id;
  return jsonb_build_object('status','processed','call_id',v_call.id,'tenant_id',v_call.tenant_id);
end $$;
revoke all on function public.apply_rinkel_call_event(uuid) from public,anon,authenticated;
grant execute on function public.apply_rinkel_call_event(uuid) to service_role;

-- KX-006: immutable Resend event ledger and a monotonic projection.
create table if not exists public.email_delivery_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  email_message_id uuid not null,
  provider text not null default 'resend',
  provider_event_id text not null,
  provider_event_type text not null,
  delivery_status public.delivery_status not null,
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  payload jsonb not null default '{}'::jsonb,
  projection_applied boolean not null default false,
  projection_reason text,
  unique(provider,provider_event_id),
  foreign key(tenant_id,email_message_id) references public.email_messages(tenant_id,id) on delete cascade
);
create index if not exists email_delivery_events_message_time_idx
  on public.email_delivery_events(tenant_id,email_message_id,occurred_at,id);

alter table public.email_messages
  add column if not exists provider_status_at timestamptz,
  add column if not exists provider_status text;
alter table public.contract_deliveries
  add column if not exists provider_status_at timestamptz,
  add column if not exists provider_status text;

create or replace function public.delivery_status_rank(p_status text) returns integer
language sql immutable as $$
  select case p_status
    when 'draft' then 0 when 'queued' then 10 when 'submitting' then 20 when 'created' then 30
    when 'sent' then 40 when 'delayed' then 45 when 'delivered' then 50 when 'opened' then 60 when 'clicked' then 70
    when 'failed' then 100 when 'bounced' then 100 when 'complained' then 110 when 'suppressed' then 110
    when 'cancelled' then 110 when 'dead_letter' then 110 else 0 end
$$;

create or replace function public.apply_resend_delivery_event(
  p_tenant_id uuid,p_email_message_id uuid,p_provider_event_id text,p_provider_event_type text,
  p_status text,p_occurred_at timestamptz,p_payload jsonb default '{}'::jsonb,p_failure_message text default null
) returns jsonb
language plpgsql security definer set search_path=public as $$
declare
  v_email public.email_messages%rowtype;
  v_event_id uuid;
  v_apply boolean:=false;
  v_reason text;
  v_occurred timestamptz:=coalesce(p_occurred_at,now());
  v_current_rank integer;
  v_new_rank integer;
  v_permanent boolean:=p_status in ('failed','bounced','complained','suppressed','cancelled','dead_letter');
begin
  if auth.role()<>'service_role' then raise exception 'service_role_required'; end if;
  if p_status not in ('draft','queued','submitting','created','sent','delayed','delivered','opened','clicked','failed','bounced','complained','suppressed','cancelled','dead_letter') then
    raise exception 'invalid_delivery_status';
  end if;
  insert into public.email_delivery_events(
    tenant_id,email_message_id,provider_event_id,provider_event_type,delivery_status,occurred_at,payload
  ) values(p_tenant_id,p_email_message_id,p_provider_event_id,p_provider_event_type,p_status::public.delivery_status,v_occurred,coalesce(p_payload,'{}'::jsonb))
  on conflict(provider,provider_event_id) do nothing returning id into v_event_id;
  if v_event_id is null then return jsonb_build_object('duplicate',true,'applied',false); end if;

  select * into v_email from public.email_messages where tenant_id=p_tenant_id and id=p_email_message_id for update;
  if not found then raise exception 'email_message_not_found'; end if;
  v_current_rank:=public.delivery_status_rank(v_email.status::text);
  v_new_rank:=public.delivery_status_rank(p_status);
  if v_email.provider_status_at is null then
    v_apply:=true; v_reason:='first_provider_event';
  elsif v_occurred < v_email.provider_status_at then
    v_reason:='older_provider_event';
  elsif v_new_rank < v_current_rank then
    v_reason:='regressive_provider_event';
  else
    v_apply:=true;
    v_reason:=case when v_occurred=v_email.provider_status_at then 'same_time_non_regressive' else 'newer_non_regressive' end;
  end if;

  if v_apply then
    update public.email_messages set
      status=p_status::public.delivery_status,provider_status=p_provider_event_type,provider_status_at=v_occurred,
      sent_at=case when p_status='sent' then coalesce(sent_at,v_occurred) else sent_at end,
      delivered_at=case when p_status='delivered' then coalesce(delivered_at,v_occurred) else delivered_at end,
      opened_at=case when p_status='opened' then coalesce(opened_at,v_occurred) else opened_at end,
      clicked_at=case when p_status='clicked' then coalesce(clicked_at,v_occurred) else clicked_at end,
      delayed_at=case when p_status='delayed' then coalesce(delayed_at,v_occurred) else delayed_at end,
      bounced_at=case when p_status='bounced' then coalesce(bounced_at,v_occurred) else bounced_at end,
      complained_at=case when p_status='complained' then coalesce(complained_at,v_occurred) else complained_at end,
      suppressed_at=case when p_status='suppressed' then coalesce(suppressed_at,v_occurred) else suppressed_at end,
      error_message=case when v_permanent then left(coalesce(p_failure_message,p_provider_event_type),500) else error_message end,
      failure_code=case when v_permanent then p_status else failure_code end
    where tenant_id=p_tenant_id and id=p_email_message_id;

    update public.contract_deliveries set
      status=p_status::public.delivery_status,provider_status=p_provider_event_type,provider_status_at=v_occurred,
      sent_at=case when p_status='sent' then coalesce(sent_at,v_occurred) else sent_at end,
      delivered_at=case when p_status='delivered' then coalesce(delivered_at,v_occurred) else delivered_at end,
      opened_at=case when p_status='opened' then coalesce(opened_at,v_occurred) else opened_at end,
      clicked_at=case when p_status='clicked' then coalesce(clicked_at,v_occurred) else clicked_at end,
      delayed_at=case when p_status='delayed' then coalesce(delayed_at,v_occurred) else delayed_at end,
      bounced_at=case when p_status='bounced' then coalesce(bounced_at,v_occurred) else bounced_at end,
      complained_at=case when p_status='complained' then coalesce(complained_at,v_occurred) else complained_at end,
      suppressed_at=case when p_status='suppressed' then coalesce(suppressed_at,v_occurred) else suppressed_at end,
      failure_code=case when v_permanent then p_status else failure_code end,
      failure_message=case when v_permanent then left(coalesce(p_failure_message,p_provider_event_type),500) else failure_message end
    where tenant_id=p_tenant_id and email_message_id=p_email_message_id
      and (provider_status_at is null or provider_status_at<=v_occurred);
  end if;

  update public.email_delivery_events set projection_applied=v_apply,projection_reason=v_reason where id=v_event_id;
  return jsonb_build_object(
    'duplicate',false,'applied',v_apply,'reason',v_reason,'permanent',v_permanent,
    'contract_id',v_email.contract_id,'customer_id',v_email.customer_id,'status',p_status
  );
end $$;
revoke all on function public.apply_resend_delivery_event(uuid,uuid,text,text,text,timestamptz,jsonb,text) from public,anon,authenticated;
grant execute on function public.apply_resend_delivery_event(uuid,uuid,text,text,text,timestamptz,jsonb,text) to service_role;

-- KX-002/KX-003/KX-013: provider-neutral signing model. Simple web acceptance remains explicitly low assurance.
alter table public.contract_recipients
  add column if not exists required boolean not null default true,
  add column if not exists status text not null default 'pending' check(status in ('pending','sent','delivered','viewed','signing','signed','declined','expired','cancelled')),
  add column if not exists provider_recipient_id text,
  add column if not exists identity_assurance_level text not null default 'low' check(identity_assurance_level in ('low','substantial','high')),
  add column if not exists signed_at timestamptz,
  add column if not exists declined_at timestamptz,
  add column if not exists expired_at timestamptz;

alter table public.contract_template_versions
  add column if not exists signature_policy jsonb not null default '{"method":"simple_click","identityAssuranceLevel":"low","orderedSigning":false,"requireFinalProviderDocument":false}'::jsonb;

-- Keep the legacy web/SMS acceptance path compatible while aggregating all required recipients.
update public.contract_recipients r set
  status=case when a.status in ('accepted_via_sms','accepted_via_web') then 'signed' else 'declined' end,
  identity_assurance_level='low',
  signed_at=case when a.status in ('accepted_via_sms','accepted_via_web') then coalesce(a.accepted_at,a.created_at) else r.signed_at end,
  declined_at=case when a.status='declined' then coalesce(a.created_at,now()) else r.declined_at end
from public.contract_acceptances a
where a.tenant_id=r.tenant_id and a.recipient_id=r.id
  and a.status in ('accepted_via_sms','accepted_via_web','declined');

create or replace function public.sync_contract_recipient_from_acceptance() returns trigger
language plpgsql set search_path=public as $$
begin
  if new.status in ('accepted_via_sms','accepted_via_web') then
    update public.contract_recipients set
      status='signed',identity_assurance_level='low',signed_at=coalesce(signed_at,new.accepted_at,new.created_at),
      declined_at=null,expired_at=null
    where tenant_id=new.tenant_id and id=new.recipient_id;
  elsif new.status='declined' then
    update public.contract_recipients set status='declined',declined_at=coalesce(declined_at,new.created_at)
    where tenant_id=new.tenant_id and id=new.recipient_id;
  end if;
  return new;
end $$;
drop trigger if exists contract_acceptance_sync_recipient on public.contract_acceptances;
create trigger contract_acceptance_sync_recipient after insert on public.contract_acceptances
for each row execute function public.sync_contract_recipient_from_acceptance();
create table if not exists public.signing_envelopes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  contract_id uuid not null,
  contract_version_id uuid not null,
  provider text not null,
  provider_envelope_id text,
  signature_policy jsonb not null,
  status text not null default 'draft' check(status in ('draft','creating','sent','partially_signed','completed','declined','expired','cancelled','failed')),
  final_document_id uuid,
  provider_evidence jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  sent_at timestamptz,completed_at timestamptz,cancelled_at timestamptz,
  created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
  unique(tenant_id,id),unique(provider,provider_envelope_id),
  foreign key(tenant_id,contract_id) references public.contracts(tenant_id,id) on delete cascade,
  foreign key(tenant_id,contract_version_id) references public.contract_versions(tenant_id,id) on delete restrict,
  foreign key(tenant_id,final_document_id) references public.contract_documents(tenant_id,id) on delete restrict
);
create table if not exists public.signing_recipients (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  envelope_id uuid not null,
  contract_recipient_id uuid not null,
  provider_recipient_id text,
  required boolean not null default true,
  role text not null default 'signer',
  signing_order integer not null default 1,
  status text not null default 'pending' check(status in ('pending','sent','delivered','viewed','signing','signed','declined','expired','cancelled')),
  identity_assurance_level text not null default 'low' check(identity_assurance_level in ('low','substantial','high')),
  verified_identity jsonb,
  signed_at timestamptz,declined_at timestamptz,expired_at timestamptz,
  created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
  unique(tenant_id,id),unique(envelope_id,contract_recipient_id),
  foreign key(tenant_id,envelope_id) references public.signing_envelopes(tenant_id,id) on delete cascade,
  foreign key(tenant_id,contract_recipient_id) references public.contract_recipients(tenant_id,id) on delete restrict
);
create table if not exists public.signing_attempts (
  id uuid primary key default gen_random_uuid(),tenant_id uuid not null,envelope_id uuid not null,signing_recipient_id uuid not null,
  provider_transaction_id text,session_token_hash text,status text not null default 'created' check(status in ('created','started','verified','completed','failed','cancelled','expired')),
  verification_method text not null,identity_assurance_level text not null default 'low' check(identity_assurance_level in ('low','substantial','high')),
  verified_contact_point text,verified_identity jsonb,ip_address inet,user_agent text,error_code text,error_message text,
  started_at timestamptz,completed_at timestamptz,created_at timestamptz not null default now(),
  unique(tenant_id,id),unique(provider_transaction_id),
  foreign key(tenant_id,envelope_id) references public.signing_envelopes(tenant_id,id) on delete cascade,
  foreign key(tenant_id,signing_recipient_id) references public.signing_recipients(tenant_id,id) on delete cascade
);
create table if not exists public.signing_events (
  id uuid primary key default gen_random_uuid(),tenant_id uuid not null,envelope_id uuid not null,signing_recipient_id uuid,
  provider text not null,provider_event_id text not null,event_type text not null,event_at timestamptz not null,received_at timestamptz not null default now(),
  verified boolean not null default false,payload jsonb not null default '{}'::jsonb,processing_status text not null default 'received' check(processing_status in ('received','processed','ignored','failed')),
  unique(provider,provider_event_id),foreign key(tenant_id,envelope_id) references public.signing_envelopes(tenant_id,id) on delete cascade,
  foreign key(tenant_id,signing_recipient_id) references public.signing_recipients(tenant_id,id) on delete set null
);
create table if not exists public.signing_documents (
  id uuid primary key default gen_random_uuid(),tenant_id uuid not null,envelope_id uuid not null,contract_document_id uuid not null,
  document_role text not null check(document_role in ('source','final_signed','provider_evidence')),sha256 text not null,provider_document_id text,
  created_at timestamptz not null default now(),unique(tenant_id,id),unique(envelope_id,document_role),
  foreign key(tenant_id,envelope_id) references public.signing_envelopes(tenant_id,id) on delete cascade,
  foreign key(tenant_id,contract_document_id) references public.contract_documents(tenant_id,id) on delete restrict
);
create table if not exists public.contract_post_sign_runs (
  id uuid primary key default gen_random_uuid(),tenant_id uuid not null,contract_id uuid not null,signing_envelope_id uuid not null,
  status text not null default 'completed' check(status in ('processing','completed','failed')),result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),completed_at timestamptz,unique(tenant_id,contract_id),
  foreign key(tenant_id,contract_id) references public.contracts(tenant_id,id) on delete cascade,
  foreign key(tenant_id,signing_envelope_id) references public.signing_envelopes(tenant_id,id) on delete restrict
);

create or replace function public.protect_contract_signing_projection() returns trigger
language plpgsql set search_path=public as $$
begin
  if new.status='accepted' and exists(
    select 1 from public.contract_recipients r
    where r.tenant_id=new.tenant_id and r.contract_id=new.id and r.required and r.status<>'signed'
  ) then
    new.status:='signing';
  end if;
  if new.status='signed' and old.status<>'signed' then
    if exists(
      select 1 from public.contract_recipients r
      where r.tenant_id=new.tenant_id and r.contract_id=new.id and r.required and r.status<>'signed'
    ) then raise exception 'required_contract_recipients_incomplete'; end if;
    if not exists(
      select 1 from public.signing_envelopes e
      where e.tenant_id=new.tenant_id and e.contract_id=new.id and e.contract_version_id=new.active_version_id
        and e.status='completed' and e.final_document_id is not null
    ) then raise exception 'completed_signing_envelope_required'; end if;
  end if;
  return new;
end $$;
drop trigger if exists contracts_signing_projection_guard on public.contracts;
create trigger contracts_signing_projection_guard before update of status on public.contracts
for each row execute function public.protect_contract_signing_projection();

create unique index if not exists activities_post_sign_contract_uidx
  on public.activities(tenant_id,(metadata->>'post_sign_contract_id'))
  where type='onboarding' and metadata ? 'post_sign_contract_id';

create or replace function public.finalize_signing_envelope(
  p_envelope_id uuid,p_final_document_id uuid,p_provider_evidence jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_envelope public.signing_envelopes%rowtype;
  v_document public.contract_documents%rowtype;
  v_contract public.contracts%rowtype;
  v_run uuid;
  v_now timestamptz:=now();
begin
  if auth.role()<>'service_role' then raise exception 'service_role_required'; end if;
  select * into v_envelope from public.signing_envelopes where id=p_envelope_id for update;
  if not found then raise exception 'signing_envelope_not_found'; end if;
  if exists(select 1 from public.signing_recipients where tenant_id=v_envelope.tenant_id and envelope_id=v_envelope.id and required and status<>'signed') then
    raise exception 'required_signers_incomplete';
  end if;
  if exists(
    select 1 from public.signing_events
    where tenant_id=v_envelope.tenant_id and envelope_id=v_envelope.id
      and processing_status<>'ignored' and (not verified or processing_status<>'processed')
  ) then
    raise exception 'unverified_or_unprocessed_signing_events_present';
  end if;
  if coalesce(v_envelope.signature_policy->>'method','simple_click')<>'simple_click'
    and not exists(
      select 1 from public.signing_events
      where tenant_id=v_envelope.tenant_id and envelope_id=v_envelope.id
        and verified and processing_status='processed'
    ) then
    raise exception 'verified_provider_event_required';
  end if;
  select * into v_document from public.contract_documents
    where tenant_id=v_envelope.tenant_id and id=p_final_document_id and contract_id=v_envelope.contract_id
      and contract_version_id=v_envelope.contract_version_id and document_type='signed_pdf';
  if not found or nullif(v_document.sha256,'') is null then raise exception 'final_signed_document_invalid'; end if;
  select * into v_contract from public.contracts where tenant_id=v_envelope.tenant_id and id=v_envelope.contract_id for update;
  if v_contract.active_version_id is distinct from v_envelope.contract_version_id then raise exception 'active_contract_version_changed'; end if;

  update public.contract_versions set locked_at=coalesce(locked_at,v_now)
    where tenant_id=v_envelope.tenant_id and id=v_envelope.contract_version_id;
  update public.signing_envelopes set status='completed',final_document_id=p_final_document_id,
    provider_evidence=coalesce(p_provider_evidence,'{}'::jsonb),completed_at=coalesce(completed_at,v_now),updated_at=v_now
    where id=v_envelope.id;
  insert into public.signing_documents(tenant_id,envelope_id,contract_document_id,document_role,sha256)
    values(v_envelope.tenant_id,v_envelope.id,p_final_document_id,'final_signed',v_document.sha256)
    on conflict(envelope_id,document_role) do nothing;
  update public.contracts set status='signed',signed_at=coalesce(signed_at,v_now)
    where tenant_id=v_envelope.tenant_id and id=v_envelope.contract_id;

  insert into public.contract_post_sign_runs(tenant_id,contract_id,signing_envelope_id,status,completed_at,result)
    values(v_envelope.tenant_id,v_envelope.contract_id,v_envelope.id,'completed',v_now,
      jsonb_build_object('final_document_id',p_final_document_id,'sha256',v_document.sha256))
    on conflict(tenant_id,contract_id) do nothing returning id into v_run;
  if v_run is not null then
    update public.customers set lifecycle='customer',updated_at=v_now
      where tenant_id=v_envelope.tenant_id and id=v_contract.customer_id and lifecycle in ('prospect','lead');
    update public.customer_list_members set state='completed',claim_expires_at=null,claimed_by=null,updated_at=v_now
      where tenant_id=v_envelope.tenant_id and customer_id=v_contract.customer_id and state not in ('completed','blocked');
    update public.contract_reminders set status='cancelled',cancelled_at=v_now,cancel_reason='contract_signed'
      where tenant_id=v_envelope.tenant_id and contract_id=v_envelope.contract_id and status in ('scheduled','queued');
    insert into public.activities(tenant_id,customer_id,contract_id,type,status,title,description,assigned_user_id,assigned_team_id,metadata)
      values(v_envelope.tenant_id,v_contract.customer_id,v_contract.id,'onboarding','open','Starta kundonboarding',
        'Avtalet är fullständigt signerat och kundonboarding ska genomföras.',v_contract.owner_user_id,v_contract.team_id,
        jsonb_build_object('post_sign_contract_id',v_contract.id,'signing_envelope_id',v_envelope.id))
      on conflict do nothing;
    insert into public.contract_events(tenant_id,contract_id,event_type,payload)
      values(v_envelope.tenant_id,v_contract.id,'contract.signed',jsonb_build_object('envelope_id',v_envelope.id,'final_document_id',p_final_document_id,'sha256',v_document.sha256));
    insert into public.audit_logs(tenant_id,action,entity_type,entity_id,after_data)
      values(v_envelope.tenant_id,'contract.signed','contract',v_contract.id::text,
        jsonb_build_object('envelope_id',v_envelope.id,'final_document_id',p_final_document_id,'customer_id',v_contract.customer_id));
    insert into public.outbox_jobs(tenant_id,job_type,aggregate_type,aggregate_id,payload,idempotency_key,priority)
      values(v_envelope.tenant_id,'contract.signed.confirmation','contract',v_contract.id,
        jsonb_build_object('contract_id',v_contract.id,'envelope_id',v_envelope.id,'final_document_id',p_final_document_id),
        'contract.signed.confirmation:'||v_contract.id::text,30)
      on conflict(tenant_id,idempotency_key) do nothing;
  end if;
  return jsonb_build_object('contract_id',v_contract.id,'status','signed','post_sign_executed',v_run is not null,'document_sha256',v_document.sha256);
end $$;
revoke all on function public.finalize_signing_envelope(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.finalize_signing_envelope(uuid,uuid,jsonb) to service_role;

-- KX-014: exactly one opened event through a transactionally locked RPC.
create or replace function public.mark_acceptance_opened(p_request_id uuid) returns jsonb
language plpgsql security definer set search_path=public as $$
declare v_request public.contract_acceptance_requests%rowtype; v_now timestamptz:=now();
begin
  if auth.role()<>'service_role' then raise exception 'service_role_required'; end if;
  select * into v_request from public.contract_acceptance_requests where id=p_request_id for update;
  if not found then raise exception 'acceptance_request_not_found'; end if;
  if v_request.status<>'pending' or v_request.opened_at is not null then
    return jsonb_build_object('opened',false,'opened_at',v_request.opened_at,'status',v_request.status);
  end if;
  update public.contract_acceptance_requests set opened_at=v_now where id=v_request.id;
  insert into public.contract_events(tenant_id,contract_id,event_type,payload)
    values(v_request.tenant_id,v_request.contract_id,'acceptance.opened',jsonb_build_object('request_id',v_request.id,'opened_at',v_now));
  return jsonb_build_object('opened',true,'opened_at',v_now,'status',v_request.status);
end $$;
revoke all on function public.mark_acceptance_opened(uuid) from public,anon,authenticated;
grant execute on function public.mark_acceptance_opened(uuid) to service_role;

alter table public.email_delivery_events enable row level security;
alter table public.signing_envelopes enable row level security;
alter table public.signing_recipients enable row level security;
alter table public.signing_attempts enable row level security;
alter table public.signing_events enable row level security;
alter table public.signing_documents enable row level security;
alter table public.contract_post_sign_runs enable row level security;

create policy email_delivery_events_member_read on public.email_delivery_events for select to authenticated
  using(tenant_id=public.current_tenant_id() and public.is_tenant_member(tenant_id));
create policy signing_envelopes_contract_read on public.signing_envelopes for select to authenticated
  using(tenant_id=public.current_tenant_id() and public.can_access_contract(contract_id));
create policy signing_recipients_contract_read on public.signing_recipients for select to authenticated
  using(tenant_id=public.current_tenant_id() and exists(select 1 from public.signing_envelopes e where e.tenant_id=signing_recipients.tenant_id and e.id=signing_recipients.envelope_id and public.can_access_contract(e.contract_id)));
create policy signing_attempts_admin_read on public.signing_attempts for select to authenticated
  using(tenant_id=public.current_tenant_id() and public.is_tenant_admin(tenant_id));
create policy signing_events_admin_read on public.signing_events for select to authenticated
  using(tenant_id=public.current_tenant_id() and public.is_tenant_admin(tenant_id));
create policy signing_documents_contract_read on public.signing_documents for select to authenticated
  using(tenant_id=public.current_tenant_id() and exists(select 1 from public.signing_envelopes e where e.tenant_id=signing_documents.tenant_id and e.id=signing_documents.envelope_id and public.can_access_contract(e.contract_id)));
create policy contract_post_sign_runs_admin_read on public.contract_post_sign_runs for select to authenticated
  using(tenant_id=public.current_tenant_id() and public.is_tenant_admin(tenant_id));

grant select on public.email_delivery_events,public.signing_envelopes,public.signing_recipients,public.signing_attempts,public.signing_events,public.signing_documents,public.contract_post_sign_runs to authenticated;
grant all on public.email_delivery_events,public.signing_envelopes,public.signing_recipients,public.signing_attempts,public.signing_events,public.signing_documents,public.contract_post_sign_runs to service_role;

commit;
