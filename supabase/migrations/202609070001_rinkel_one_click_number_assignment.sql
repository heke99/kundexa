-- Rinkel outbound activation: live device resolution and one-click number assignment.
--
-- Builds directly on 20260814124751, which already stopped a missing provider
-- device from blocking allocation and seller mapping. Two defects remained.
--
-- 1. The dial path and the readiness projection still required a synchronized
--    `platform_rinkel_devices` row chosen when the mapping was saved. Rinkel has
--    no devices endpoint: `GET /users/:id` reports at most one device, as the
--    nullable scalar `deviceId`. A seller mapped before that device existed
--    therefore stayed permanently undialable even after the device appeared, and
--    a replaced device left the mapping pointing at a removed row. The device is
--    now resolved from the live provider record at dial time, with the mapping's
--    explicit choice kept as a preference.
--
-- 2. The platform could only grant a number to teams, through a form with a
--    mandatory reason, after which seller activation was a separate tenant-side
--    step. `rinkel_number_grants` and `resolve_rinkel_caller_id` already support
--    tenant-wide, team and per-user grants, so a single assignment RPC now covers
--    organisation, team and individual seller, and performs every step needed to
--    make that target dialable.
--
-- Forward-only: no delivered migration is edited and no public RPC signature changes.

-- ---------------------------------------------------------------------------
-- Live provider device resolution
-- ---------------------------------------------------------------------------

create or replace function public.rinkel_effective_provider_device(
  p_rinkel_user_id uuid,
  p_selected_device_id uuid default null
) returns table(device_row_id uuid, provider_device_id text)
language sql
stable
security definer
set search_path=''
as $$
  select candidate.device_row_id, candidate.provider_device_id
  from (
    select
      device.id as device_row_id,
      device.provider_device_id,
      1 as source_rank,
      (device.id = p_selected_device_id) as preferred,
      device.last_synced_at
    from public.platform_rinkel_devices device
    where device.platform_rinkel_user_id = p_rinkel_user_id
      and device.active

    union all

    -- Rinkel has no devices endpoint; `GET /users/:id` carries the device as a
    -- nullable scalar. Use it when no inventory row has been synchronized yet.
    select
      null::uuid,
      provider_user.external_device_id,
      2,
      false,
      provider_user.last_synced_at
    from public.platform_rinkel_users provider_user
    where provider_user.id = p_rinkel_user_id
      and provider_user.active
      and provider_user.external_device_id is not null
  ) candidate
  order by
    candidate.source_rank,
    candidate.preferred desc,
    candidate.last_synced_at desc,
    candidate.device_row_id
  limit 1;
$$;
comment on function public.rinkel_effective_provider_device(uuid,uuid) is
  'Resolves the Rinkel provider device id for a platform provider user: the explicitly selected active device, then any active synchronized device, then the scalar deviceId on the synchronized provider user. Returns no row when the provider reports no device.';
revoke all on function public.rinkel_effective_provider_device(uuid,uuid) from public,anon,authenticated;

-- ---------------------------------------------------------------------------
-- Call reservation resolves the device from the live provider record
-- ---------------------------------------------------------------------------

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
language plpgsql security definer set search_path=public as $$
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

-- ---------------------------------------------------------------------------
-- One-click number assignment: organisation, team or individual seller
-- ---------------------------------------------------------------------------

-- Links one Kundexa seller to a central Rinkel user and makes the given number
-- allocation that seller's default caller id. Returns the outcome so the caller
-- can report exactly which sellers still need attention.
create or replace function public.rinkel_link_seller_to_provider_user(
  p_tenant_id uuid,
  p_user_id uuid,
  p_number_allocation_id uuid,
  p_rinkel_user_id uuid,
  p_actor uuid,
  p_reason text
) returns text
language plpgsql
security definer
set search_path=''
as $$
declare
  v_provider_user uuid:=p_rinkel_user_id;
  v_candidate_count integer:=0;
  v_email text;
  v_allocation uuid;
  v_device uuid;
