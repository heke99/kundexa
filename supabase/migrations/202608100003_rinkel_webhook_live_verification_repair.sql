-- Repair migration for the 202608100001 version collision.
-- The linked project may have recorded either the device or webhook migration under
-- version 202608100001. Re-apply the idempotent webhook hardening under a unique
-- forward-only version so production converges regardless of which 001 was recorded.

begin;

-- Rinkel webhook production closure.
--
-- 1. A webhook becomes verified after a real provider event has been processed
--    successfully. Synthetic provider tests are not a production-readiness gate.
-- 2. Webhook ingress is collapsed into one service-role RPC so the public
--    callback can acknowledge Rinkel quickly and durably before the async worker
--    performs correlation/CDR work.
-- 3. Existing successfully processed subscriptions are backfilled to the same
--    verification semantics.

create or replace function private.refresh_platform_rinkel_webhook_readiness(
  p_platform_integration_id uuid,
  p_observed_at timestamptz default pg_catalog.now()
) returns boolean
language plpgsql
security definer
set search_path=''
as $$
declare
  v_core_verified boolean:=false;
  v_core_registered boolean:=false;
  v_required_degraded boolean:=false;
begin
  select count(*)=4
  into v_core_verified
  from public.platform_rinkel_webhook_subscriptions subscription
  where subscription.platform_integration_id=p_platform_integration_id
    and subscription.event_type in ('incomingCall','outgoingCall','callStart','callEnd')
    and subscription.status='verified'
    and subscription.provider_active is true;

  select count(*)=4
  into v_core_registered
  from public.platform_rinkel_webhook_subscriptions subscription
  where subscription.platform_integration_id=p_platform_integration_id
    and subscription.event_type in ('incomingCall','outgoingCall','callStart','callEnd')
    and subscription.required
    and subscription.provider_active is true
    and subscription.status not in ('disabled','unsupported','failed','error');

  select exists(
    select 1
    from public.platform_rinkel_webhook_subscriptions subscription
    where subscription.platform_integration_id=p_platform_integration_id
      and subscription.required
      and subscription.status in ('degraded','failed','error','disabled')
  ) into v_required_degraded;

  update public.platform_integrations integration
  set status=case
        when v_core_verified and integration.last_error_operation in ('webhook_registration','webhook_worker') then 'connected'
        else integration.status
      end,
      webhook_status=case
        when v_core_verified then 'verified'
        when v_required_degraded then 'degraded'
        when v_core_registered then 'registered'
        else integration.webhook_status
      end,
      capabilities=coalesce(integration.capabilities,'{}'::jsonb)
        || pg_catalog.jsonb_build_object(
          'webhooks',v_core_verified,
          'webhooks_registration',v_core_registered,
          'core_webhooks_verified',v_core_verified
        ),
      last_error_code=case
        when v_core_verified and integration.last_error_operation in ('webhook_registration','webhook_worker') then null
        else integration.last_error_code
      end,
      last_error_message=case
        when v_core_verified and integration.last_error_operation in ('webhook_registration','webhook_worker') then null
        else integration.last_error_message
      end,
      last_error_at=case
        when v_core_verified and integration.last_error_operation in ('webhook_registration','webhook_worker') then null
        else integration.last_error_at
      end,
      last_error_operation=case
        when v_core_verified and integration.last_error_operation in ('webhook_registration','webhook_worker') then null
        else integration.last_error_operation
      end,
      updated_at=pg_catalog.now()
  where integration.id=p_platform_integration_id
    and integration.provider='rinkel'
    and integration.is_canonical;

  if not found then
    raise exception 'canonical_rinkel_integration_not_found';
  end if;

  insert into public.platform_rinkel_capabilities(
    platform_integration_id,
    webhooks,
    webhooks_registration,
    core_webhooks_verified,
    detected_at
  ) values(
    p_platform_integration_id,
    v_core_verified,
    v_core_registered,
    v_core_verified,
    p_observed_at
  )
  on conflict(platform_integration_id) do update set
    webhooks=excluded.webhooks,
    webhooks_registration=excluded.webhooks_registration,
    core_webhooks_verified=excluded.core_webhooks_verified,
    detected_at=excluded.detected_at;

  return v_core_verified;
end
$$;
revoke all on function private.refresh_platform_rinkel_webhook_readiness(uuid,timestamptz) from public;

