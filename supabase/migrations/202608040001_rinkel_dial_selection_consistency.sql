-- Make caller-ID selection consistent with the shared team-number access model.
-- A number that is visible to a seller must also be resolvable by the dial RPC,
-- and inbound-only grants must never authorize outbound calls.

-- Direct user grants were previously nullable-unique and could be duplicated.
-- Collapse active duplicates before enforcing an idempotent user-access key.
with ranked_user_grants as (
  select
    id,
    row_number() over (
      partition by number_allocation_id, user_id, access_level
      order by is_default desc, created_at, id
    ) as position
  from public.rinkel_number_grants
  where active
    and user_id is not null
    and team_id is null
)
update public.rinkel_number_grants grant_row
set active=false,
    is_default=false,
    updated_at=now()
from ranked_user_grants
where ranked_user_grants.id=grant_row.id
  and ranked_user_grants.position>1;

create unique index if not exists rinkel_number_grants_active_user_access_uidx
  on public.rinkel_number_grants(number_allocation_id,user_id,access_level)
  where active and user_id is not null and team_id is null;

-- Saving a seller mapping now proves the selected device belongs to the selected
-- provider user and transactionally grants the seller dial access to the chosen
-- default number. A saved mapping can therefore never point at an unusable
-- caller ID.
create or replace function public.replace_rinkel_user_mapping_v3(
  p_kundexa_user_id uuid,
  p_rinkel_user_allocation_id uuid,
  p_default_number_allocation_id uuid,
  p_selected_device_id uuid
) returns uuid
language plpgsql
security definer
set search_path=''
as $$
declare
  v_tenant uuid:=public.current_tenant_id();
  v_actor uuid:=auth.uid();
  v_role text:=public.current_membership_role();
  v_mapping_id uuid;
  v_grant_id uuid;