begin
  if exists(
    select 1 from public.rinkel_user_mappings_v2 mapping
    where mapping.tenant_id=p_tenant_id
      and mapping.kundexa_user_id=p_user_id
      and mapping.active
  ) then
    return 'already_linked';
  end if;

  if v_provider_user is null then
    select membership_user.email into v_email
    from auth.users membership_user
    where membership_user.id=p_user_id;

    if v_email is null or pg_catalog.btrim(v_email)='' then
      return 'no_seller_email';
    end if;

    select pg_catalog.count(*)::integer into v_candidate_count
    from public.platform_rinkel_users provider_user
    where provider_user.active
      and provider_user.email is not null
      and pg_catalog.lower(provider_user.email::text)=pg_catalog.lower(v_email);

    if v_candidate_count>1 then return 'ambiguous_provider_user'; end if;

    select provider_user.id into v_provider_user
    from public.platform_rinkel_users provider_user
    where provider_user.active
      and provider_user.email is not null
      and pg_catalog.lower(provider_user.email::text)=pg_catalog.lower(v_email)
    limit 1;
  end if;

  -- No address match. A single free provider user paired with a single
  -- unmapped seller is still unambiguous, and is the normal shape of a
  -- one-user Rinkel subscription whose provider address differs from the
  -- Kundexa login address. Anything less certain stays manual.
  if v_provider_user is null then
    select pg_catalog.count(*)::integer into v_candidate_count
    from public.platform_rinkel_users provider_user
    where provider_user.active
      and not exists(
        select 1
        from public.rinkel_user_allocations allocation
        join public.rinkel_user_mappings_v2 mapping
          on mapping.rinkel_user_allocation_id=allocation.id and mapping.active
        where allocation.rinkel_user_id=provider_user.id
          and allocation.status='active'
          and allocation.valid_to is null
      );
    if v_candidate_count<>1 then return 'no_provider_user'; end if;

    select provider_user.id into v_provider_user
    from public.platform_rinkel_users provider_user
    where provider_user.active
      and not exists(
        select 1
        from public.rinkel_user_allocations allocation
        join public.rinkel_user_mappings_v2 mapping
          on mapping.rinkel_user_allocation_id=allocation.id and mapping.active
        where allocation.rinkel_user_id=provider_user.id
          and allocation.status='active'
          and allocation.valid_to is null
      )
    limit 1;

    if exists(
      select 1
      from public.tenant_memberships membership
      where membership.tenant_id=p_tenant_id
        and membership.status='active'
        and membership.user_id<>p_user_id
        and not exists(
          select 1 from public.rinkel_user_mappings_v2 mapping
          where mapping.tenant_id=p_tenant_id
            and mapping.kundexa_user_id=membership.user_id
            and mapping.active
        )
    ) then
      return 'no_provider_user';
    end if;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('rinkel-user:'||v_provider_user::text||':'||p_tenant_id::text,0)
  );
  select allocation.id into v_allocation
  from public.rinkel_user_allocations allocation
  where allocation.rinkel_user_id=v_provider_user
    and allocation.tenant_id=p_tenant_id
    and allocation.status='active'
    and allocation.valid_to is null
  for update;
  if v_allocation is null then
    insert into public.rinkel_user_allocations(
      rinkel_user_id,tenant_id,allocated_by,allocation_reason
    ) values(v_provider_user,p_tenant_id,p_actor,p_reason)
    returning id into v_allocation;
  end if;

  if exists(
    select 1 from public.rinkel_user_mappings_v2 mapping
    where mapping.rinkel_user_allocation_id=v_allocation and mapping.active
  ) then
    return 'provider_user_taken';
  end if;

  select device.id into v_device
  from public.platform_rinkel_devices device
  where device.platform_rinkel_user_id=v_provider_user
    and device.active
  order by device.last_synced_at desc,device.id
  limit 1;

  insert into public.rinkel_user_mappings_v2(
    tenant_id,kundexa_user_id,rinkel_user_allocation_id,
    default_number_allocation_id,selected_device_id,created_by
  ) values(
    p_tenant_id,p_user_id,v_allocation,
    p_number_allocation_id,v_device,p_actor
  );
  return 'linked';
end
$$;
revoke all on function public.rinkel_link_seller_to_provider_user(uuid,uuid,uuid,uuid,uuid,text)
  from public,anon,authenticated;


-- Assigns one central Rinkel number to an organisation, to teams or to individual
-- sellers, and performs every remaining step required to make that target dialable:
-- number allocation, dial grant, scope default caller id, telephony activation,
-- provider-user allocation and seller mapping.
create or replace function public.assign_platform_rinkel_number(
  p_number_id uuid,
  p_scope text,
  p_tenant_id uuid default null,
  p_team_ids uuid[] default null,
  p_user_ids uuid[] default null,
  p_rinkel_user_id uuid default null,
  p_activate_telephony boolean default true,
  p_reason text default null
) returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_actor uuid:=auth.uid();
  v_reason text:=coalesce(nullif(pg_catalog.btrim(coalesce(p_reason,'')),''),'Tilldelad i plattformsadministrationen');
  v_targets jsonb;
  v_requested integer;
  v_target record;
  v_tenant uuid;
  v_seller uuid;
  v_allocation uuid;
  v_grant uuid;
  v_link text;
  v_target_count integer:=0;
  v_tenant_count integer:=0;
  v_seller_count integer:=0;
  v_linked integer:=0;
  v_already integer:=0;
  v_unresolved integer:=0;
  v_ready integer:=0;
  v_activated integer:=0;
  v_unresolved_reasons jsonb:='{}'::jsonb;