create or replace function public.record_platform_rinkel_webhook_receipt(
  p_platform_integration_id uuid,
  p_event_type text,
  p_received_at timestamptz,
  p_http_status integer,
  p_is_test_receipt boolean default false
) returns void
language plpgsql
security definer
set search_path=''
as $$
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception 'service_role_required';
  end if;

  update public.platform_integrations integration
  set webhook_last_received_at=greatest(
        coalesce(integration.webhook_last_received_at,'-infinity'::timestamptz),
        p_received_at
      ),
      updated_at=pg_catalog.now()
  where integration.id=p_platform_integration_id
    and integration.provider='rinkel'
    and integration.is_canonical;
  if not found then
    raise exception 'canonical_rinkel_integration_not_found';
  end if;

  update public.platform_rinkel_webhook_subscriptions subscription
  set last_received_at=greatest(
        coalesce(subscription.last_received_at,'-infinity'::timestamptz),
        p_received_at
      ),
      test_received_at=case when p_is_test_receipt then p_received_at else subscription.test_received_at end,
      provider_active=true,
      received_count=subscription.received_count+1,
      last_http_status=p_http_status,
      last_error=null,
      last_error_code=null,
      last_error_message=null,
      updated_at=pg_catalog.now()
  where subscription.platform_integration_id=p_platform_integration_id
    and subscription.event_type=p_event_type;
  if not found then
    raise exception 'rinkel_webhook_subscription_not_found';
  end if;
end
$$;
revoke all on function public.record_platform_rinkel_webhook_receipt(uuid,text,timestamptz,integer,boolean)
  from public,anon,authenticated;
grant execute on function public.record_platform_rinkel_webhook_receipt(uuid,text,timestamptz,integer,boolean)
  to service_role;

create or replace function public.record_platform_rinkel_webhook_processed(
  p_platform_integration_id uuid,
  p_event_type text,
  p_processed_at timestamptz
) returns boolean
language plpgsql
security definer
set search_path=''
as $$
declare
  v_core_verified boolean;
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception 'service_role_required';
  end if;

  update public.platform_rinkel_webhook_subscriptions subscription
  set status='verified',
      provider_active=true,
      last_processed_at=greatest(
        coalesce(subscription.last_processed_at,'-infinity'::timestamptz),
        p_processed_at
      ),
      last_verified_at=greatest(
        coalesce(subscription.last_verified_at,'-infinity'::timestamptz),
        p_processed_at
      ),
      processed_count=subscription.processed_count+1,
      last_error=null,
      last_error_code=null,
      last_error_message=null,
      updated_at=pg_catalog.now()
  where subscription.platform_integration_id=p_platform_integration_id
    and subscription.event_type=p_event_type;
  if not found then
    raise exception 'rinkel_webhook_subscription_not_found';
  end if;

  v_core_verified:=private.refresh_platform_rinkel_webhook_readiness(
    p_platform_integration_id,
    p_processed_at
  );

  -- A correlated outgoingCall is the first provider-originated proof that a
  -- Kundexa-reserved dial actually reached Rinkel. Use that real round trip to
  -- close the dial capability instead of pretending a catalog GET tested /dial.
  if p_event_type='outgoingCall' then
    update public.platform_rinkel_capabilities capability
    set dial=true,
        dial_endpoint_reachable=true,
        dial_test_succeeded=true,
        dial_tested_at=greatest(
          coalesce(capability.dial_tested_at,'-infinity'::timestamptz),
          p_processed_at
        ),
        detected_at=p_processed_at
    where capability.platform_integration_id=p_platform_integration_id;

    update public.platform_integrations integration
    set capabilities=coalesce(integration.capabilities,'{}'::jsonb)
          || pg_catalog.jsonb_build_object(
            'dial',true,
            'dial_endpoint_reachable',true,
            'dial_test_succeeded',true
          ),
        updated_at=pg_catalog.now()
    where integration.id=p_platform_integration_id
      and integration.provider='rinkel'
      and integration.is_canonical;
  end if;

  return v_core_verified;
end
$$;
revoke all on function public.record_platform_rinkel_webhook_processed(uuid,text,timestamptz)
  from public,anon,authenticated;
grant execute on function public.record_platform_rinkel_webhook_processed(uuid,text,timestamptz)
  to service_role;

