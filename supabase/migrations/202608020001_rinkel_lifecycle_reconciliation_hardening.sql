begin;

-- Keep the provider's technical lifecycle separate from Kundexa's CRM disposition.
alter table public.calls
  add column if not exists provider_outcome text;

update public.calls
set provider_status = case provider_status
  when 'outgoingCall' then 'initiated'
  when 'incomingCall' then 'initiated'
  when 'callStart' then 'connected'
  when 'callEnd' then 'ended'
  when 'provider_outcome_unknown' then 'unknown'
  when 'requesting' then 'requesting'
  when 'requested' then 'requested'
  when 'initiated' then 'initiated'
  when 'connected' then 'connected'
  when 'ended' then 'ended'
  when 'failed' then 'failed'
  when 'unknown' then 'unknown'
  else case when provider_status is null then null else 'unknown' end
end
where provider='rinkel';

update public.calls
set provider_outcome = case coalesce(provider_cause,end_cause)
  when 'ANSWERED' then 'answered'
  when 'UNANSWERED' then 'no_answer'
  when 'BLACKLISTED' then 'blocked'
  when 'VOICEMAIL' then 'voicemail'
  when 'CALLCENTER' then 'answering_service'
  when 'OUTSIDE_OPERATION_TIMES' then 'outside_business_hours'
  else case when coalesce(provider_cause,end_cause) is null then null else 'unknown' end
end
where provider='rinkel' and provider_outcome is null;

alter table public.calls drop constraint if exists calls_rinkel_provider_status_check;
alter table public.calls add constraint calls_rinkel_provider_status_check check(
  provider<>'rinkel' or provider_status is null or provider_status in (
    'requesting','requested','initiated','connected','ended','failed','unknown'
  )
);
alter table public.calls drop constraint if exists calls_rinkel_provider_outcome_check;
alter table public.calls add constraint calls_rinkel_provider_outcome_check check(
  provider<>'rinkel' or provider_outcome is null or provider_outcome in (
    'answered','no_answer','blocked','voicemail','answering_service',
    'outside_business_hours','provider_error','unknown'
  )
);
create index if not exists calls_rinkel_provider_projection_idx
  on public.calls(tenant_id,provider_status,provider_outcome,created_at desc)
  where provider='rinkel';

-- Existing data may contain more than one active recording row for a call. Keep
-- the oldest canonical row active and soft-delete later duplicates before adding
-- the invariant used by webhook and CDR upserts.
with ranked as (
  select id,row_number() over(partition by tenant_id,call_id,provider order by created_at,id) as position
  from public.call_recordings
  where deleted_at is null
)
update public.call_recordings r
set deleted_at=now(),status='deleted',updated_at=now()
from ranked d where d.id=r.id and d.position>1;
create unique index if not exists call_recordings_one_active_provider_call_uidx
  on public.call_recordings(tenant_id,call_id,provider)
  where deleted_at is null;

create or replace function public.protect_rinkel_call_projection() returns trigger
language plpgsql set search_path=public as $$
begin
  if old.provider<>'rinkel' or new.provider<>'rinkel' then return new; end if;
  if current_setting('app.rinkel_reconciliation',true)='on' then return new; end if;
  if old.recording_status in ('available_at_provider','copy_pending','stored_privately')
    and new.recording_status in ('not_expected','pending','unavailable') then
    new.recording_status:=old.recording_status;
  end if;
  if public.call_status_rank(old.status)=100 and new.status<>old.status then
    new.status:=old.status;
    new.answered_at:=old.answered_at;
    new.ended_at:=old.ended_at;
    new.duration_seconds:=old.duration_seconds;
    new.end_cause:=old.end_cause;
    new.provider_status:=old.provider_status;
    new.provider_outcome:=old.provider_outcome;
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
      new.provider_outcome:=old.provider_outcome;
      new.provider_cause:=old.provider_cause;
      new.provider_state_updated_at:=old.provider_state_updated_at;
  end if;
  return new;
end $$;