begin
  if v_actor is null or not public.is_platform_role(array[
    'platform_owner'::public.platform_role,
    'platform_admin'::public.platform_role
  ]) then
    raise exception 'PLATFORM_ADMIN_REQUIRED';
  end if;
  if p_scope is null or p_scope not in ('tenant','team','user') then
    raise exception 'INVALID_ASSIGNMENT_SCOPE';
  end if;
  if not exists(
    select 1 from public.platform_rinkel_numbers
    where id=p_number_id and active
  ) then
    raise exception 'PHONE_NUMBER_INACTIVE';
  end if;
  if p_rinkel_user_id is not null then
    if p_scope<>'user' then raise exception 'EXPLICIT_PROVIDER_USER_REQUIRES_SELLER_SCOPE'; end if;
    if not exists(select 1 from public.platform_rinkel_users where id=p_rinkel_user_id and active) then
      raise exception 'RINKEL_USER_INACTIVE';
    end if;
  end if;

  -- Resolve the assignment scope into an explicit list of grant targets.
  -- A tenant target is a tenant-wide grant; teams and sellers are scoped grants.
  if p_scope='tenant' then
    if p_tenant_id is null then raise exception 'TENANT_SELECTION_REQUIRED'; end if;
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'tenant_id',tenant.id,'team_id',null,'user_id',null
    ))
    into v_targets
    from public.tenants tenant
    where tenant.id=p_tenant_id and tenant.status in ('trial','active');
    if v_targets is null then raise exception 'TENANT_NOT_ACTIVE'; end if;

  elsif p_scope='team' then
    if p_team_ids is null or pg_catalog.array_length(p_team_ids,1) is null then
      raise exception 'TEAM_SELECTION_REQUIRED';
    end if;
    select pg_catalog.count(distinct selected)::integer into v_requested
    from pg_catalog.unnest(p_team_ids) selected;
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'tenant_id',team.tenant_id,'team_id',team.id,'user_id',null
    ))
    into v_targets
    from (
      select distinct team.id,team.tenant_id
      from public.teams team
      join public.tenants tenant on tenant.id=team.tenant_id
      where team.id=any(p_team_ids)
        and team.status='active'
        and tenant.status in ('trial','active')
    ) team;
    if coalesce(pg_catalog.jsonb_array_length(v_targets),0)<>v_requested then
      raise exception 'ACTIVE_TEAM_SELECTION_INVALID';
    end if;

  else
    if p_user_ids is null or pg_catalog.array_length(p_user_ids,1) is null then
      raise exception 'SELLER_SELECTION_REQUIRED';
    end if;
    select pg_catalog.count(distinct selected)::integer into v_requested
    from pg_catalog.unnest(p_user_ids) selected;
    if p_rinkel_user_id is not null and v_requested<>1 then
      raise exception 'EXPLICIT_PROVIDER_USER_REQUIRES_SINGLE_SELLER';
    end if;
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'tenant_id',membership.tenant_id,'team_id',null,'user_id',membership.user_id
    ))
    into v_targets
    from (
      select distinct membership.tenant_id,membership.user_id
      from public.tenant_memberships membership
      join public.tenants tenant on tenant.id=membership.tenant_id
      where membership.user_id=any(p_user_ids)
        and membership.status='active'
        and tenant.status in ('trial','active')
        and (p_tenant_id is null or membership.tenant_id=p_tenant_id)
    ) membership;
    if coalesce(pg_catalog.jsonb_array_length(v_targets),0)<>v_requested then
      raise exception 'ACTIVE_SELLER_SELECTION_INVALID';
    end if;
  end if;

  v_target_count:=coalesce(pg_catalog.jsonb_array_length(v_targets),0);
  if v_target_count=0 then raise exception 'ASSIGNMENT_TARGET_NOT_FOUND'; end if;

  -- One allocation, activation and grant set per distinct tenant in the target list.
  for v_tenant in
    select distinct target.tenant_id
    from pg_catalog.jsonb_to_recordset(v_targets)
      as target(tenant_id uuid,team_id uuid,user_id uuid)
    order by 1
  loop
    v_tenant_count:=v_tenant_count+1;

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('rinkel-number:'||p_number_id::text||':'||v_tenant::text,0)
    );
    select allocation.id into v_allocation
    from public.rinkel_number_allocations allocation
    where allocation.rinkel_number_id=p_number_id
      and allocation.tenant_id=v_tenant
      and allocation.status='active'
      and allocation.valid_to is null
    for update;
    if v_allocation is null then
      insert into public.rinkel_number_allocations(
        rinkel_number_id,tenant_id,allocated_by,allocation_reason
      ) values(p_number_id,v_tenant,v_actor,v_reason)
      returning id into v_allocation;
    end if;

    if p_activate_telephony then
      insert into public.telephony_policies(tenant_id,telephony_enabled)
      values(v_tenant,true)
      on conflict(tenant_id) do update set
        telephony_enabled=true,
        updated_at=pg_catalog.now();
      insert into public.tenant_features(tenant_id,feature_key,enabled)
      values(v_tenant,'outbound_calls',true)
      on conflict(tenant_id,feature_key) do update set enabled=true;
      v_activated:=v_activated+1;
    end if;

    for v_target in
      select target.team_id,target.user_id
      from pg_catalog.jsonb_to_recordset(v_targets)
        as target(tenant_id uuid,team_id uuid,user_id uuid)
      where target.tenant_id=v_tenant
      order by target.team_id,target.user_id
    loop
      -- Reuse the grant at this exact scope so repeated assignment is idempotent
      -- and never leaves two competing defaults behind.
      select grant_row.id into v_grant
      from public.rinkel_number_grants grant_row
      where grant_row.tenant_id=v_tenant
        and grant_row.number_allocation_id=v_allocation
        and grant_row.access_level='dial'
        and grant_row.team_id is not distinct from v_target.team_id
        and grant_row.user_id is not distinct from v_target.user_id
      order by grant_row.active desc,grant_row.created_at,grant_row.id
      limit 1
      for update;

      update public.rinkel_number_grants grant_row
      set is_default=false,updated_at=pg_catalog.now()
      where grant_row.tenant_id=v_tenant
        and grant_row.active
        and grant_row.is_default
        and grant_row.access_level in ('dial','manage')
        and grant_row.team_id is not distinct from v_target.team_id
        and grant_row.user_id is not distinct from v_target.user_id
        and (v_grant is null or grant_row.id<>v_grant);

      if v_grant is null then
        insert into public.rinkel_number_grants(
          tenant_id,number_allocation_id,team_id,user_id,
          access_level,is_default,active,created_by
        ) values(
          v_tenant,v_allocation,v_target.team_id,v_target.user_id,
          'dial',true,true,v_actor
        ) returning id into v_grant;
      else
        update public.rinkel_number_grants grant_row
        set active=true,is_default=true,updated_at=pg_catalog.now()
        where grant_row.id=v_grant;
      end if;

      if v_target.team_id is not null then
        update public.teams
        set rinkel_number_allocation_id=v_allocation,updated_at=pg_catalog.now()
        where id=v_target.team_id and tenant_id=v_tenant;
      elsif v_target.user_id is null then
        update public.telephony_policies
        set default_number_allocation_id=v_allocation,updated_at=pg_catalog.now()
        where tenant_id=v_tenant;
      end if;

      insert into public.platform_audit_logs(
        actor_user_id,action,entity_type,entity_id,tenant_id,reason,metadata
      ) values(
        v_actor,'rinkel.number_assigned','rinkel_number_grant',v_grant::text,
        v_tenant,v_reason,
        pg_catalog.jsonb_build_object(
          'number_id',p_number_id,'scope',p_scope,
          'team_id',v_target.team_id,'user_id',v_target.user_id,
          'number_allocation_id',v_allocation
        )
      );
    end loop;

    -- Activate every seller the assignment reaches so the number is immediately usable.
    for v_seller in
      select distinct membership.user_id
      from pg_catalog.jsonb_to_recordset(v_targets)
        as target(tenant_id uuid,team_id uuid,user_id uuid)
      join public.tenant_memberships membership
        on membership.tenant_id=target.tenant_id
       and membership.status='active'
      where target.tenant_id=v_tenant
        and (
          (target.team_id is null and target.user_id is null)
          or target.user_id=membership.user_id
          or (target.team_id is not null and exists(
            select 1 from public.team_members team_member
            where team_member.tenant_id=target.tenant_id
              and team_member.team_id=target.team_id
              and team_member.user_id=membership.user_id
          ))
        )
      order by 1
    loop
      v_seller_count:=v_seller_count+1;
      v_link:=public.rinkel_link_seller_to_provider_user(
        v_tenant,v_seller,v_allocation,p_rinkel_user_id,v_actor,v_reason
      );
      if v_link='linked' then
        v_linked:=v_linked+1;
      elsif v_link='already_linked' then
        v_already:=v_already+1;
      else
        v_unresolved:=v_unresolved+1;
        v_unresolved_reasons:=pg_catalog.jsonb_set(
          v_unresolved_reasons,
          array[v_link],
          pg_catalog.to_jsonb(coalesce((v_unresolved_reasons->>v_link)::integer,0)+1),
          true
        );
      end if;

      if exists(
        select 1
        from public.rinkel_user_mappings_v2 mapping
        join public.rinkel_user_allocations allocation
          on allocation.id=mapping.rinkel_user_allocation_id
         and allocation.status='active'
         and allocation.valid_to is null
        join public.rinkel_effective_provider_device(
          allocation.rinkel_user_id,mapping.selected_device_id
        ) device on true
        where mapping.tenant_id=v_tenant
          and mapping.kundexa_user_id=v_seller
          and mapping.active
      ) then
        v_ready:=v_ready+1;
      end if;
    end loop;
  end loop;

  return pg_catalog.jsonb_build_object(
    'scope',p_scope,
    'target_count',v_target_count,
    'tenant_count',v_tenant_count,
    'telephony_activated_tenant_count',v_activated,
    'seller_count',v_seller_count,
    'linked_seller_count',v_linked,
    'already_linked_seller_count',v_already,
    'unresolved_seller_count',v_unresolved,
    'unresolved_reasons',v_unresolved_reasons,
    'dial_ready_seller_count',v_ready,
    'provider_device_missing_count',greatest(0,v_linked+v_already-v_ready)
  );