create or replace function public.ingest_platform_rinkel_webhook_event(
  p_event_type text,
  p_external_call_id text,
  p_provider_event_id text,
  p_payload_hash text,
  p_content_type text,
  p_source_ip text,
  p_headers jsonb,
  p_payload jsonb,
  p_event_at timestamptz,
  p_target_url_hash text,
  p_target_url_redacted text,
  p_received_at timestamptz default pg_catalog.now()
) returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_integration_id uuid;
  v_event_id uuid;
  v_duplicate boolean:=false;
  v_required boolean:=p_event_type in ('incomingCall','outgoingCall','callStart','callEnd');
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception 'service_role_required';
  end if;
  if p_event_type not in ('incomingCall','outgoingCall','callStart','callEnd','callInsights') then
    raise exception 'unknown_rinkel_event';
  end if;
  if nullif(pg_catalog.btrim(p_external_call_id),'') is null
     or pg_catalog.length(p_external_call_id)>200 then
    raise exception 'rinkel_external_call_id_invalid';
  end if;
  if nullif(pg_catalog.btrim(p_provider_event_id),'') is null
     or pg_catalog.length(p_provider_event_id)>1000 then
    raise exception 'rinkel_provider_event_id_invalid';
  end if;
  if nullif(pg_catalog.btrim(p_payload_hash),'') is null
     or pg_catalog.length(p_payload_hash)>200 then
    raise exception 'rinkel_payload_hash_invalid';
  end if;

  select integration.id
  into v_integration_id
  from public.platform_integrations integration
  where integration.provider='rinkel'
    and integration.is_canonical
  order by integration.created_at,integration.id
  limit 1;
  if v_integration_id is null then
    raise exception 'canonical_rinkel_integration_not_found';
  end if;

  insert into public.platform_rinkel_webhook_subscriptions(
    platform_integration_id,event_type,target_url_hash,status,required,
    target_url_redacted,provider_active,registered_at,last_error,last_error_code,last_error_message
  ) values(
    v_integration_id,p_event_type,p_target_url_hash,'registered',v_required,
    p_target_url_redacted,true,p_received_at,null,null,null
  )
  on conflict(platform_integration_id,event_type) do update set
    target_url_hash=excluded.target_url_hash,
    target_url_redacted=excluded.target_url_redacted,
    required=excluded.required,
    provider_active=true,
    registered_at=coalesce(
      public.platform_rinkel_webhook_subscriptions.registered_at,
      excluded.registered_at
    ),
    updated_at=pg_catalog.now();

  insert into public.platform_rinkel_webhook_events(
    platform_integration_id,
    event_type,
    external_call_id,
    provider_event_id,
    payload_hash,
    content_type,
    source_ip,
    headers,
    payload,
    event_at,
    status,
    received_at
  ) values(
    v_integration_id,
    p_event_type,
    p_external_call_id,
    p_provider_event_id,
    p_payload_hash,
    p_content_type,
    nullif(pg_catalog.btrim(p_source_ip),'')::inet,
    coalesce(p_headers,'{}'::jsonb),
    coalesce(p_payload,'{}'::jsonb),
    p_event_at,
    'received',
    p_received_at
  )
  on conflict(provider_event_id) do nothing
  returning id into v_event_id;

  if v_event_id is null then
    v_duplicate:=true;
    select event.id
    into v_event_id
    from public.platform_rinkel_webhook_events event
    where event.provider_event_id=p_provider_event_id
      and event.platform_integration_id=v_integration_id
    limit 1;
  end if;
  if v_event_id is null then
    raise exception 'rinkel_webhook_event_upsert_failed';
  end if;

  insert into public.platform_rinkel_jobs(
    job_type,aggregate_id,idempotency_key,payload,status,available_at
  ) values(
    'rinkel.process_event',
    v_event_id,
    'rinkel.process_event:'||v_event_id::text,
    pg_catalog.jsonb_build_object('event_id',v_event_id),
    'pending',
    p_received_at
  )
  on conflict(idempotency_key) do nothing;

  perform public.record_platform_rinkel_webhook_receipt(
    v_integration_id,
    p_event_type,
    p_received_at,
    200,
    false
  );

  insert into public.platform_audit_logs(
    actor_user_id,action,entity_type,entity_id,metadata
  ) values(
    null,
    case when v_duplicate then 'rinkel.webhook_duplicate' else 'rinkel.webhook_received' end,
    'platform_rinkel_webhook_event',
    v_event_id::text,
    pg_catalog.jsonb_build_object(
      'event_type',p_event_type,
      'provider_event_id',p_provider_event_id,
      'ingest_mode','atomic_rpc'
    )
  );

  return pg_catalog.jsonb_build_object(
    'event_id',v_event_id,
    'platform_integration_id',v_integration_id,
    'duplicate',v_duplicate
  );
