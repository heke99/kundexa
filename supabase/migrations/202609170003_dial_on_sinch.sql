-- Uppringningsvägen, utan leverantörens objektmodell.
--
-- `rinkel_reserve_platform_outbound_call_v2` är 15 600 tecken och nästan allt i
-- den ska överleva: behörighet, idempotens, ringtider, NIX- och
-- efterlevnadsspärren, listclaim, teambehörighet, platslåset, listmedlemmens
-- tillstånd och revisionsloggen. Ingenting av det handlar om vem som kopplar
-- samtalet.
--
-- Det som utgår är enhetsuppslaget. Rinkel krävde att varje säljare fanns som
-- provisionerad användare med en registrerad enhet och en aktiv allokering, och
-- hela blocket med `rinkel_user_mappings_v2`, `rinkel_user_allocations`,
-- `platform_rinkel_users` och `rinkel_effective_provider_device` fanns bara för
-- att kunna fylla i ett `deviceId`. Sinch originerar samtalet själv, så det
-- finns ingen enhet att peka ut. Blocket har ingen ersättare — det försvinner.
--
-- Det är också svaret på frågan om en säljare måste registrera sig hos
-- leverantören: efter den här migrationen finns det ingenting att registrera.

-- A-numret, ur tenantens egna nummer. Samma ordning som tidigare — uttryckligt
-- val, lista, kampanj, team, företagets förval — men mot `phone_numbers` i
-- stället för Rinkels allokeringar.
create or replace function public.resolve_caller_id_phone_number(
  p_tenant_id uuid,
  p_team_id uuid,
  p_list_id uuid,
  p_campaign_id uuid,
  p_explicit_phone_number_id uuid
)
returns table(phone_number_id uuid, number_e164 text, caller_id_source text)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  return query
  with candidate as (
    select p_explicit_phone_number_id as id, 'list'::text as src, 0 as rank
    where p_explicit_phone_number_id is not null
    union all
    select l.caller_id_phone_number_id, 'list', 1
    from public.customer_lists l
    where p_list_id is not null and l.tenant_id = p_tenant_id and l.id = p_list_id
      and l.caller_id_phone_number_id is not null
    union all
    select c.caller_id_phone_number_id, 'campaign', 2
    from public.campaigns c
    where p_campaign_id is not null and c.tenant_id = p_tenant_id and c.id = p_campaign_id
      and c.caller_id_phone_number_id is not null
    union all
    select t.caller_id_phone_number_id, 'team', 3
    from public.teams t
    where p_team_id is not null and t.tenant_id = p_tenant_id and t.id = p_team_id
      and t.caller_id_phone_number_id is not null
    union all
    select tp.default_caller_id_phone_number_id, 'tenant_default', 4
    from public.telephony_policies tp
    where tp.tenant_id = p_tenant_id and tp.default_caller_id_phone_number_id is not null
  )
  select n.id, n.number_e164, candidate.src
  from candidate
  join public.phone_numbers n
    on n.tenant_id = p_tenant_id and n.id = candidate.id
  -- Ett nummer som inte är aktivt eller inte bär röst är inget A-nummer, hur
  -- gärna någon än har valt det. Att ta det ändå ger ett samtal som avvisas av
  -- leverantören med ett fel som inte pekar tillbaka hit.
  where n.status = 'active' and n.supports_voice
  order by candidate.rank
  limit 1;
end $$;

comment on function public.resolve_caller_id_phone_number(uuid, uuid, uuid, uuid, uuid) is
  'Väljer vilket av tenantens nummer som visas: uttryckligt val, lista, kampanj, team, företagets förval.';

revoke all on function public.resolve_caller_id_phone_number(uuid, uuid, uuid, uuid, uuid) from public, anon, authenticated;