begin
  if v_tenant is null or v_actor is null then
    raise exception 'AUTHENTICATION_REQUIRED';
  end if;
  if v_role not in ('owner','admin','team_lead') then
    raise exception 'RINKEL_MAPPING_PERMISSION_REQUIRED';
  end if;
  if not exists(
    select 1
    from public.tenant_memberships membership
    where membership.tenant_id=v_tenant
      and membership.user_id=p_kundexa_user_id
      and membership.status='active'
  ) then
    raise exception 'RINKEL_MAPPING_MEMBER_NOT_ACTIVE';
  end if;
  if v_role='team_lead' and not exists(
    select 1
    from public.team_members team_member
    where team_member.tenant_id=v_tenant
      and team_member.user_id=p_kundexa_user_id
      and public.can_manage_team(team_member.team_id)
  ) then
    raise exception 'RINKEL_MAPPING_TEAM_PERMISSION_REQUIRED';
  end if;
  if not exists(
    select 1
    from public.rinkel_user_allocations allocation
    join public.platform_rinkel_users provider_user
      on provider_user.id=allocation.rinkel_user_id
     and provider_user.active
    join public.platform_rinkel_devices device
      on device.platform_rinkel_user_id=provider_user.id
     and device.id=p_selected_device_id
     and device.active
    where allocation.id=p_rinkel_user_allocation_id
      and allocation.tenant_id=v_tenant
      and allocation.status='active'
      and allocation.valid_to is null
  ) then
    raise exception 'DEVICE_MISSING';
  end if;
  if not exists(
    select 1
    from public.rinkel_number_allocations allocation
    join public.platform_rinkel_numbers provider_number
      on provider_number.id=allocation.rinkel_number_id
     and provider_number.active
    where allocation.id=p_default_number_allocation_id
      and allocation.tenant_id=v_tenant
      and allocation.status='active'
      and allocation.valid_to is null
  ) then
    raise exception 'NUMBER_ALLOCATION_MISSING';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_tenant::text||':rinkel-mapping:'||p_kundexa_user_id::text,0)
  );

  update public.rinkel_user_mappings_v2 mapping
  set active=false,
      updated_at=pg_catalog.now()
  where mapping.active
    and (
      (mapping.tenant_id=v_tenant and mapping.kundexa_user_id=p_kundexa_user_id)
      or mapping.rinkel_user_allocation_id=p_rinkel_user_allocation_id
    );

  -- Keep any other direct number access, but make exactly one direct grant the
  -- mapping default for this seller.
  update public.rinkel_number_grants grant_row
  set is_default=false,
      updated_at=pg_catalog.now()
  where grant_row.tenant_id=v_tenant
    and grant_row.user_id=p_kundexa_user_id
    and grant_row.team_id is null
    and grant_row.access_level in ('dial','manage')
    and grant_row.active
    and grant_row.is_default;

  select grant_row.id
  into v_grant_id
  from public.rinkel_number_grants grant_row
  where grant_row.tenant_id=v_tenant
    and grant_row.number_allocation_id=p_default_number_allocation_id
    and grant_row.user_id=p_kundexa_user_id
    and grant_row.team_id is null
    and grant_row.access_level='dial'
  order by grant_row.active desc,grant_row.created_at,grant_row.id
  limit 1
  for update;

  if v_grant_id is null then
    insert into public.rinkel_number_grants(
      tenant_id,number_allocation_id,team_id,user_id,
      access_level,is_default,active,created_by
    ) values(
      v_tenant,p_default_number_allocation_id,null,p_kundexa_user_id,
      'dial',true,true,v_actor
    ) returning id into v_grant_id;
  else
    update public.rinkel_number_grants grant_row
    set active=true,
        is_default=true,
        updated_at=pg_catalog.now()
    where grant_row.id=v_grant_id;
  end if;

  insert into public.rinkel_user_mappings_v2(
    tenant_id,kundexa_user_id,rinkel_user_allocation_id,
    default_number_allocation_id,selected_device_id,created_by
  ) values(
    v_tenant,p_kundexa_user_id,p_rinkel_user_allocation_id,
    p_default_number_allocation_id,p_selected_device_id,v_actor
  ) returning id into v_mapping_id;

  insert into public.audit_logs(
    tenant_id,actor_user_id,action,entity_type,entity_id,after_data
  ) values(
    v_tenant,v_actor,'rinkel.user_mapping_saved','rinkel_user_mapping',v_mapping_id::text,
    pg_catalog.jsonb_build_object(
      'kundexa_user_id',p_kundexa_user_id,
      'selected_device_id',p_selected_device_id,
      'default_number_allocation_id',p_default_number_allocation_id,
      'direct_number_grant_id',v_grant_id
    )
  );
  return v_mapping_id;