end
$$;
revoke all on function public.ingest_platform_rinkel_webhook_event(
  text,text,text,text,text,text,jsonb,jsonb,timestamptz,text,text,timestamptz
) from public,anon,authenticated;
grant execute on function public.ingest_platform_rinkel_webhook_event(
  text,text,text,text,text,text,jsonb,jsonb,timestamptz,text,text,timestamptz
) to service_role;

-- A successfully processed historical provider event is already sufficient
-- evidence that registration, delivery, parsing, correlation and worker handling
-- worked. Align those rows with the new live verification semantics.
update public.platform_rinkel_webhook_subscriptions subscription
set status='verified',
    provider_active=true,
    last_verified_at=coalesce(
      subscription.last_verified_at,
      subscription.last_processed_at,
      subscription.last_received_at
    ),
    updated_at=pg_catalog.now()
where subscription.processed_count>0
  and subscription.last_processed_at is not null
  and subscription.status<>'disabled';

do $$
declare
  v_integration record;
begin
  for v_integration in
    select integration.id
    from public.platform_integrations integration
    where integration.provider='rinkel' and integration.is_canonical
  loop
    perform private.refresh_platform_rinkel_webhook_readiness(
      v_integration.id,
      pg_catalog.now()
    );
  end loop;
end
$$;

-- An incomingCall only identifies the called Rinkel number. A number therefore
-- cannot be actively owned by more than one tenant without making inbound
-- correlation ambiguous. It may still be shared by several teams inside the
-- same tenant. Preserve any pre-existing cross-tenant rows for audit, surface
-- them as conflicts, and prevent creation of new ambiguous allocations.
create or replace function private.enforce_rinkel_number_single_active_tenant()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
begin
  if new.status='active' and new.valid_to is null and exists(
    select 1
    from public.rinkel_number_allocations allocation
    where allocation.rinkel_number_id=new.rinkel_number_id
      and allocation.tenant_id<>new.tenant_id
      and allocation.status='active'
      and allocation.valid_to is null
      and allocation.id<>new.id
  ) then
    raise exception 'RINKEL_NUMBER_TENANT_CONFLICT';
  end if;
  return new;
end
$$;
revoke all on function private.enforce_rinkel_number_single_active_tenant() from public;

drop trigger if exists rinkel_number_allocations_single_active_tenant on public.rinkel_number_allocations;
create trigger rinkel_number_allocations_single_active_tenant
before insert or update of rinkel_number_id,tenant_id,status,valid_to
on public.rinkel_number_allocations
for each row execute function private.enforce_rinkel_number_single_active_tenant();

insert into public.platform_rinkel_conflicts(
  conflict_type,provider_resource_type,provider_resource_key,claimed_tenant_ids,details,status
)
select
  'RINKEL_NUMBER_TENANT_CONFLICT',
  'number',
  allocation.rinkel_number_id::text,
  array_agg(distinct allocation.tenant_id),
  pg_catalog.jsonb_build_object(
    'active_allocation_count',count(*),
    'reason','One Rinkel number has active allocations in multiple tenants; inbound routing is ambiguous.'
  ),
  'open'
from public.rinkel_number_allocations allocation
where allocation.status='active' and allocation.valid_to is null
group by allocation.rinkel_number_id
having count(distinct allocation.tenant_id)>1
on conflict(conflict_type,provider_resource_key) where status='open' do nothing;

-- Recovery states are local uncertainty markers, not provider lifecycle progress.
-- They must not outrank a later real outgoingCall/callStart event. Otherwise a
-- late but valid provider event is treated as a status regression and the CRM
-- remains stuck in reconciliation_required/provider_outcome_unknown until callEnd.
create or replace function public.call_status_rank(p_status text) returns integer
language sql
immutable
set search_path=''
as $$
  select case p_status
    when 'queued' then 0
    when 'requested' then 10
    when 'initiating' then 20
    when 'dial_requested' then 20
    when 'awaiting_provider_event' then 20
    when 'initiated' then 20
    when 'provider_outcome_unknown' then 20
    when 'reconciliation_required' then 20
    when 'ringing' then 30
    when 'answered' then 40
    when 'in_progress' then 40
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

-- The monotonic projection must compare provider timestamps only against prior
-- provider lifecycle states. Recovery markers use local clock time and therefore
-- cannot be allowed to reject a later-arriving Rinkel event whose provider
-- datetime is naturally earlier than the recovery job's local timestamp.
create or replace function public.protect_rinkel_call_projection() returns trigger
language plpgsql
set search_path=''
as $$
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
    or (
      old.status not in ('provider_outcome_unknown','reconciliation_required')
      and old.provider_state_updated_at is not null
      and new.provider_state_updated_at is not null
      and new.provider_state_updated_at < old.provider_state_updated_at
    ) then
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
end
$$;

