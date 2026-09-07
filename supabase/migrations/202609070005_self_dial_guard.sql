-- Self-dial guard for outbound calls.
--
-- Rinkel refuses `POST /dial` with `{"errors":[{"id":"to","code":"DIALING_SELF"}]}`
-- when `to` is the seller's own line. Kundexa learned about that only after it had
-- created a `calls` row, burned an attempt and marked the call `failed`, and it
-- forwarded Rinkel's raw JSON body to the seller as the error message.
--
-- Reject the self-dial during reservation instead, before any row exists. The
-- seller's own number is already in the synced provider record as
-- `raw_provider_data -> 'phoneNumber' ->> 'e164'`; the assigned caller-ID number
-- would loop the same way, so both are refused.
--
-- The search_path is pinned to `public, extensions` in the header: this function
-- calls digest() from pgcrypto, and a later `create or replace` that omits the
-- SET clause silently drops the hardening (see FAILURE-0040).

create or replace function public.rinkel_reserve_platform_outbound_call_v2(
  p_customer_id uuid,
  p_contact_person_id uuid,
  p_target_phone text,
  p_session_id uuid,
  p_list_member_id uuid,
  p_callback_activity_id uuid,
  p_client_request_id uuid,
  p_idempotency_key text,
  p_purpose text default 'direct_marketing',
  p_number_allocation_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_tenant uuid:=public.current_tenant_id();
  v_user uuid:=auth.uid();
  v_customer public.customers%rowtype;
  v_contact public.contact_people%rowtype;
  v_policy public.telephony_policies%rowtype;
  v_mapping record;
  v_caller record;
  v_existing record;
  v_existing_count integer:=0;
  v_call uuid;
  v_attempt uuid;
  v_local timestamp;
  v_is_automatic boolean:=false;
  v_list_id uuid;
  v_purpose text;
  v_callback_team_id uuid;
  v_effective_team_id uuid;
  v_exact_policy jsonb;
  v_self_phone text;
begin
  if v_tenant is null or v_user is null then raise exception 'authentication_required'; end if;
  if not public.has_current_role(array['owner','admin','team_lead','sales']) then raise exception 'call_create_permission_required'; end if;
  if p_client_request_id is null or nullif(trim(p_idempotency_key),'') is null then raise exception 'idempotency_required'; end if;
  if p_target_phone !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'target_phone_invalid'; end if;

  select count(distinct a.id) into v_existing_count
  from public.rinkel_call_attempts_v2 a
  where a.tenant_id=v_tenant and (a.client_request_id=p_client_request_id or a.idempotency_key=p_idempotency_key);
  if v_existing_count>1 then raise exception 'idempotency_identity_conflict'; end if;

  select c.id call_id,a.id attempt_id,a.status attempt_status,c.status call_status,c.provider_status into v_existing
  from public.calls c join public.rinkel_call_attempts_v2 a on a.tenant_id=c.tenant_id and a.call_id=c.id
  where c.tenant_id=v_tenant and (a.client_request_id=p_client_request_id or a.idempotency_key=p_idempotency_key)
  order by a.requested_at desc,a.id
  limit 1;
  if found then
    return jsonb_build_object('callId',v_existing.call_id,'attemptId',v_existing.attempt_id,
      'status',v_existing.call_status,'attemptStatus',v_existing.attempt_status,
      'providerStatus',coalesce(v_existing.provider_status,'unknown'),
      'callActive',v_existing.attempt_status in (
        'requested','dial_requested','awaiting_provider_event','matched',
        'provider_outcome_unknown','reconciliation_required'
      ),
      'message',case
        when v_existing.attempt_status='failed' then 'Det tidigare samtalsförsöket misslyckades.'
        when v_existing.attempt_status in ('provider_outcome_unknown','reconciliation_required')
          then 'Det tidigare samtalsförsökets providerutfall är ännu okänt.'
        when v_existing.attempt_status='completed' or v_existing.call_status in ('completed','failed','cancelled','blocked','unanswered')
          then 'Det tidigare samtalsförsöket är redan avslutat.'
        else 'Det befintliga samtalsförsöket återanvänds.' end,
      'idempotentReplay',true);
  end if;

  if not exists(select 1 from public.tenants where id=v_tenant and status in ('trial','active')) then raise exception 'tenant_not_active'; end if;
  if not exists(select 1 from public.tenant_features where tenant_id=v_tenant and feature_key='outbound_calls' and enabled)
    then raise exception 'outbound_calls_feature_disabled'; end if;
  select * into v_policy from public.telephony_policies where tenant_id=v_tenant;
  if not found or not v_policy.telephony_enabled then raise exception 'TELEPHONY_DISABLED'; end if;
  v_local:=now() at time zone v_policy.timezone;
  if not (extract(isodow from v_local)::integer=any(v_policy.allowed_days)
    and v_local::time>=v_policy.allowed_start_time and v_local::time<v_policy.allowed_end_time)
    then raise exception 'TELEPHONY_OUTSIDE_ALLOWED_TIME'; end if;

  select * into v_customer from public.customers
  where tenant_id=v_tenant and id=p_customer_id and deleted_at is null for share;
  if not found then raise exception 'customer_not_found'; end if;
  if p_contact_person_id is not null then
    select * into v_contact from public.contact_people
      where tenant_id=v_tenant and id=p_contact_person_id and customer_id=p_customer_id;
  end if;
  if p_callback_activity_id is not null then
    select a.assigned_team_id into v_callback_team_id
    from public.activities a where a.tenant_id=v_tenant and a.id=p_callback_activity_id and a.customer_id=p_customer_id and a.type='callback';
  end if;
  v_exact_policy:=public.evaluate_exact_call_policy(
    v_tenant,v_user,p_customer_id,p_contact_person_id,p_target_phone,
    p_session_id,p_list_member_id,p_callback_activity_id,null
  );
  if coalesce(v_exact_policy->>'allowed','false')<>'true' then
    raise exception 'exact_call_policy_denied:%',coalesce(v_exact_policy->>'reason','unknown');
  end if;
  v_purpose:=v_exact_policy->>'purpose';
  if v_purpose is null then raise exception 'exact_call_policy_purpose_missing'; end if;

  if p_session_id is not null or p_list_member_id is not null then
    if p_session_id is null or p_list_member_id is null then raise exception 'list_call_context_incomplete'; end if;
    select ds.list_id,(ds.mode='automatic') into v_list_id,v_is_automatic
    from public.dialer_sessions ds
    join public.customer_list_members lm on lm.tenant_id=ds.tenant_id and lm.list_id=ds.list_id
      and lm.id=p_list_member_id and lm.customer_id=p_customer_id
      and lm.claimed_by=v_user and lm.claim_expires_at>now()
    join public.customer_lists l on l.tenant_id=ds.tenant_id and l.id=ds.list_id and l.status='active'
    where ds.tenant_id=v_tenant and ds.id=p_session_id and ds.user_id=v_user and ds.state in ('active','after_call')
    for update of ds,lm;
    if not found then raise exception 'dialer_session_or_claim_not_active'; end if;
    if v_is_automatic and not v_policy.automatic_dialer_enabled then raise exception 'automatic_dialer_disabled'; end if;
  elsif p_callback_activity_id is not null and not exists(
    select 1 from public.activities a where a.tenant_id=v_tenant and a.id=p_callback_activity_id
      and a.customer_id=p_customer_id and a.type='callback' and a.status in ('open','in_progress')
      and (a.assigned_user_id=v_user or (a.callback_scope='global' and a.claimed_by=v_user))
      and (a.assigned_team_id is null or public.can_operate_in_team(a.assigned_team_id,v_user))
      and (a.list_id is null or public.can_work_customer_list(a.list_id))
  ) then raise exception 'callback_not_available'; end if;

  if v_is_automatic then
    if not v_policy.automatic_dialer_enabled then raise exception 'automatic_dialer_disabled'; end if;
  elsif not v_policy.manual_dialer_enabled then
    raise exception 'manual_dialer_disabled';
  end if;

  -- Rinkel models the seller device as a single nullable scalar on the provider
  -- user; it has no devices endpoint. Resolve the dial device from the live
  -- provider record instead of requiring a device row chosen at mapping time,
  -- so a seller becomes dialable as soon as the catalog reports a device.
  select m.id mapping_id,m.rinkel_user_allocation_id,m.default_number_allocation_id,
    pi.id platform_integration_id,pi.status integration_status,
    coalesce(pc.api_access,false) api_access,coalesce(pc.dial_configured,false) dial_configured,
    pu.id rinkel_user_id,pu.external_user_id,
    nullif(trim(pu.raw_provider_data->'phoneNumber'->>'e164'),'') provider_user_phone_e164,
    device.device_row_id selected_device_id,device.provider_device_id external_device_id
  into v_mapping
  from public.rinkel_user_mappings_v2 m
  join public.rinkel_user_allocations ua on ua.id=m.rinkel_user_allocation_id
    and ua.tenant_id=m.tenant_id and ua.status='active' and ua.valid_to is null
  join public.platform_rinkel_users pu on pu.id=ua.rinkel_user_id and pu.active
  join public.platform_integrations pi on pi.id=pu.platform_integration_id
    and pi.provider='rinkel' and pi.is_canonical and pi.disabled_at is null
  left join public.platform_rinkel_capabilities pc on pc.platform_integration_id=pi.id
  left join lateral public.rinkel_effective_provider_device(pu.id,m.selected_device_id) device on true
  where m.tenant_id=v_tenant and m.kundexa_user_id=v_user and m.active;
  if not found then raise exception 'USER_MAPPING_MISSING'; end if;
  if v_mapping.integration_status not in ('connected','degraded') or not v_mapping.api_access
    then raise exception 'RINKEL_API_NOT_VERIFIED'; end if;
  -- The selected active user/device plus the caller-ID resolver are the runtime
  -- dial contract. Do not block a valid call merely because the denormalized
  -- catalog capability bit is stale after an otherwise successful sync.

  if v_list_id is not null then
    select l.team_id into v_effective_team_id from public.customer_lists l where l.tenant_id=v_tenant and l.id=v_list_id;
  else
    v_effective_team_id:=coalesce(v_callback_team_id,v_customer.assigned_team_id);
  end if;
  if v_effective_team_id is not null and not (public.can_operate_in_team(v_effective_team_id,v_user) or public.is_tenant_admin(v_tenant)) then
    raise exception 'DIAL_TEAM_PERMISSION_REQUIRED';
  end if;

  select * into v_caller
  from public.resolve_rinkel_caller_id(
    v_tenant,v_user,v_effective_team_id,v_list_id,v_customer.campaign_id,
    p_number_allocation_id,v_mapping.default_number_allocation_id
  );
  if not found then
    if p_number_allocation_id is not null then raise exception 'DIAL_PERMISSION_DENIED'; end if;
    raise exception 'NUMBER_ALLOCATION_MISSING';
  end if;
  if p_number_allocation_id is not null and v_caller.number_allocation_id<>p_number_allocation_id
    then raise exception 'DIAL_PERMISSION_DENIED'; end if;
  if v_mapping.external_device_id is null or v_caller.provider_number_id is null then
    raise exception 'DIAL_CONFIGURATION_INCOMPLETE';
  end if;

  -- Rinkel rejects a dial whose `to` is the seller's own line, and dialling the
  -- assigned caller-ID number would loop the call back to the same trunk. Refuse
  -- here so no call row, attempt or list-member state change is produced for a
  -- destination the provider will never accept.
  v_self_phone:=v_mapping.provider_user_phone_e164;
  if p_target_phone=v_caller.phone_number_e164 or (v_self_phone is not null and p_target_phone=v_self_phone) then
    raise exception 'SELF_DIAL_NOT_ALLOWED';
  end if;

  if v_is_automatic and not exists(
    select 1
    from public.platform_integrations pi
    join public.platform_rinkel_capabilities pc on pc.platform_integration_id=pi.id
    where pi.id=v_mapping.platform_integration_id
      and pi.webhook_status='verified'
      and pc.core_webhooks_verified
      and exists(
        select 1 from public.platform_worker_heartbeats h
        where h.worker_key='rinkel-platform-worker'
          and h.last_success_at>now()-interval '3 minutes'
      )
  ) then raise exception 'RINKEL_AUTODIALER_NOT_READY'; end if;

  perform pg_advisory_xact_lock(hashtextextended(v_tenant::text||':'||v_user::text,0));
  if exists(select 1 from public.rinkel_call_attempts_v2 where
    (tenant_id=v_tenant and seller_user_id=v_user or
     platform_integration_id=v_mapping.platform_integration_id and rinkel_device_id=v_mapping.external_device_id)
    and status in ('requested','dial_requested','awaiting_provider_event','matched','provider_outcome_unknown','reconciliation_required')
  ) then raise exception 'active_call_already_exists'; end if;

  insert into public.calls(
    tenant_id,provider,customer_id,contact_person_id,user_id,team_id,direction,from_number,to_number,status,
    provider_user_id,provider_device_id,recording_enabled,recording_status,transcription_status,insights_status,
    idempotency_key,purpose,list_id,list_member_id,dialer_session_id,callback_activity_id,callback_token_hash,metadata
  ) values(
    v_tenant,'rinkel',p_customer_id,p_contact_person_id,v_user,v_customer.assigned_team_id,'outbound',
    v_caller.phone_number_e164,p_target_phone,'requested',v_mapping.external_user_id,v_mapping.external_device_id,
    v_policy.recording_enabled,case when v_policy.recording_enabled then 'pending' else 'not_expected' end,
    case when v_policy.transcription_enabled then 'pending' else 'disabled' end,
    case when v_policy.ai_analysis_enabled then 'pending' else 'disabled' end,
    p_idempotency_key,v_purpose,v_list_id,p_list_member_id,p_session_id,p_callback_activity_id,
    encode(digest(p_idempotency_key,'sha256'),'hex'),
    jsonb_build_object(
      'platform_integration_id',v_mapping.platform_integration_id,
      'mapping_id',v_mapping.mapping_id,'user_allocation_id',v_mapping.rinkel_user_allocation_id,
      'number_allocation_id',v_caller.number_allocation_id,
      'caller_id_source',v_caller.allocation_source,
      'rinkel_user_id',v_mapping.rinkel_user_id,'rinkel_number_id',v_caller.rinkel_number_id,
      'external_rinkel_user_id',v_mapping.external_user_id,
      'external_rinkel_number_id',v_caller.provider_number_id,
      'derived_purpose',v_purpose,'client_purpose_hint',p_purpose,'effective_team_id',v_effective_team_id,'exact_call_policy',v_exact_policy
    )
  ) returning id into v_call;

  insert into public.rinkel_call_attempts_v2(
    tenant_id,call_id,seller_user_id,platform_integration_id,mapping_id,user_allocation_id,number_allocation_id,
    rinkel_user_id,rinkel_number_id,external_rinkel_user_id,external_rinkel_number_id,rinkel_device_id,
    selected_device_id,caller_id_source,caller_id_allocation_id,source_number_e164,destination_number_e164,client_request_id,idempotency_key
  ) values(
    v_tenant,v_call,v_user,v_mapping.platform_integration_id,v_mapping.mapping_id,
    v_mapping.rinkel_user_allocation_id,v_caller.number_allocation_id,
    v_mapping.rinkel_user_id,v_caller.rinkel_number_id,v_mapping.external_user_id,
    v_caller.provider_number_id,v_mapping.external_device_id,
    v_mapping.selected_device_id,v_caller.allocation_source,v_caller.number_allocation_id,v_caller.phone_number_e164,
    p_target_phone,p_client_request_id,p_idempotency_key
  ) returning id into v_attempt;
  if p_session_id is not null then
    update public.customer_list_members set state='dialing',attempts=attempts+1,last_call_id=v_call,
      last_contacted_at=now(),claim_expires_at=now()+interval '2 hours'
      where tenant_id=v_tenant and id=p_list_member_id;
    update public.dialer_sessions set state='calling',current_call_id=v_call,last_seen_at=now()
      where tenant_id=v_tenant and id=p_session_id;
  end if;
  if p_callback_activity_id is not null then
    update public.activities set status='in_progress',claimed_by=v_user,claim_expires_at=now()+interval '2 hours',call_id=v_call
      where tenant_id=v_tenant and id=p_callback_activity_id;
  end if;
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
  values(v_tenant,v_user,'rinkel.call_reserved','call',v_call::text,
    jsonb_build_object('attempt_id',v_attempt,'customer_id',p_customer_id,'destination_suffix',right(p_target_phone,4)));
  return jsonb_build_object(
    'callId',v_call,'attemptId',v_attempt,'deviceId',v_mapping.external_device_id,
    'numberId',v_caller.provider_number_id,'to',p_target_phone,'status','requested',
    'attemptStatus','requested','providerStatus','requesting','callerIdSource',v_caller.allocation_source,
    'callerIdAllocationId',v_caller.number_allocation_id,'purpose',v_purpose,'idempotentReplay',false
  );
end $$;
revoke all on function public.rinkel_reserve_platform_outbound_call_v2(uuid,uuid,text,uuid,uuid,uuid,uuid,text,text,uuid) from public,anon;
grant execute on function public.rinkel_reserve_platform_outbound_call_v2(uuid,uuid,text,uuid,uuid,uuid,uuid,text,text,uuid) to authenticated;