end
$$;
revoke all on function public.assign_platform_rinkel_number(uuid,text,uuid,uuid[],uuid[],uuid,boolean,text)
  from public,anon;
grant execute on function public.assign_platform_rinkel_number(uuid,text,uuid,uuid[],uuid[],uuid,boolean,text)
  to authenticated;

-- The team-scoped entry point keeps its signature and delegates to the single
-- assignment path so both surfaces share one activation contract.
create or replace function public.assign_platform_rinkel_number_to_teams(
  p_number_id uuid,
  p_team_ids uuid[],
  p_reason text default null
) returns jsonb
language sql
security definer
set search_path=''
as $$
  select public.assign_platform_rinkel_number(
    p_number_id,'team',null,p_team_ids,null,null,true,p_reason
  );
$$;
revoke all on function public.assign_platform_rinkel_number_to_teams(uuid,uuid[],text)
  from public,anon;
grant execute on function public.assign_platform_rinkel_number_to_teams(uuid,uuid[],text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Seller readiness reports the real provider blocker
-- ---------------------------------------------------------------------------

create or replace function public.telephony_status_for_current_user()
returns jsonb
language plpgsql
stable
security definer
set search_path=public
as $$
declare
  v_tenant uuid:=public.current_tenant_id();
  v_user uuid:=auth.uid();
  v_platform record;
  v_policy public.telephony_policies%rowtype;
  v_mapping record;
  v_tenant_has_number boolean:=false;
  v_number_access boolean:=false;
  v_caller_id_resolvable boolean:=false;
  v_worker_healthy boolean:=false;
  v_api_verified boolean:=false;
  v_core_webhooks_verified boolean:=false;
  v_catalog_dial_configured boolean:=false;
  v_runtime_dial_configured boolean:=false;
  v_manual_ready boolean:=false;
  v_automatic_ready boolean:=false;
  v_blockers jsonb:='[]'::jsonb;
begin
  select pi.*,pc.api_access,pc.dial_configured,pc.core_webhooks_verified
  into v_platform
  from public.platform_integrations pi
  left join public.platform_rinkel_capabilities pc
    on pc.platform_integration_id=pi.id
  where pi.provider='rinkel'
    and pi.is_canonical
    and pi.disabled_at is null
  limit 1;

  select * into v_policy
  from public.telephony_policies
  where tenant_id=v_tenant;

  -- Rinkel exposes the seller device as a nullable scalar on the provider user
  -- and has no devices endpoint, so device readiness is derived from the live
  -- provider record rather than from a device chosen when the mapping was saved.
  select
    m.id,
    m.default_number_allocation_id,
    device.device_row_id as selected_device_id,
    device.provider_device_id,
    device.provider_device_id is not null as device_active
  into v_mapping
  from public.rinkel_user_mappings_v2 m
  join public.rinkel_user_allocations ua
    on ua.id=m.rinkel_user_allocation_id
   and ua.tenant_id=m.tenant_id
   and ua.status='active'
   and ua.valid_to is null
  left join lateral public.rinkel_effective_provider_device(
    ua.rinkel_user_id,m.selected_device_id
  ) device on true
  where m.tenant_id=v_tenant
    and m.kundexa_user_id=v_user
    and m.active;

  select exists(
    select 1
    from public.rinkel_number_allocations allocation
    join public.platform_rinkel_numbers number
      on number.id=allocation.rinkel_number_id
     and number.active
    where allocation.tenant_id=v_tenant
      and allocation.status='active'
      and allocation.valid_to is null
  ) into v_tenant_has_number;

  select exists(
    select 1
    from public.rinkel_number_allocations allocation
    join public.platform_rinkel_numbers number
      on number.id=allocation.rinkel_number_id
     and number.active
    join public.rinkel_number_grants grant_row
      on grant_row.tenant_id=allocation.tenant_id
     and grant_row.number_allocation_id=allocation.id
     and grant_row.active
     and grant_row.access_level in ('dial','manage')
    where allocation.tenant_id=v_tenant
      and allocation.status='active'
      and allocation.valid_to is null
      and (
        grant_row.user_id=v_user
        or grant_row.team_id in (
          select tm.team_id
          from public.team_members tm
          where tm.tenant_id=v_tenant
            and tm.user_id=v_user
        )
        or (grant_row.user_id is null and grant_row.team_id is null)
      )
  ) into v_number_access;

  if v_mapping.id is not null then
    select exists(
      select 1
      from public.resolve_rinkel_caller_id(
        v_tenant,
        v_user,
        null,
        null,
        null,
        null,
        v_mapping.default_number_allocation_id
      )
    ) into v_caller_id_resolvable;
  end if;

  select coalesce(bool_or(last_success_at > now()-interval '3 minutes'),false)
  into v_worker_healthy
  from public.platform_worker_heartbeats
  where worker_key='rinkel-platform-worker';

  v_api_verified:=coalesce(v_platform.api_access,false)
    and v_platform.status in ('connected','degraded');
  v_core_webhooks_verified:=coalesce(v_platform.core_webhooks_verified,false)
    and v_platform.webhook_status='verified';
  v_catalog_dial_configured:=coalesce(v_platform.dial_configured,false);
  v_runtime_dial_configured:=v_mapping.id is not null
    and v_mapping.provider_device_id is not null
    and v_caller_id_resolvable;

  if v_platform.id is null then
    v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object(
      'code','RINKEL_PLATFORM_NOT_CONFIGURED',
      'message','Den centrala telefonitjänsten är inte konfigurerad.'
    ));
  end if;
  if v_platform.id is not null and not v_api_verified then
    v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object(
      'code',case
        when v_platform.status='authentication_failed' then 'RINKEL_AUTHENTICATION_ERROR'
        when v_platform.status='plan_unsupported' then 'RINKEL_PLAN_UNSUPPORTED'
        when v_platform.status='unavailable' then 'RINKEL_UNAVAILABLE'
        else 'RINKEL_API_NOT_VERIFIED'
      end,
      'message',case
        when v_platform.status='authentication_failed' then 'Telefonitjänstens anslutning nekades.'
        when v_platform.status='plan_unsupported' then 'Telefonikontot saknar nödvändig integrationsåtkomst.'
        when v_platform.status='unavailable' then 'Telefonitjänsten kunde inte nås vid den senaste kontrollen.'
        else 'Telefonitjänstens API-anslutning är inte verifierad.'
      end
    ));
  end if;
  if not coalesce(v_policy.telephony_enabled,false) then
    v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object(
      'code','TELEPHONY_DISABLED',
      'message','Telefoni är avstängd för företaget.'
    ));
  end if;
  if coalesce(v_policy.telephony_enabled,false)
     and not coalesce(v_policy.manual_dialer_enabled,false) then
    v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object(
      'code','MANUAL_DIALER_DISABLED',
      'message','Manuell uppringning är avstängd för företaget.'
    ));
  end if;
  if not v_tenant_has_number then
    v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object(
      'code','NUMBER_ALLOCATION_MISSING',
      'message','Företaget saknar ett aktivt tilldelat telefonnummer.'
    ));
  end if;
  if v_mapping.id is null then
    v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object(
      'code','USER_MAPPING_MISSING',
      'message','Du saknar en aktiv telefonimappning.'
    ));
  end if;
  if v_mapping.id is not null and v_mapping.provider_device_id is null then
    v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object(
      'code','PROVIDER_DEVICE_MISSING',
      'message','Telefonitjänsten rapporterar ingen registrerad enhet för ditt konto. Logga in i telefonitjänstens webbtelefon eller app och be plattformsadministratören synkronisera katalogen.'
    ));
  end if;
  if v_mapping.id is not null and not v_number_access then
    v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object(
      'code','DIAL_PERMISSION_DENIED',
      'message','Du saknar åtkomst till ett aktivt utgående telefonnummer.'
    ));
  end if;
  if v_number_access and not v_caller_id_resolvable then
    v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object(
      'code','CALLER_ID_UNRESOLVABLE',
      'message','Ditt tilldelade utgående nummer kunde inte väljas för samtalet.'
    ));
  end if;
  if not v_catalog_dial_configured and not v_runtime_dial_configured then
    v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object(
      'code','DIAL_CONFIGURATION_INCOMPLETE',
      'message','Telefonins användar-, enhets- eller nummerkonfiguration är ofullständig.'
    ));
  end if;
  if coalesce(v_policy.automatic_dialer_enabled,false)
     and not v_core_webhooks_verified then
    v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object(
      'code','CORE_WEBHOOKS_NOT_VERIFIED',
      'message','Automatisk uppringning kräver fyra verifierade kärnwebhookar.'
    ));
  end if;
  if coalesce(v_policy.automatic_dialer_enabled,false)
     and not v_worker_healthy then
    v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object(
      'code','RINKEL_WORKER_UNHEALTHY',
      'message','Automatisk uppringning kräver en nyligen lyckad worker-körning.'
    ));
  end if;

  v_manual_ready:=v_api_verified
    and coalesce(v_policy.telephony_enabled,false)
    and coalesce(v_policy.manual_dialer_enabled,false)
    and v_tenant_has_number
    and v_mapping.id is not null
    and v_mapping.provider_device_id is not null
    and v_number_access
    and v_caller_id_resolvable
    and (v_catalog_dial_configured or v_runtime_dial_configured);

  v_automatic_ready:=v_manual_ready
    and coalesce(v_policy.automatic_dialer_enabled,false)
    and v_core_webhooks_verified
    and v_worker_healthy;

  return jsonb_build_object(
    'platformConfigured',v_platform.id is not null,
    'apiVerified',v_api_verified,
    'coreWebhooksVerified',v_core_webhooks_verified,
    'workerHealthy',v_worker_healthy,
    'tenantEnabled',coalesce(v_policy.telephony_enabled,false),
    'tenantHasNumber',v_tenant_has_number,
    'userMapped',v_mapping.id is not null,
    'userHasActiveDevice',v_mapping.provider_device_id is not null,
    'userHasDevice',v_mapping.provider_device_id is not null,
    'userHasNumberAccess',v_number_access,
    'callerIdResolvable',v_caller_id_resolvable,
    'catalogDialConfigured',v_catalog_dial_configured,
    'runtimeDialConfigured',v_runtime_dial_configured,
    'manualReady',v_manual_ready,
    'automaticReady',v_automatic_ready,
    'webhookReady',v_core_webhooks_verified,
    'platformReady',v_api_verified and (v_catalog_dial_configured or v_runtime_dial_configured),
    'status',coalesce(v_platform.status,'not_configured'),
    'errorCode',case when jsonb_array_length(v_blockers)>0 then v_blockers->0->>'code' else null end,
    'errorMessage',case when jsonb_array_length(v_blockers)>0 then v_blockers->0->>'message' else null end,
    'blockers',v_blockers
  );