-- HTTP 204 from POST /dial means Rinkel accepted the dial request; it is not a
-- provider lifecycle event timestamp. Keep provider_state_updated_at and
-- initiated_at reserved for outgoingCall/CDR timestamps so a valid webhook that
-- was emitted just before the 204 response cannot be rejected as "older".
create or replace function public.rinkel_finalize_platform_dial(
  p_call_id uuid,
  p_attempt_id uuid,
  p_outcome text,
  p_error_code text default null,
  p_error_message text default null
) returns void
language plpgsql
security definer
set search_path=''
as $$
declare
  v_tenant uuid;
  v_now timestamptz:=pg_catalog.now();
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then
    raise exception 'service_role_required';
  end if;
  if p_outcome not in ('accepted','failed','unknown') then
    raise exception 'invalid_dial_outcome';
  end if;

  select call_row.tenant_id
  into v_tenant
  from public.calls call_row
  where call_row.id=p_call_id
    and call_row.provider='rinkel'
  for update;
  if v_tenant is null or not exists(
    select 1
    from public.rinkel_call_attempts_v2 attempt
    where attempt.id=p_attempt_id
      and attempt.call_id=p_call_id
      and attempt.tenant_id=v_tenant
  ) then
    raise exception 'rinkel_attempt_not_found';
  end if;

  update public.rinkel_call_attempts_v2 attempt
  set status=case p_outcome
        when 'accepted' then 'awaiting_provider_event'
        when 'unknown' then 'provider_outcome_unknown'
        else 'failed'
      end,
      provider_request_finished_at=v_now,
      error_code=p_error_code,
      error_message=pg_catalog.left(p_error_message,500),
      updated_at=v_now
  where attempt.id=p_attempt_id;

  update public.calls call_row
  set status=case p_outcome
        when 'accepted' then 'dial_requested'
        when 'unknown' then 'provider_outcome_unknown'
        else 'failed'
      end,
      provider_status=case p_outcome
        when 'accepted' then 'requested'
        when 'unknown' then 'unknown'
        else 'failed'
      end,
      provider_outcome=case when p_outcome='failed' then 'provider_error' else call_row.provider_outcome end,
      -- Only a definitive provider rejection owns this local terminal timestamp.
      -- accepted/unknown wait for outgoingCall/callStart/callEnd/CDR provider time.
      provider_state_updated_at=case when p_outcome='failed' then v_now else call_row.provider_state_updated_at end,
      ended_at=case when p_outcome='failed' then coalesce(call_row.ended_at,v_now) else call_row.ended_at end,
      end_cause=case when p_outcome='failed' then coalesce(p_error_code,'RINKEL_DIAL_FAILED') else call_row.end_cause end,
      provider_cause=case when p_outcome='failed' then coalesce(p_error_code,'RINKEL_DIAL_FAILED') else call_row.provider_cause end
  where call_row.id=p_call_id
    and call_row.tenant_id=v_tenant
    and call_row.status not in ('completed','unanswered','blocked','voicemail','outside_business_hours','cancelled');

  insert into public.audit_logs(tenant_id,action,entity_type,entity_id,after_data)
  values(
    v_tenant,
    'rinkel.dial_'||p_outcome,
    'call',
    p_call_id::text,
    pg_catalog.jsonb_build_object('attempt_id',p_attempt_id,'error_code',p_error_code)
  );

  if p_outcome='unknown' then
    insert into public.platform_rinkel_jobs(job_type,aggregate_id,idempotency_key,payload,available_at)
    values(
      'rinkel.reconcile_call',
      p_call_id,
      'rinkel.reconcile_call:unknown_dial:'||p_call_id::text,
      pg_catalog.jsonb_build_object('attempt_id',p_attempt_id,'call_id',p_call_id,'reason','unknown_dial'),
      pg_catalog.now()+interval '30 seconds'
    )
    on conflict(idempotency_key) do nothing;
  end if;
end
$$;
revoke all on function public.rinkel_finalize_platform_dial(uuid,uuid,text,text,text)
  from public,anon,authenticated;
grant execute on function public.rinkel_finalize_platform_dial(uuid,uuid,text,text,text)
  to service_role;

-- Repair only still-unmatched active attempts created by the old finalize
-- behavior. No terminal or already-correlated call is changed.
update public.calls call_row
set provider_state_updated_at=null,
    initiated_at=null