create or replace function public.correlate_rinkel_incoming_event(
  p_event_id uuid,p_tenant_id uuid,p_allocation_id uuid,p_number_id uuid,p_from text,p_to text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_event public.platform_rinkel_webhook_events%rowtype;
  v_call public.calls%rowtype;
  v_occurred timestamptz;
  v_customer_ids uuid[]:='{}';
  v_contact_ids uuid[]:='{}';
  v_customer_id uuid;
  v_contact_id uuid;
begin
  if auth.role()<>'service_role' then raise exception 'service_role_required'; end if;
  if not exists(
    select 1 from public.rinkel_number_allocations a
    join public.platform_rinkel_numbers n on n.id=a.rinkel_number_id
    where a.id=p_allocation_id and a.tenant_id=p_tenant_id and a.rinkel_number_id=p_number_id
      and a.status='active' and a.valid_to is null and n.active and n.phone_number_e164=p_to
  ) then raise exception 'rinkel_incoming_allocation_mismatch'; end if;

  select * into v_event from public.platform_rinkel_webhook_events where id=p_event_id for update;
  if not found then raise exception 'rinkel_event_not_found'; end if;
  if v_event.event_type<>'incomingCall'
    or nullif(v_event.payload->>'to','') is distinct from p_to
    or coalesce(nullif(v_event.payload->>'from',''),'anonymous') is distinct from coalesce(nullif(p_from,''),'anonymous') then
    raise exception 'rinkel_incoming_event_payload_mismatch';
  end if;
  if v_event.status='processed' and v_event.correlated_call_id is not null then
    return jsonb_build_object('status','processed','call_id',v_event.correlated_call_id,'idempotent_replay',true);
  end if;
  v_occurred:=coalesce(v_event.event_at,v_event.received_at);

  if p_from is not null and p_from<>'anonymous' then
    select coalesce(array_agg(distinct candidate.customer_id),'{}'::uuid[]) into v_customer_ids
    from (
      select c.id customer_id from public.customers c
      where c.tenant_id=p_tenant_id and c.deleted_at is null
        and p_from in (c.phone_e164,c.alternate_phone_e164)
      union
      select cp.customer_id from public.contact_people cp
      join public.customers c on c.tenant_id=cp.tenant_id and c.id=cp.customer_id and c.deleted_at is null
      where cp.tenant_id=p_tenant_id and p_from in (cp.phone_e164,cp.alternate_phone_e164)
    ) candidate;
    if cardinality(v_customer_ids)=1 then
      v_customer_id:=v_customer_ids[1];
      select coalesce(array_agg(cp.id),'{}'::uuid[]) into v_contact_ids
      from public.contact_people cp
      where cp.tenant_id=p_tenant_id and cp.customer_id=v_customer_id
        and p_from in (cp.phone_e164,cp.alternate_phone_e164);
      if cardinality(v_contact_ids)=1 then v_contact_id:=v_contact_ids[1]; end if;
    end if;
  end if;

  select * into v_call from public.calls
    where tenant_id=p_tenant_id and provider='rinkel' and external_call_id=v_event.external_call_id
    order by created_at desc limit 1 for update;
  if not found then
    insert into public.calls(
      tenant_id,provider,external_call_id,direction,from_number,to_number,status,callback_token_hash,
      customer_id,contact_person_id,metadata,initiated_at,provider_status,provider_state_updated_at
    ) values(
      p_tenant_id,'rinkel',v_event.external_call_id,'inbound',coalesce(nullif(p_from,''),'anonymous'),p_to,'ringing',
      replace(gen_random_uuid()::text,'-',''),v_customer_id,v_contact_id,
      jsonb_build_object(
        'platform_integration_id',v_event.platform_integration_id,
        'number_allocation_id',p_allocation_id,
        'platform_rinkel_number_id',p_number_id,
        'inbound_match',case when v_customer_id is null then 'unmatched' else 'unique_customer' end
      ),v_occurred,'initiated',v_occurred
    ) returning * into v_call;
  else
    update public.calls set
      customer_id=coalesce(customer_id,v_customer_id),
      contact_person_id=coalesce(contact_person_id,v_contact_id),
      provider_status='initiated',provider_state_updated_at=v_occurred
    where tenant_id=p_tenant_id and id=v_call.id returning * into v_call;
  end if;

  insert into public.call_events(tenant_id,call_id,event_type,provider_event_id,occurred_at,payload)
  values(p_tenant_id,v_call.id,v_event.event_type,v_event.provider_event_id,v_occurred,
    jsonb_build_object('external_call_id',v_event.external_call_id,'number_allocation_id',p_allocation_id,
      'customer_id',v_customer_id,'contact_person_id',v_contact_id))
  on conflict(tenant_id,provider_event_id) do nothing;
  insert into public.audit_logs(tenant_id,action,entity_type,entity_id,after_data)
  values(p_tenant_id,'rinkel.incoming_call_correlated','call',v_call.id::text,
    jsonb_build_object('provider_call_id',v_event.external_call_id,'customer_id',v_customer_id,
      'contact_person_id',v_contact_id,'matched_customer_count',cardinality(v_customer_ids)));
  update public.platform_rinkel_webhook_events set
    tenant_id=p_tenant_id,status='processed',correlation_status='correlated',correlated_call_id=v_call.id,
    correlation_key='call:'||v_call.id::text,next_retry_at=null,last_error=null,processed_at=now()
  where id=v_event.id;
  return jsonb_build_object('status','processed','call_id',v_call.id,'tenant_id',p_tenant_id,
    'customer_id',v_customer_id,'contact_person_id',v_contact_id,'idempotent_replay',false);
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
  if v_event.event_type<>'outgoingCall'
    or nullif(v_event.payload->>'userId','') is distinct from v_attempt.external_rinkel_user_id
    or nullif(v_event.payload->>'to','') is distinct from v_attempt.destination_number_e164
    or (coalesce(nullif(v_event.payload->>'from',''),'anonymous')<>'anonymous'
        and nullif(v_event.payload->>'from','') is distinct from v_attempt.source_number_e164) then
    raise exception 'rinkel_outgoing_event_payload_mismatch';
  end if;
  select * into v_call from public.calls where tenant_id=v_attempt.tenant_id and id=v_attempt.call_id for update;
  if not found then raise exception 'rinkel_call_not_found'; end if;
  v_occurred:=coalesce(v_event.event_at,v_event.received_at);
  update public.rinkel_call_attempts_v2 set
    status='matched',external_call_id=v_event.external_call_id,updated_at=now()
  where id=v_attempt.id and tenant_id=v_attempt.tenant_id;
  update public.calls set
    external_call_id=v_event.external_call_id,status='ringing',initiated_at=coalesce(initiated_at,v_occurred),
    provider_status='initiated',provider_outcome=null,provider_state_updated_at=v_occurred
  where id=v_call.id and tenant_id=v_call.tenant_id;
  insert into public.call_events(tenant_id,call_id,event_type,provider_event_id,occurred_at,payload)
  values(v_call.tenant_id,v_call.id,v_event.event_type,v_event.provider_event_id,v_occurred,
    jsonb_build_object('external_call_id',v_event.external_call_id,'attempt_id',v_attempt.id))
  on conflict(tenant_id,provider_event_id) do nothing;
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
  values(v_call.tenant_id,v_call.user_id,'rinkel.outgoing_call_correlated','call',v_call.id::text,
    jsonb_build_object('attempt_id',v_attempt.id,'provider_call_id',v_event.external_call_id));
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
  v_policy public.telephony_policies%rowtype;
  v_occurred timestamptz;
  v_cause text;
  v_status text;
  v_outcome text;
  v_started timestamptz;
  v_recording_url text;
  v_recording_id text;
  v_call_count integer;
begin
  if auth.role()<>'service_role' then raise exception 'service_role_required'; end if;
  select * into v_event from public.platform_rinkel_webhook_events where id=p_event_id for update;
  if not found then raise exception 'rinkel_event_not_found'; end if;
  if v_event.event_type not in ('callStart','callEnd','callInsights') then
    raise exception 'rinkel_lifecycle_event_type_invalid';
  end if;
  if v_event.status='processed' then return jsonb_build_object('status','processed','call_id',v_event.correlated_call_id); end if;

  select count(*) into v_call_count from public.calls
  where provider='rinkel' and external_call_id=v_event.external_call_id;
  if v_call_count>1 then raise exception 'rinkel_external_call_id_conflict'; end if;
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
      provider_status='connected',provider_state_updated_at=v_occurred,
      metadata=metadata||jsonb_strip_nulls(jsonb_build_object(
        'rinkel_answered_by',nullif(v_event.payload->>'answeredBy',''),
        'rinkel_choice',nullif(v_event.payload->>'choice','')
      ))
    where id=v_call.id and tenant_id=v_call.tenant_id
    returning * into v_call;
    if v_call.provider_status='connected' then
      insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
      values(v_call.tenant_id,v_call.user_id,'rinkel.call_connected','call',v_call.id::text,
        jsonb_build_object('provider_call_id',v_event.external_call_id,'occurred_at',v_occurred));
    end if;
  elsif v_event.event_type='callEnd' then
    v_cause:=coalesce(nullif(v_event.payload->>'cause',''),'UNKNOWN');
    v_outcome:=case v_cause
      when 'ANSWERED' then 'answered'
      when 'UNANSWERED' then 'no_answer'
      when 'BLACKLISTED' then 'blocked'
      when 'VOICEMAIL' then 'voicemail'
      when 'CALLCENTER' then 'answering_service'
      when 'OUTSIDE_OPERATION_TIMES' then 'outside_business_hours'
      else 'unknown'
    end;
    v_status:=case v_cause
      when 'ANSWERED' then 'completed'
      when 'CALLCENTER' then 'completed'
      when 'UNANSWERED' then 'unanswered'
      when 'BLACKLISTED' then 'blocked'
      when 'VOICEMAIL' then 'voicemail'
      when 'OUTSIDE_OPERATION_TIMES' then 'outside_business_hours'
      else case when v_call.answered_at is not null then 'completed' else 'failed' end
    end;
    v_started:=coalesce(v_call.answered_at,v_call.initiated_at,v_call.started_at,v_call.created_at,v_occurred);
    v_recording_url:=nullif(v_event.payload->>'callRecordingUrl','');
    if v_recording_url is not null
      and v_recording_url !~ '^https://api[.]rinkel[.]com/(v1/)?call-recordings/[A-Za-z0-9_-]+/stream/?$' then
      v_recording_url:=null;
    end if;
    if v_recording_url is not null then
      v_recording_id:=substring(v_recording_url from 'call-recordings/([A-Za-z0-9_-]+)/stream');
      if v_recording_id is null or v_recording_id !~ '^[A-Za-z0-9_-]+$' then v_recording_id:=null; end if;
    end if;
    update public.calls set
      status=v_status,end_cause=v_cause,ended_at=greatest(coalesce(ended_at,v_occurred),v_occurred),
      duration_seconds=greatest(0,floor(extract(epoch from (v_occurred-v_started)))::integer),
      recording_status=case when v_recording_url is not null then 'available_at_provider' else 'unavailable' end,
      provider_status='ended',provider_outcome=v_outcome,provider_cause=v_cause,provider_state_updated_at=v_occurred
    where id=v_call.id and tenant_id=v_call.tenant_id;
    update public.rinkel_call_attempts_v2 set status='completed',updated_at=now(),external_call_id=coalesce(external_call_id,v_event.external_call_id)
    where tenant_id=v_call.tenant_id and call_id=v_call.id;

    if v_recording_url is not null then
      select * into v_policy from public.telephony_policies where tenant_id=v_call.tenant_id;
      insert into public.call_recordings(
        tenant_id,call_id,provider_recording_id,provider,provider_reference,storage_mode,status,
        available_at,last_checked_at,retention_until,retention_delete_at,updated_at
      ) values(
        v_call.tenant_id,v_call.id,v_recording_id,'rinkel',v_event.external_call_id,
        coalesce(v_policy.recording_storage_mode,'provider_only'),'available_at_provider',v_occurred,now(),
        now()+make_interval(days=>coalesce(v_policy.recording_retention_days,90)),
        now()+make_interval(days=>coalesce(v_policy.recording_retention_days,90)),now()
      ) on conflict(tenant_id,call_id,provider) where deleted_at is null do update set
        provider_recording_id=coalesce(excluded.provider_recording_id,public.call_recordings.provider_recording_id),
        provider_reference=excluded.provider_reference,status='available_at_provider',
        available_at=coalesce(public.call_recordings.available_at,excluded.available_at),
        last_checked_at=excluded.last_checked_at,updated_at=excluded.updated_at;
    end if;

    insert into public.platform_rinkel_jobs(job_type,aggregate_id,idempotency_key,payload)
    values('rinkel.reconcile_call',v_call.id,'rinkel.reconcile_call:call_end:'||v_call.id::text,
      jsonb_build_object('call_id',v_call.id,'tenant_id',v_call.tenant_id,'external_call_id',v_event.external_call_id,'reason','call_end'))
    on conflict(idempotency_key) do nothing;
    if v_call.transcription_status<>'disabled' or v_call.insights_status<>'disabled' then
      insert into public.platform_rinkel_jobs(job_type,aggregate_id,idempotency_key,payload,available_at)
      values('rinkel.enrich_call',v_call.id,'rinkel.enrich_call:'||v_call.id::text,
        jsonb_build_object('call_id',v_call.id,'tenant_id',v_call.tenant_id,'external_call_id',v_event.external_call_id),now()+interval '30 seconds')
      on conflict(idempotency_key) do nothing;
    end if;
    insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
    values(v_call.tenant_id,v_call.user_id,'rinkel.call_ended','call',v_call.id::text,
      jsonb_build_object('provider_call_id',v_event.external_call_id,'provider_cause',v_cause,
        'provider_outcome',v_outcome,'recording_available',v_recording_url is not null));
  elsif v_event.event_type='callInsights' then
    insert into public.call_insights(tenant_id,call_id,source,status,sentiment,topics,summary,analysis,generated_at)
    values(v_call.tenant_id,v_call.id,'rinkel','available',nullif(v_event.payload->>'sentiment',''),
      case when jsonb_typeof(v_event.payload->'topics')='array'
        then array(select jsonb_array_elements_text(v_event.payload->'topics')) else '{}'::text[] end,
      nullif(v_event.payload->>'summary',''),
      jsonb_build_object('payload_version',1,'provider_event_id',v_event.provider_event_id,'unverified_ai_output',true),now())
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

create or replace function public.reconcile_rinkel_call_from_cdr(
  p_call_id uuid,
  p_external_call_id text,
  p_started_at timestamptz default null,
  p_answered_at timestamptz default null,
  p_ended_at timestamptz default null,
  p_duration_seconds integer default null,
  p_cause text default null,
  p_recording_id text default null,
  p_provider_payload jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_call public.calls%rowtype;
  v_policy public.telephony_policies%rowtype;
  v_outcome text;
  v_status text;
  v_state_at timestamptz:=coalesce(p_ended_at,p_answered_at,p_started_at,now());
begin
  if auth.role()<>'service_role' then raise exception 'service_role_required'; end if;
  select * into v_call from public.calls where id=p_call_id and provider='rinkel' for update;
  if not found then raise exception 'rinkel_call_not_found'; end if;
  perform set_config('app.rinkel_reconciliation','on',true);
  if p_external_call_id is null or p_external_call_id='' or length(p_external_call_id)>200 then
    raise exception 'rinkel_external_call_id_required';
  end if;
  if p_cause is not null and p_cause !~ '^[A-Z][A-Z0-9_]{1,99}$' then raise exception 'rinkel_cdr_cause_invalid'; end if;
  if p_recording_id is not null and p_recording_id !~ '^[A-Za-z0-9_-]+$' then raise exception 'rinkel_cdr_recording_id_invalid'; end if;
  if p_duration_seconds is not null and p_duration_seconds<0 then raise exception 'rinkel_cdr_duration_invalid'; end if;
  if v_call.external_call_id is not null and v_call.external_call_id<>p_external_call_id then
    raise exception 'rinkel_external_call_id_conflict';
  end if;
  v_outcome:=case p_cause
    when 'ANSWERED' then 'answered' when 'UNANSWERED' then 'no_answer'
    when 'BLACKLISTED' then 'blocked' when 'VOICEMAIL' then 'voicemail'
    when 'CALLCENTER' then 'answering_service'
    when 'OUTSIDE_OPERATION_TIMES' then 'outside_business_hours'
    else case when p_cause is null then v_call.provider_outcome else 'unknown' end
  end;
  v_status:=case p_cause
    when 'ANSWERED' then 'completed' when 'CALLCENTER' then 'completed'
    when 'UNANSWERED' then 'unanswered' when 'BLACKLISTED' then 'blocked'
    when 'VOICEMAIL' then 'voicemail' when 'OUTSIDE_OPERATION_TIMES' then 'outside_business_hours'
    else case when p_ended_at is not null then case when coalesce(p_answered_at,v_call.answered_at) is not null then 'completed' else 'failed' end else v_call.status end
  end;
  update public.calls set
    external_call_id=p_external_call_id,
    status=v_status,
    initiated_at=case when p_started_at is null then initiated_at else least(coalesce(initiated_at,p_started_at),p_started_at) end,
    answered_at=case when p_answered_at is null then answered_at else least(coalesce(answered_at,p_answered_at),p_answered_at) end,
    ended_at=case when p_ended_at is null then ended_at else greatest(coalesce(ended_at,p_ended_at),p_ended_at) end,
    duration_seconds=coalesce(p_duration_seconds,duration_seconds),
    end_cause=coalesce(p_cause,end_cause),provider_cause=coalesce(p_cause,provider_cause),
    provider_outcome=v_outcome,
    provider_status=case when p_ended_at is not null then 'ended' when p_answered_at is not null then 'connected' else 'initiated' end,
    provider_state_updated_at=v_state_at,
    recording_status=case when p_recording_id is not null then 'available_at_provider' else recording_status end,
    metadata=metadata||jsonb_build_object('rinkel_cdr_reconciled_at',now(),'rinkel_cdr',coalesce(p_provider_payload,'{}'::jsonb))
  where id=v_call.id and tenant_id=v_call.tenant_id;
  update public.rinkel_call_attempts_v2 set
    external_call_id=coalesce(external_call_id,p_external_call_id),
    status=case when p_ended_at is not null then 'completed' else 'matched' end,updated_at=now()
  where tenant_id=v_call.tenant_id and call_id=v_call.id;
  if p_recording_id is not null and p_recording_id~'^[A-Za-z0-9_-]+$' then
    select * into v_policy from public.telephony_policies where tenant_id=v_call.tenant_id;
    insert into public.call_recordings(
      tenant_id,call_id,provider_recording_id,provider,provider_reference,storage_mode,status,
      available_at,last_checked_at,retention_until,retention_delete_at,updated_at
    ) values(
      v_call.tenant_id,v_call.id,p_recording_id,'rinkel',p_external_call_id,
      coalesce(v_policy.recording_storage_mode,'provider_only'),'available_at_provider',now(),now(),
      now()+make_interval(days=>coalesce(v_policy.recording_retention_days,90)),
      now()+make_interval(days=>coalesce(v_policy.recording_retention_days,90)),now()
    ) on conflict(tenant_id,call_id,provider) where deleted_at is null do update set
      provider_recording_id=excluded.provider_recording_id,provider_reference=excluded.provider_reference,
      status='available_at_provider',available_at=coalesce(public.call_recordings.available_at,excluded.available_at),
      last_checked_at=excluded.last_checked_at,updated_at=excluded.updated_at;
  end if;
  if v_call.transcription_status<>'disabled' or v_call.insights_status<>'disabled' then
    insert into public.platform_rinkel_jobs(job_type,aggregate_id,idempotency_key,payload,available_at)
    values('rinkel.enrich_call',v_call.id,'rinkel.enrich_call:'||v_call.id::text,
      jsonb_build_object('call_id',v_call.id,'tenant_id',v_call.tenant_id,'external_call_id',p_external_call_id),now()+interval '30 seconds')
    on conflict(idempotency_key) do nothing;
  end if;
  insert into public.audit_logs(tenant_id,action,entity_type,entity_id,after_data)
  values(v_call.tenant_id,'rinkel.call_reconciled_from_cdr','call',v_call.id::text,
    jsonb_build_object('provider_call_id',p_external_call_id,'provider_cause',p_cause,
      'provider_outcome',v_outcome,'recording_available',p_recording_id is not null));
  return jsonb_build_object('status','reconciled','call_id',v_call.id,'tenant_id',v_call.tenant_id,
    'external_call_id',p_external_call_id,'provider_outcome',v_outcome);
end $$;
revoke all on function public.reconcile_rinkel_call_from_cdr(uuid,text,timestamptz,timestamptz,timestamptz,integer,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.reconcile_rinkel_call_from_cdr(uuid,text,timestamptz,timestamptz,timestamptz,integer,text,text,jsonb) to service_role;

create or replace function public.rinkel_finalize_platform_dial(
  p_call_id uuid,p_attempt_id uuid,p_outcome text,p_error_code text default null,p_error_message text default null
) returns void
language plpgsql security definer set search_path=public as $$
declare v_tenant uuid; v_now timestamptz:=now();
begin
  if auth.role()<>'service_role' then raise exception 'service_role_required'; end if;
  if p_outcome not in ('accepted','failed','unknown') then raise exception 'invalid_dial_outcome'; end if;
  select tenant_id into v_tenant from public.calls where id=p_call_id and provider='rinkel' for update;
  if v_tenant is null or not exists(
    select 1 from public.rinkel_call_attempts_v2 where id=p_attempt_id and call_id=p_call_id and tenant_id=v_tenant
  ) then raise exception 'rinkel_attempt_not_found'; end if;
  update public.rinkel_call_attempts_v2 set
    status=case p_outcome when 'accepted' then 'awaiting_provider_event' when 'unknown' then 'provider_outcome_unknown' else 'failed' end,
    provider_request_finished_at=v_now,error_code=p_error_code,error_message=left(p_error_message,500),updated_at=v_now
  where id=p_attempt_id;
  update public.calls set
    status=case p_outcome when 'accepted' then 'dial_requested' when 'unknown' then 'provider_outcome_unknown' else 'failed' end,
    provider_status=case p_outcome when 'accepted' then 'requested' when 'unknown' then 'unknown' else 'failed' end,
    provider_outcome=case when p_outcome='failed' then 'provider_error' else provider_outcome end,
    provider_state_updated_at=v_now,
    initiated_at=case when p_outcome='accepted' then coalesce(initiated_at,v_now) else initiated_at end,
    ended_at=case when p_outcome='failed' then coalesce(ended_at,v_now) else ended_at end,
    end_cause=case when p_outcome='failed' then coalesce(p_error_code,'RINKEL_DIAL_FAILED') else end_cause end,
    provider_cause=case when p_outcome='failed' then coalesce(p_error_code,'RINKEL_DIAL_FAILED') else provider_cause end
  where id=p_call_id and tenant_id=v_tenant
    and status not in ('completed','unanswered','blocked','voicemail','outside_business_hours','cancelled');
  insert into public.audit_logs(tenant_id,action,entity_type,entity_id,after_data)
  values(v_tenant,'rinkel.dial_'||p_outcome,'call',p_call_id::text,
    jsonb_build_object('attempt_id',p_attempt_id,'error_code',p_error_code));
  if p_outcome='unknown' then
    insert into public.platform_rinkel_jobs(job_type,aggregate_id,idempotency_key,payload,available_at)
    values('rinkel.reconcile_call',p_call_id,'rinkel.reconcile_call:unknown_dial:'||p_call_id::text,
      jsonb_build_object('attempt_id',p_attempt_id,'call_id',p_call_id,'reason','unknown_dial'),now()+interval '30 seconds')
    on conflict(idempotency_key) do nothing;
  end if;
end $$;
revoke all on function public.rinkel_finalize_platform_dial(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.rinkel_finalize_platform_dial(uuid,uuid,text,text,text) to service_role;

commit;