end $$;
revoke all on function public.telephony_status_for_current_user() from public,anon,authenticated;
grant execute on function public.telephony_status_for_current_user() to authenticated;

-- ---------------------------------------------------------------------------
-- Tenant projection uses the same live device resolution as the dial path
-- ---------------------------------------------------------------------------

create or replace function public.get_tenant_rinkel_resources()
returns jsonb
language sql
stable
security definer
set search_path=''
as $$
select pg_catalog.jsonb_build_object(
  'users',coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'allocationId',allocation.id,
      'userId',provider_user.id,
      'displayName',provider_user.display_name,
      'email',provider_user.email,
      -- Dial readiness follows the same live provider resolution the dial path
      -- uses, so a device Rinkel reports only as the scalar `deviceId` counts.
      'hasDevice',exists(
        select 1 from public.rinkel_effective_provider_device(provider_user.id,null)
      ),
      'activeDeviceCount',(
        select pg_catalog.count(*)::integer
        from public.platform_rinkel_devices device
        where device.platform_rinkel_user_id=provider_user.id and device.active
      ),
      'deviceInventoryComplete',coalesce(
        (provider_user.raw_provider_data #>> '{_kundexa_sync,device_inventory_complete}')::boolean,
        false
      ),
      'deviceInventorySource',provider_user.raw_provider_data #>> '{_kundexa_sync,device_inventory_source}',
      'deviceInventoryError',provider_user.raw_provider_data #>> '{_kundexa_sync,device_inventory_error}',
      'active',provider_user.active,
      'devices',coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id',device.id,
          'providerDeviceId',device.provider_device_id,
          'displayName',device.display_name,
          'deviceType',device.device_type,
          'status',device.provider_status,
          'active',device.active,
          'lastSyncedAt',device.last_synced_at
        ) order by device.display_name nulls last,device.provider_device_id)
        from public.platform_rinkel_devices device
        where device.platform_rinkel_user_id=provider_user.id
      ),'[]'::jsonb)
    ) order by provider_user.display_name)
    from public.rinkel_user_allocations allocation
    join public.platform_rinkel_users provider_user on provider_user.id=allocation.rinkel_user_id
    where allocation.tenant_id=public.current_tenant_id()
      and allocation.status='active'
      and allocation.valid_to is null
  ),'[]'::jsonb),
  'numbers',coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'allocationId',allocation.id,
      'numberId',provider_number.id,
      'number',provider_number.phone_number_e164,
      'displayName',provider_number.display_name,
      'recordingEnabled',provider_number.recording_enabled,
      'active',provider_number.active
    ) order by provider_number.phone_number_e164)
    from public.rinkel_number_allocations allocation
    join public.platform_rinkel_numbers provider_number on provider_number.id=allocation.rinkel_number_id
    where allocation.tenant_id=public.current_tenant_id()
      and allocation.status='active'
      and allocation.valid_to is null
  ),'[]'::jsonb),
  'mappings',coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id',mapping.id,
      'kundexaUserId',mapping.kundexa_user_id,
      'userAllocationId',mapping.rinkel_user_allocation_id,
      'numberAllocationId',mapping.default_number_allocation_id,
      'selectedDeviceId',mapping.selected_device_id,
      'active',mapping.active
    ))
    from public.rinkel_user_mappings_v2 mapping
    where mapping.tenant_id=public.current_tenant_id() and mapping.active
  ),'[]'::jsonb),
  'callerIdDefaults',pg_catalog.jsonb_build_object(
    'tenantDefaultAllocationId',(
      select policy.default_number_allocation_id
      from public.telephony_policies policy
      where policy.tenant_id=public.current_tenant_id()
    ),
    'teams',coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id',team.id,'name',team.name,'numberAllocationId',team.rinkel_number_allocation_id
      ) order by team.name)
      from public.teams team where team.tenant_id=public.current_tenant_id()
    ),'[]'::jsonb),
    'lists',coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id',list.id,'name',list.name,'numberAllocationId',list.rinkel_number_allocation_id
      ) order by list.name)
      from public.customer_lists list
      where list.tenant_id=public.current_tenant_id() and list.archived_at is null
    ),'[]'::jsonb),
    'campaigns',coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id',campaign.id,'name',campaign.name,'numberAllocationId',campaign.rinkel_number_allocation_id
      ) order by campaign.name)
      from public.campaigns campaign
      where campaign.tenant_id=public.current_tenant_id()
        and campaign.status not in ('completed','archived')
    ),'[]'::jsonb)
  ),
  'capabilities',coalesce((
    select pg_catalog.jsonb_build_object(
      'recordingDetected',capability.recording_detected,
      'transcriptionSupported',capability.transcription_supported,
      'insightsSupported',capability.insights_supported,
      'noteSyncSupported',capability.note_sync_supported,
      'privateRecordingCopySupported',false
    )
    from public.platform_integrations integration
    join public.platform_rinkel_capabilities capability
      on capability.platform_integration_id=integration.id
    where integration.provider='rinkel' and integration.is_canonical
  ),'{}'::jsonb)
)
-- Production has restricted this projection to tenant admins since the seller
-- mapping RPC was tightened to `is_tenant_admin`; the repository still carried
-- the looser member check. Keep the stricter live behaviour: the projection
-- exposes the whole company's telephony inventory, which is administration data.
where public.current_tenant_id() is not null
  and public.is_tenant_admin(public.current_tenant_id())