where call_row.provider='rinkel'
  and call_row.external_call_id is null
  and call_row.ended_at is null
  and call_row.status in ('dial_requested','provider_outcome_unknown','reconciliation_required')
  and call_row.provider_status in ('requested','unknown');

create or replace function public.correlate_rinkel_outgoing_event(
  p_event_id uuid,
  p_attempt_id uuid
) returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_event public.platform_rinkel_webhook_events%rowtype;
  v_attempt public.rinkel_call_attempts_v2%rowtype;
  v_call public.calls%rowtype;
  v_occurred timestamptz;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then
    raise exception 'service_role_required';
  end if;

  select * into v_event
  from public.platform_rinkel_webhook_events event
  where event.id=p_event_id
  for update;
  if not found then raise exception 'rinkel_event_not_found'; end if;
  if v_event.status='processed' and v_event.correlated_call_id is not null then
    return pg_catalog.jsonb_build_object(
      'status','processed',
      'call_id',v_event.correlated_call_id,
      'idempotent_replay',true
    );
  end if;

  select * into v_attempt
  from public.rinkel_call_attempts_v2 attempt
  where attempt.id=p_attempt_id
  for update;
  if not found then raise exception 'rinkel_attempt_not_found'; end if;

  if v_event.event_type<>'outgoingCall'
    or nullif(v_event.payload->>'userId','') is distinct from v_attempt.external_rinkel_user_id
    or nullif(v_event.payload->>'to','') is distinct from v_attempt.destination_number_e164
    or (
      coalesce(nullif(v_event.payload->>'from',''),'anonymous')<>'anonymous'
      and nullif(v_event.payload->>'from','') is distinct from v_attempt.source_number_e164
    ) then
    raise exception 'rinkel_outgoing_event_payload_mismatch';
  end if;

  select * into v_call
  from public.calls call_row
  where call_row.tenant_id=v_attempt.tenant_id
    and call_row.id=v_attempt.call_id
  for update;
  if not found then raise exception 'rinkel_call_not_found'; end if;

  v_occurred:=coalesce(v_event.event_at,v_event.received_at);

  update public.rinkel_call_attempts_v2 attempt
  set status='matched',
      external_call_id=v_event.external_call_id,
      updated_at=pg_catalog.now()
  where attempt.id=v_attempt.id
    and attempt.tenant_id=v_attempt.tenant_id;

  update public.calls call_row
  set external_call_id=v_event.external_call_id,
      status='ringing',
      initiated_at=least(coalesce(call_row.initiated_at,v_occurred),v_occurred),
      provider_status='initiated',
      provider_outcome=null,
      provider_state_updated_at=v_occurred
  where call_row.id=v_call.id
    and call_row.tenant_id=v_call.tenant_id;

  insert into public.call_events(
    tenant_id,call_id,event_type,provider_event_id,occurred_at,payload
  ) values(
    v_call.tenant_id,
    v_call.id,
    v_event.event_type,
    v_event.provider_event_id,
    v_occurred,
    pg_catalog.jsonb_build_object(
      'external_call_id',v_event.external_call_id,
      'attempt_id',v_attempt.id
    )
  )
  on conflict(tenant_id,provider_event_id) do nothing;

  insert into public.audit_logs(
    tenant_id,actor_user_id,action,entity_type,entity_id,after_data
  ) values(
    v_call.tenant_id,
    v_call.user_id,
    'rinkel.outgoing_call_correlated',
    'call',
    v_call.id::text,
    pg_catalog.jsonb_build_object(
      'attempt_id',v_attempt.id,
      'provider_call_id',v_event.external_call_id
    )
  );

  update public.platform_rinkel_webhook_events event
  set tenant_id=v_call.tenant_id,
      status='processed',
      correlation_status='correlated',
      correlated_call_id=v_call.id,
      correlated_attempt_id=v_attempt.id,
      correlation_key='call:'||v_call.id::text,
      next_retry_at=null,
      last_error=null,
      processed_at=pg_catalog.now()
  where event.id=v_event.id;

  return pg_catalog.jsonb_build_object(
    'status','processed',
    'call_id',v_call.id,
    'tenant_id',v_call.tenant_id,
    'attempt_id',v_attempt.id,
    'idempotent_replay',false
  );
end
$$;
revoke all on function public.correlate_rinkel_outgoing_event(uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.correlate_rinkel_outgoing_event(uuid,uuid)
  to service_role;

commit;