end
$$;
revoke all on function public.replace_rinkel_user_mapping_v3(uuid,uuid,uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.replace_rinkel_user_mapping_v3(uuid,uuid,uuid,uuid)
  to authenticated;

create or replace function public.resolve_rinkel_caller_id(
  p_tenant_id uuid,
  p_user_id uuid,
  p_team_id uuid,
  p_list_id uuid,
  p_campaign_id uuid,
  p_explicit_number_allocation_id uuid,
  p_mapping_default_number_allocation_id uuid
) returns table(
  number_allocation_id uuid,
  rinkel_number_id uuid,
  provider_number_id text,
  phone_number_e164 text,
  allocation_source text,
  grant_id uuid
)
language sql
stable
security definer
set search_path=public
as $$
with requested(priority,source,allocation_id) as (
  select 1,'explicit',p_explicit_number_allocation_id
  where p_explicit_number_allocation_id is not null

  union all
  select 2,'list_default',l.rinkel_number_allocation_id
  from public.customer_lists l
  where l.tenant_id=p_tenant_id
    and l.id=p_list_id
    and l.rinkel_number_allocation_id is not null

  union all
  select 3,'campaign_default',c.rinkel_number_allocation_id
  from public.campaigns c
  where c.tenant_id=p_tenant_id
    and c.id=p_campaign_id
    and c.rinkel_number_allocation_id is not null

  union all
  select 4,'customer_team_default',t.rinkel_number_allocation_id
  from public.teams t
  where t.tenant_id=p_tenant_id
    and t.id=p_team_id
    and t.status='active'
    and t.rinkel_number_allocation_id is not null

  union all
  select 5,'seller_default',p_mapping_default_number_allocation_id
  where p_mapping_default_number_allocation_id is not null

  union all
  select 6,'seller_team_default',t.rinkel_number_allocation_id
  from public.team_members tm
  join public.teams t
    on t.tenant_id=tm.tenant_id
   and t.id=tm.team_id
   and t.status='active'
  where tm.tenant_id=p_tenant_id
    and tm.user_id=p_user_id
    and t.rinkel_number_allocation_id is not null

  union all
  select 7,'tenant_default',p.default_number_allocation_id
  from public.telephony_policies p
  where p.tenant_id=p_tenant_id
    and p.default_number_allocation_id is not null

  union all
  select 8,'platform_default',a.id
  from public.rinkel_number_allocations a
  join public.platform_rinkel_numbers n
    on n.id=a.rinkel_number_id
   and n.is_platform_default
   and n.active
  where a.tenant_id=p_tenant_id
    and a.status='active'
    and a.valid_to is null

), requested_valid as (
  select
    r.priority,
    r.source,
    a.id allocation_id,
    a.rinkel_number_id,
    n.external_number_id,
    n.phone_number_e164,
    access.id access_grant_id,
    access.grant_rank,
    access.is_default
  from requested r
  join public.rinkel_number_allocations a
    on a.id=r.allocation_id
   and a.tenant_id=p_tenant_id
   and a.status='active'
   and a.valid_to is null
  join public.platform_rinkel_numbers n
    on n.id=a.rinkel_number_id
   and n.active
  join lateral (
    select
      g.id,
      g.is_default,
      case
        when g.user_id=p_user_id then 1
        when g.team_id=p_team_id then 2
        when g.team_id is not null then 3
        else 4
      end as grant_rank
    from public.rinkel_number_grants g
    where g.tenant_id=p_tenant_id
      and g.number_allocation_id=a.id
      and g.active
      and g.access_level in ('dial','manage')
      and (
        g.user_id=p_user_id
        or g.team_id in (
          select tm.team_id
          from public.team_members tm
          where tm.tenant_id=p_tenant_id
            and tm.user_id=p_user_id
        )
        or (g.user_id is null and g.team_id is null)
      )
    order by
      case
        when g.user_id=p_user_id then 1
        when g.team_id=p_team_id then 2
        when g.team_id is not null then 3
        else 4
      end,
      g.is_default desc,
      g.created_at,
      g.id
    limit 1
  ) access on true
), accessible_fallback as (
  select
    9 as priority,
    case
      when access.user_id=p_user_id then 'user_grant'
      when access.team_id=p_team_id then 'customer_team_grant'
      when access.team_id is not null then 'seller_team_grant'
      else 'tenant_grant'
    end as source,
    a.id allocation_id,
    a.rinkel_number_id,
    n.external_number_id,
    n.phone_number_e164,
    access.id access_grant_id,
    case
      when access.user_id=p_user_id then 1
      when access.team_id=p_team_id then 2
      when access.team_id is not null then 3
      else 4
    end as grant_rank,
    access.is_default
  from public.rinkel_number_allocations a
  join public.platform_rinkel_numbers n
    on n.id=a.rinkel_number_id
   and n.active
  join public.rinkel_number_grants access
    on access.tenant_id=a.tenant_id
   and access.number_allocation_id=a.id
   and access.active
   and access.access_level in ('dial','manage')
  where a.tenant_id=p_tenant_id
    and a.status='active'
    and a.valid_to is null
    and (
      access.user_id=p_user_id
      or access.team_id in (
        select tm.team_id
        from public.team_members tm
        where tm.tenant_id=p_tenant_id
          and tm.user_id=p_user_id
      )
      or (access.user_id is null and access.team_id is null)
    )
), candidates as (
  select * from requested_valid
  union all
  select * from accessible_fallback
)
select
  candidate.allocation_id,
  candidate.rinkel_number_id,
  candidate.external_number_id,
  candidate.phone_number_e164,
  candidate.source,
  candidate.access_grant_id
from candidates candidate
order by
  candidate.priority,
  candidate.grant_rank,
  candidate.is_default desc,
  candidate.allocation_id
limit 1
$$;
revoke all on function public.resolve_rinkel_caller_id(uuid,uuid,uuid,uuid,uuid,uuid,uuid)
  from public,anon,authenticated;



-- Keep the reservation gate consistent with the readiness resolver. Active
-- provider inventory and an actually resolvable caller ID are sufficient for
-- manual dialing even when a denormalized catalog flag has not caught up yet.
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
  v_nix text;
  v_is_automatic boolean:=false;
  v_list_id uuid;
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
  if v_customer.do_not_call then raise exception 'customer_do_not_call'; end if;
  if p_contact_person_id is null then
    if p_target_phone is distinct from v_customer.phone_e164 and p_target_phone is distinct from v_customer.alternate_phone_e164
      then raise exception 'target_phone_customer_mismatch'; end if;
  else
    select * into v_contact from public.contact_people
      where tenant_id=v_tenant and id=p_contact_person_id and customer_id=p_customer_id;
    if not found then raise exception 'contact_person_not_found'; end if;
    if p_target_phone is distinct from v_contact.phone_e164 and p_target_phone is distinct from v_contact.alternate_phone_e164
      then raise exception 'target_phone_contact_mismatch'; end if;
  end if;
  if exists(
    select 1 from public.compliance_blocks b where b.tenant_id=v_tenant
      and (b.customer_id=p_customer_id or b.phone_e164=p_target_phone)
      and 'call'=any(b.channels) and b.active and (b.expires_at is null or b.expires_at>now())
  ) then raise exception 'contact_not_allowed'; end if;
  if p_purpose in ('direct_marketing','automation_marketing') then
    select result into v_nix from public.nix_checks where tenant_id=v_tenant
      and phone_e164=p_target_phone and valid_until>now() order by checked_at desc limit 1;
    if v_nix is null or v_nix in ('unknown','error') then raise exception 'target_nix_check_required'; end if;
    if v_nix<>'not_listed' then raise exception 'target_nix_%',v_nix; end if;
  end if;

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
  ) then raise exception 'callback_not_available'; end if;

  if v_is_automatic then
    if not v_policy.automatic_dialer_enabled then raise exception 'automatic_dialer_disabled'; end if;
  elsif not v_policy.manual_dialer_enabled then
    raise exception 'manual_dialer_disabled';
  end if;

  select m.id mapping_id,m.rinkel_user_allocation_id,m.default_number_allocation_id,
    pi.id platform_integration_id,pi.status integration_status,
    coalesce(pc.api_access,false) api_access,coalesce(pc.dial_configured,false) dial_configured,
    pu.id rinkel_user_id,pu.external_user_id,
    d.id selected_device_id,d.provider_device_id external_device_id
  into v_mapping
  from public.rinkel_user_mappings_v2 m
  join public.rinkel_user_allocations ua on ua.id=m.rinkel_user_allocation_id
    and ua.tenant_id=m.tenant_id and ua.status='active' and ua.valid_to is null
  join public.platform_rinkel_users pu on pu.id=ua.rinkel_user_id and pu.active
  join public.platform_rinkel_devices d on d.id=m.selected_device_id and d.platform_rinkel_user_id=pu.id and d.active
  join public.platform_integrations pi on pi.id=pu.platform_integration_id
    and pi.provider='rinkel' and pi.is_canonical and pi.disabled_at is null
  left join public.platform_rinkel_capabilities pc on pc.platform_integration_id=pi.id
  where m.tenant_id=v_tenant and m.kundexa_user_id=v_user and m.active;
  if not found then raise exception 'USER_MAPPING_MISSING'; end if;
  if v_mapping.integration_status not in ('connected','degraded') or not v_mapping.api_access
    then raise exception 'RINKEL_API_NOT_VERIFIED'; end if;
  -- The selected active user/device plus the caller-ID resolver are the runtime
  -- dial contract. Do not block a valid call merely because the denormalized
  -- catalog capability bit is stale after an otherwise successful sync.

  select * into v_caller
  from public.resolve_rinkel_caller_id(
    v_tenant,v_user,v_customer.assigned_team_id,v_list_id,v_customer.campaign_id,
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
    p_idempotency_key,p_purpose,v_list_id,p_list_member_id,p_session_id,p_callback_activity_id,
    encode(digest(p_idempotency_key,'sha256'),'hex'),
    jsonb_build_object(
      'platform_integration_id',v_mapping.platform_integration_id,
      'mapping_id',v_mapping.mapping_id,'user_allocation_id',v_mapping.rinkel_user_allocation_id,
      'number_allocation_id',v_caller.number_allocation_id,
      'caller_id_source',v_caller.allocation_source,
      'rinkel_user_id',v_mapping.rinkel_user_id,'rinkel_number_id',v_caller.rinkel_number_id,
      'external_rinkel_user_id',v_mapping.external_user_id,
      'external_rinkel_number_id',v_caller.provider_number_id
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
    'callerIdAllocationId',v_caller.number_allocation_id,'idempotentReplay',false
  );
end $$;
revoke all on function public.rinkel_reserve_platform_outbound_call_v2(uuid,uuid,text,uuid,uuid,uuid,uuid,text,text,uuid) from public,anon;
grant execute on function public.rinkel_reserve_platform_outbound_call_v2(uuid,uuid,text,uuid,uuid,uuid,uuid,text,text,uuid) to authenticated;

create or replace function public.get_current_user_rinkel_numbers()
returns jsonb
language sql
stable
security definer
set search_path=public
as $$
with accessible as (
  select distinct on (allocation.id)
    allocation.id as allocation_id,
    number.id as number_id,
    number.external_number_id,
    number.phone_number_e164,
    number.display_name,
    number.recording_enabled,
    grant_row.id as grant_id,
    case
      when grant_row.user_id=auth.uid() then 'user'
      when grant_row.team_id is not null then 'team'
      else 'tenant'
    end as access_source,
    (
      grant_row.is_default
      or allocation.id=mapping.default_number_allocation_id
      or allocation.id=policy.default_number_allocation_id
    ) as is_default
  from public.rinkel_number_allocations allocation
  join public.platform_rinkel_numbers number
    on number.id=allocation.rinkel_number_id
   and number.active
  join public.rinkel_number_grants grant_row
    on grant_row.tenant_id=allocation.tenant_id
   and grant_row.number_allocation_id=allocation.id
   and grant_row.active
   and grant_row.access_level in ('dial','manage')
  left join public.rinkel_user_mappings_v2 mapping
    on mapping.tenant_id=allocation.tenant_id
   and mapping.kundexa_user_id=auth.uid()
   and mapping.active
  left join public.telephony_policies policy
    on policy.tenant_id=allocation.tenant_id
  where allocation.tenant_id=public.current_tenant_id()
    and allocation.status='active'
    and allocation.valid_to is null
    and (
      grant_row.user_id=auth.uid()
      or grant_row.team_id in (
        select tm.team_id
        from public.team_members tm
        where tm.tenant_id=allocation.tenant_id
          and tm.user_id=auth.uid()
      )
      or (grant_row.user_id is null and grant_row.team_id is null)
    )
  order by
    allocation.id,
    case
      when grant_row.user_id=auth.uid() then 1
      when grant_row.team_id is not null then 2
      else 3
    end,
    grant_row.is_default desc,
    grant_row.created_at,
    grant_row.id
)
select coalesce(
  jsonb_agg(
    jsonb_build_object(
      'allocationId',accessible.allocation_id,
      'numberId',accessible.number_id,
      'providerNumberId',accessible.external_number_id,
      'number',accessible.phone_number_e164,
      'displayName',accessible.display_name,
      'recordingEnabled',accessible.recording_enabled,
      'isDefault',accessible.is_default,
      'accessSource',accessible.access_source,
      'grantId',accessible.grant_id
    )
    order by accessible.is_default desc,accessible.phone_number_e164,accessible.allocation_id
  ),
  '[]'::jsonb
)
from accessible
$$;
revoke all on function public.get_current_user_rinkel_numbers() from public,anon,authenticated;
grant execute on function public.get_current_user_rinkel_numbers() to authenticated;

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

  select
    m.id,
    m.default_number_allocation_id,
    m.selected_device_id,
    d.active as device_active
  into v_mapping
  from public.rinkel_user_mappings_v2 m
  join public.rinkel_user_allocations ua
    on ua.id=m.rinkel_user_allocation_id
   and ua.tenant_id=m.tenant_id
   and ua.status='active'
   and ua.valid_to is null
  left join public.platform_rinkel_devices d
    on d.id=m.selected_device_id
   and d.platform_rinkel_user_id=ua.rinkel_user_id
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
    and v_mapping.selected_device_id is not null
    and coalesce(v_mapping.device_active,false)
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
  if v_mapping.id is not null
     and (v_mapping.selected_device_id is null or not coalesce(v_mapping.device_active,false)) then
    v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object(
      'code','DEVICE_MISSING',
      'message','Din telefonimappning saknar en aktiv vald enhet.'
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
    and v_mapping.selected_device_id is not null
    and coalesce(v_mapping.device_active,false)
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
    'userHasActiveDevice',v_mapping.selected_device_id is not null and coalesce(v_mapping.device_active,false),
    'userHasDevice',v_mapping.selected_device_id is not null and coalesce(v_mapping.device_active,false),
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

-- Directory sync and older deployments may have active inventory while the
-- denormalized capability bit is stale. Recompute it once during migration.
update public.platform_rinkel_capabilities capability
set
  users_catalog=true,
  numbers_catalog=true,
  dial_configured=(
    exists(
      select 1
      from public.platform_rinkel_users provider_user
      join public.platform_rinkel_devices device
        on device.platform_rinkel_user_id=provider_user.id
       and device.active
      where provider_user.platform_integration_id=capability.platform_integration_id
        and provider_user.active
    )
    and exists(
      select 1
      from public.platform_rinkel_numbers number
      where number.platform_integration_id=capability.platform_integration_id
        and number.active
    )
  ),
  detected_at=now()
where exists(
  select 1
  from public.platform_rinkel_users provider_user
  where provider_user.platform_integration_id=capability.platform_integration_id
)
and exists(
  select 1
  from public.platform_rinkel_numbers number
  where number.platform_integration_id=capability.platform_integration_id
);

update public.platform_integrations integration
set capabilities=coalesce(integration.capabilities,'{}'::jsonb) || jsonb_build_object(
  'users_catalog',coalesce(capability.users_catalog,false),
  'numbers_catalog',coalesce(capability.numbers_catalog,false),
  'dial_configured',coalesce(capability.dial_configured,false)
)
from public.platform_rinkel_capabilities capability
where capability.platform_integration_id=integration.id
  and integration.provider='rinkel'
  and integration.is_canonical;