create or replace function public.reserve_outbound_call(
  p_customer_id uuid,
  p_contact_person_id uuid,
  p_target_phone text,
  p_session_id uuid,
  p_list_member_id uuid,
  p_callback_activity_id uuid,
  p_client_request_id uuid,
  p_idempotency_key text,
  p_purpose text default 'direct_marketing',
  p_caller_id_phone_number_id uuid default null,
  p_webphone_session_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_user uuid := auth.uid();
  v_customer public.customers%rowtype;
  v_policy public.telephony_policies%rowtype;
  v_caller record;
  v_existing record;
  v_existing_count integer := 0;
  v_call uuid;
  v_attempt uuid;
  v_local timestamp;
  v_is_automatic boolean := false;
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
  from public.dial_attempts a
  where a.tenant_id = v_tenant and (a.client_request_id = p_client_request_id or a.idempotency_key = p_idempotency_key);
  if v_existing_count > 1 then raise exception 'idempotency_identity_conflict'; end if;

  select c.id call_id, a.id attempt_id, a.status attempt_status, c.status call_status, c.provider_status
  into v_existing
  from public.calls c
  join public.dial_attempts a on a.tenant_id = c.tenant_id and a.call_id = c.id
  where c.tenant_id = v_tenant and (a.client_request_id = p_client_request_id or a.idempotency_key = p_idempotency_key)
  order by a.requested_at desc, a.id
  limit 1;
  if found then
    return jsonb_build_object(
      'callId', v_existing.call_id, 'attemptId', v_existing.attempt_id,
      'status', v_existing.call_status, 'attemptStatus', v_existing.attempt_status,
      'providerStatus', coalesce(v_existing.provider_status, 'unknown'),
      'callActive', public.dial_attempt_holds_seat(v_existing.attempt_status),
      'message', case
        when v_existing.attempt_status = 'failed' then 'Det tidigare samtalsförsöket misslyckades.'
        when v_existing.attempt_status in ('provider_outcome_unknown','reconciliation_required')
          then 'Det tidigare samtalsförsökets providerutfall är ännu okänt.'
        when v_existing.attempt_status = 'completed'
          or v_existing.call_status in ('completed','failed','cancelled','blocked','unanswered')
          then 'Det tidigare samtalsförsöket är redan avslutat.'
        else 'Det befintliga samtalsförsöket återanvänds.' end,
      'idempotentReplay', true);
  end if;

  if not exists(select 1 from public.tenants where id = v_tenant and status in ('trial','active')) then raise exception 'tenant_not_active'; end if;
  if not exists(select 1 from public.tenant_features where tenant_id = v_tenant and feature_key = 'outbound_calls' and enabled)
    then raise exception 'outbound_calls_feature_disabled'; end if;
  select * into v_policy from public.telephony_policies where tenant_id = v_tenant;
  if not found or not v_policy.telephony_enabled then raise exception 'TELEPHONY_DISABLED'; end if;
  v_local := now() at time zone v_policy.timezone;
  if not (extract(isodow from v_local)::integer = any(v_policy.allowed_days)
    and v_local::time >= v_policy.allowed_start_time and v_local::time < v_policy.allowed_end_time)
    then raise exception 'TELEPHONY_OUTSIDE_ALLOWED_TIME'; end if;

  select * into v_customer from public.customers
  where tenant_id = v_tenant and id = p_customer_id and deleted_at is null for share;
  if not found then raise exception 'customer_not_found'; end if;

  if p_callback_activity_id is not null then
    select a.assigned_team_id into v_callback_team_id
    from public.activities a
    where a.tenant_id = v_tenant and a.id = p_callback_activity_id and a.customer_id = p_customer_id and a.type = 'callback';
  end if;

  -- NIX, samtycke och syfte. Oförändrad, och oberoende av vem som kopplar
  -- samtalet: att byta telefonileverantör ändrar ingenting om vem som får ringas.
  v_exact_policy := public.evaluate_exact_call_policy(
    v_tenant, v_user, p_customer_id, p_contact_person_id, p_target_phone,
    p_session_id, p_list_member_id, p_callback_activity_id, null
  );
  if coalesce(v_exact_policy->>'allowed','false') <> 'true' then
    raise exception 'exact_call_policy_denied:%', coalesce(v_exact_policy->>'reason','unknown');
  end if;
  v_purpose := v_exact_policy->>'purpose';
  if v_purpose is null then raise exception 'exact_call_policy_purpose_missing'; end if;

  if p_session_id is not null or p_list_member_id is not null then
    if p_session_id is null or p_list_member_id is null then raise exception 'list_call_context_incomplete'; end if;
    select ds.list_id, (ds.mode = 'automatic') into v_list_id, v_is_automatic
    from public.dialer_sessions ds
    join public.customer_list_members lm on lm.tenant_id = ds.tenant_id and lm.list_id = ds.list_id
      and lm.id = p_list_member_id and lm.customer_id = p_customer_id
      and lm.claimed_by = v_user and lm.claim_expires_at > now()
    join public.customer_lists l on l.tenant_id = ds.tenant_id and l.id = ds.list_id and l.status = 'active'
    where ds.tenant_id = v_tenant and ds.id = p_session_id and ds.user_id = v_user and ds.state in ('active','after_call')
    for update of ds, lm;
    if not found then raise exception 'dialer_session_or_claim_not_active'; end if;
  elsif p_callback_activity_id is not null and not exists(
    select 1 from public.activities a
    where a.tenant_id = v_tenant and a.id = p_callback_activity_id
      and a.customer_id = p_customer_id and a.type = 'callback' and a.status in ('open','in_progress')
      and (a.assigned_user_id = v_user or (a.callback_scope = 'global' and a.claimed_by = v_user))
      and (a.assigned_team_id is null or public.can_operate_in_team(a.assigned_team_id, v_user))
      and (a.list_id is null or public.can_work_customer_list(a.list_id))
  ) then raise exception 'callback_not_available'; end if;

  if v_is_automatic then
    if not v_policy.automatic_dialer_enabled then raise exception 'automatic_dialer_disabled'; end if;
  elsif not v_policy.manual_dialer_enabled then
    raise exception 'manual_dialer_disabled';
  end if;

  if v_list_id is not null then
    select l.team_id into v_effective_team_id from public.customer_lists l where l.tenant_id = v_tenant and l.id = v_list_id;
  else
    v_effective_team_id := coalesce(v_callback_team_id, v_customer.assigned_team_id);
  end if;
  if v_effective_team_id is not null
    and not (public.can_operate_in_team(v_effective_team_id, v_user) or public.is_tenant_admin(v_tenant)) then
    raise exception 'DIAL_TEAM_PERMISSION_REQUIRED';
  end if;

  select * into v_caller from public.resolve_caller_id_phone_number(
    v_tenant, v_effective_team_id, v_list_id, v_customer.campaign_id, p_caller_id_phone_number_id
  );
  -- Ett samtal utan A-nummer får ett samtals-ID från Sinch och når aldrig
  -- mottagaren. Vägra här, innan det finns ett samtal, ett försök eller en
  -- listmedlem som tror att hon har ringts.
  if not found then raise exception 'CALLER_ID_MISSING'; end if;
  if p_caller_id_phone_number_id is not null and v_caller.phone_number_id <> p_caller_id_phone_number_id
    then raise exception 'DIAL_PERMISSION_DENIED'; end if;

  -- Att ringa sitt eget A-nummer kopplar samtalet tillbaka till samma trunk.
  if p_target_phone = v_caller.number_e164 then raise exception 'SELF_DIAL_NOT_ALLOWED'; end if;

  perform pg_advisory_xact_lock(hashtextextended(v_tenant::text || ':' || v_user::text, 0));
  if exists(
    select 1 from public.dial_attempts
    where tenant_id = v_tenant and seller_user_id = v_user and public.dial_attempt_holds_seat(status)
  ) then raise exception 'active_call_already_exists'; end if;

  insert into public.calls(
    tenant_id, provider, customer_id, contact_person_id, user_id, team_id, direction,
    from_number, to_number, status, recording_enabled, recording_status,
    transcription_status, insights_status, idempotency_key, purpose, list_id, list_member_id,
    dialer_session_id, callback_activity_id, callback_token_hash, metadata
  ) values(
    v_tenant, 'sinch', p_customer_id, p_contact_person_id, v_user, v_customer.assigned_team_id, 'outbound',
    v_caller.number_e164, p_target_phone, 'requested',
    v_policy.recording_enabled, case when v_policy.recording_enabled then 'pending' else 'not_expected' end,
    case when v_policy.transcription_enabled then 'pending' else 'disabled' end,
    case when v_policy.ai_analysis_enabled then 'pending' else 'disabled' end,
    p_idempotency_key, v_purpose, v_list_id, p_list_member_id, p_session_id, p_callback_activity_id,
    encode(digest(p_idempotency_key, 'sha256'), 'hex'),
    jsonb_build_object(
      'caller_id_phone_number_id', v_caller.phone_number_id,
      'caller_id_source', v_caller.caller_id_source,
      'derived_purpose', v_purpose, 'client_purpose_hint', p_purpose,
      'effective_team_id', v_effective_team_id, 'exact_call_policy', v_exact_policy
    )
  ) returning id into v_call;

  insert into public.dial_attempts(
    tenant_id, call_id, seller_user_id, provider, caller_id_phone_number_id, caller_id_source,
    source_number_e164, destination_number_e164, client_request_id, idempotency_key,
    status, expires_at, webphone_session_id
  ) values(
    v_tenant, v_call, v_user, 'sinch', v_caller.phone_number_id, v_caller.caller_id_source,
    v_caller.number_e164, p_target_phone, p_client_request_id, p_idempotency_key,
    'requested', now() + interval '2 hours', p_webphone_session_id
  ) returning id into v_attempt;

  if p_session_id is not null then
    update public.customer_list_members
      set state = 'dialing', attempts = attempts + 1, last_call_id = v_call,
          last_contacted_at = now(), claim_expires_at = now() + interval '2 hours'
      where tenant_id = v_tenant and id = p_list_member_id;
    update public.dialer_sessions set state = 'calling', current_call_id = v_call, last_seen_at = now()
      where tenant_id = v_tenant and id = p_session_id;
  end if;
  if p_callback_activity_id is not null then
    update public.activities
      set status = 'in_progress', claimed_by = v_user, claim_expires_at = now() + interval '2 hours', call_id = v_call
      where tenant_id = v_tenant and id = p_callback_activity_id;
  end if;

  insert into public.audit_logs(tenant_id, actor_user_id, action, entity_type, entity_id, after_data)
  values(v_tenant, v_user, 'call.reserved', 'call', v_call::text,
    jsonb_build_object('attempt_id', v_attempt, 'customer_id', p_customer_id,
      'destination_suffix', right(p_target_phone, 4)));

  return jsonb_build_object(
    'callId', v_call, 'attemptId', v_attempt, 'to', p_target_phone,
    'callerId', v_caller.number_e164, 'callerIdSource', v_caller.caller_id_source,
    'callerIdPhoneNumberId', v_caller.phone_number_id,
    'status', 'requested', 'attemptStatus', 'requested', 'providerStatus', 'requesting',
    'purpose', v_purpose, 'idempotentReplay', false
  );
end $$;

comment on function public.reserve_outbound_call(uuid, uuid, text, uuid, uuid, uuid, uuid, text, text, uuid, uuid) is
  'Reserverar säljarens plats och skapar samtalet innan leverantören kontaktas. Leverantörsneutral efterföljare till rinkel_reserve_platform_outbound_call_v2.';

revoke all on function public.reserve_outbound_call(uuid, uuid, text, uuid, uuid, uuid, uuid, text, text, uuid, uuid) from public, anon;
grant execute on function public.reserve_outbound_call(uuid, uuid, text, uuid, uuid, uuid, uuid, text, text, uuid, uuid) to authenticated;

create or replace function public.finalize_dial(
  p_call_id uuid,
  p_attempt_id uuid,
  p_outcome text,
  p_external_call_id text default null,
  p_error_code text default null,
  p_error_message text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_attempt_status text;
  v_call_status text;
begin
  if v_tenant is null then raise exception 'authentication_required'; end if;
  if p_outcome not in ('accepted','failed','unknown') then raise exception 'finalize_outcome_invalid'; end if;

  -- 'unknown' är inte 'failed'. Ett anrop som gick ut men vars svar aldrig kom
  -- kan mycket väl ha startat ett samtal, och att stänga det som misslyckat hade
  -- släppt platsen medan telefonen fortfarande ringer.
  v_attempt_status := case p_outcome
    when 'accepted' then 'dial_requested'
    when 'failed' then 'failed'
    else 'provider_outcome_unknown' end;
  v_call_status := case p_outcome
    when 'accepted' then 'dial_requested'
    when 'failed' then 'failed'
    else 'provider_outcome_unknown' end;

  update public.dial_attempts a
  set status = v_attempt_status,
      external_call_id = coalesce(p_external_call_id, a.external_call_id),
      provider_request_finished_at = now(),
      error_code = coalesce(p_error_code, a.error_code),
      error_message = left(coalesce(p_error_message, a.error_message), 500),
      updated_at = now()
  where a.id = p_attempt_id and a.tenant_id = v_tenant and a.call_id = p_call_id;
  if not found then raise exception 'dial_attempt_not_found'; end if;

  update public.calls c
  set status = v_call_status,
      provider_status = case p_outcome when 'accepted' then 'requested' when 'failed' then 'failed' else 'unknown' end,
      provider_call_id = coalesce(p_external_call_id, c.provider_call_id),
      ended_at = case when p_outcome = 'failed' then coalesce(c.ended_at, now()) else c.ended_at end,
      updated_at = now()
  where c.id = p_call_id and c.tenant_id = v_tenant;

  insert into public.call_events(tenant_id, call_id, event_type, payload)
  values(v_tenant, p_call_id, 'call.dial_finalized', jsonb_build_object(
    'attempt_id', p_attempt_id, 'outcome', p_outcome, 'error_code', p_error_code));

  return jsonb_build_object('callId', p_call_id, 'attemptId', p_attempt_id,
    'status', v_call_status, 'attemptStatus', v_attempt_status);
end $$;

comment on function public.finalize_dial(uuid, uuid, text, text, text, text) is
  'Skriver utfallet av providerens uppringningsanrop. Ett okänt utfall stängs inte som misslyckat, eftersom samtalet kan pågå.';

revoke all on function public.finalize_dial(uuid, uuid, text, text, text, text) from public, anon;
grant execute on function public.finalize_dial(uuid, uuid, text, text, text, text) to authenticated;