$$;
revoke all on function public.get_tenant_rinkel_resources() from public,anon,authenticated;
grant execute on function public.get_tenant_rinkel_resources() to authenticated;

-- ---------------------------------------------------------------------------
-- Repair existing state
-- ---------------------------------------------------------------------------

-- Sellers mapped before this migration may point at a device row that the
-- provider no longer reports. Clear the stale preference so the live resolver
-- selects the current device instead of a removed one.
update public.rinkel_user_mappings_v2 mapping
set selected_device_id=null,
    updated_at=now()
where mapping.active
  and mapping.selected_device_id is not null
  and not exists(
    select 1
    from public.platform_rinkel_devices device
    where device.id=mapping.selected_device_id
      and device.active
  );

-- The denormalized catalog capability must count provider users whose device is
-- only known as the scalar `deviceId` on the synchronized user record.
update public.platform_rinkel_capabilities capability
set dial_configured=(
      exists(
        select 1
        from public.platform_rinkel_users provider_user
        join public.rinkel_effective_provider_device(provider_user.id,null) device on true
        where provider_user.platform_integration_id=capability.platform_integration_id
          and provider_user.active
      )
      and exists(
        select 1
        from public.platform_rinkel_numbers provider_number
        where provider_number.platform_integration_id=capability.platform_integration_id
          and provider_number.active
      )
    ),
    detected_at=now();

update public.platform_integrations integration
set capabilities=integration.capabilities||jsonb_build_object(
      'dial_configured',coalesce(capability.dial_configured,false)
    )
from public.platform_rinkel_capabilities capability
where capability.platform_integration_id=integration.id
  and integration.provider='rinkel';
