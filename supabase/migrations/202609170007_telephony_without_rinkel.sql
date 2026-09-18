-- De funktioner som överlever flyttas till den neutrala platsmodellen, och den
-- som bara fanns för Rinkels skull tas bort.
--
-- Fyra funktioner rör samtalsförsöket och ska vara kvar: de handlar om säljarens
-- plats och samtalets tillstånd, inte om vem som kopplar samtalet. De pekas om
-- från `rinkel_call_attempts_v2` till `dial_attempts`.
--
-- `current_user_dial_path` tas bort helt. Den svarade på frågan "vilken telefon
-- ringer först" -- deviceRingsPhone, webphoneOnly, ringDevices,
-- seatNameMatchesProfile. Den frågan fanns bara för att Rinkel ringde upp en
-- registrerad enhet som sedan kopplade vidare. Webbläsaren ringer direkt, så
-- frågan har inget svar längre och funktionen inget syfte.
--
-- `telephony_status_for_current_user` skrivs om från grunden i stället för att
-- porteras. Av dess tjugotre Rinkel-referenser handlade nästan alla om
-- provisionering: fanns användaren hos leverantören, fanns en enhet, var
-- allokeringen aktiv. Ingenting av det existerar nu. Kvar är de frågor som
-- faktiskt avgör om säljaren kan ringa.

create or replace function public.end_active_call(p_call_id uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_user uuid := auth.uid();
  v_call record;
  v_is_admin boolean;
  v_on_behalf boolean;
  v_rank integer;
  v_attempt_id uuid;
  v_external_call_id text;
  v_attempt_released boolean := false;
  v_call_closed boolean := false;
  v_reason text := left(coalesce(nullif(trim(p_reason), ''), 'Avslutat av användaren'), 200);
  v_error_code text;
begin
  if v_tenant is null or v_user is null then raise exception 'tenant_context_required'; end if;

  select c.id, c.user_id, c.status, c.provider, c.customer_id, c.list_id
    into v_call
  from public.calls c
  where c.tenant_id = v_tenant and c.id = p_call_id
  for update;
  if not found then raise exception 'call_not_found'; end if;

  v_is_admin := public.is_tenant_admin(v_tenant);
  v_on_behalf := v_call.user_id is distinct from v_user;
  if v_on_behalf and not v_is_admin then raise exception 'call_not_owned_by_caller'; end if;
  v_error_code := case when v_on_behalf then 'ENDED_BY_ADMIN' else 'ENDED_BY_SELLER' end;

  v_rank := public.call_status_rank(v_call.status);

  update public.dial_attempts a
     set status = 'failed',
         error_code = v_error_code,
         error_message = left(format('Samtalet avslutades manuellt (%s).', v_reason), 500),
         provider_request_finished_at = now(),
         updated_at = now()
   where a.tenant_id = v_tenant
     and a.call_id = v_call.id
     and public.dial_attempt_holds_seat(a.status)
  returning a.id, a.external_call_id into v_attempt_id, v_external_call_id;
  v_attempt_released := found;

  if v_rank < 40 then
    update public.calls
       set status = 'cancelled',
           ended_at = coalesce(ended_at, now()),
           end_cause = coalesce(end_cause, 'cancelled_by_user'),
           updated_at = now()
     where tenant_id = v_tenant and id = v_call.id;
    v_call_closed := true;
  end if;

  if v_attempt_released or v_call_closed then
    insert into public.call_events(tenant_id, call_id, event_type, payload)
    values (v_tenant, v_call.id, 'call.ended_by_user', jsonb_build_object(
      'attempt_id', v_attempt_id, 'external_call_id', v_external_call_id,
      'actor_user_id', v_user, 'on_behalf_of_seller', v_on_behalf, 'reason', v_reason,
      'previous_call_status', v_call.status,
      'attempt_released', v_attempt_released, 'call_closed', v_call_closed));
    insert into public.audit_logs(tenant_id, actor_user_id, action, entity_type, entity_id, after_data)
    values (v_tenant, v_user, 'call.ended_by_user', 'call', v_call.id::text, jsonb_build_object(
      'attempt_id', v_attempt_id, 'seller_user_id', v_call.user_id, 'reason', v_reason,
      'attempt_released', v_attempt_released, 'call_closed', v_call_closed));
  end if;

  -- Meddelandena är omskrivna därför att de inte längre är sanna.
  --
  -- De sa att telefonitjänsten inte kan koppla ned ett pågående samtal och bad
  -- säljaren lägga på i telefonen. Det stämde för Rinkel, som saknade endpoint
  -- för det. Webbtelefonen lägger på själv, så webbläsaren avslutar samtalet i
  -- samma ögonblick som den här funktionen släpper platsen.
  return jsonb_build_object(
    'callId', v_call.id,
    'attemptReleased', v_attempt_released,
    'callClosed', v_call_closed,
    'previousStatus', v_call.status,
    'callStatus', case when v_call_closed then 'cancelled' else v_call.status end,
    'answeredWhenEnded', v_rank >= 40 and v_rank < 100,
    'message', case
      when v_rank >= 100 then 'Samtalet var redan avslutat. Nästa nummer kan ringas.'
      when v_rank >= 40 then 'Samtalet avslutades. Nästa nummer kan ringas.'
      else 'Uppringningen avbröts. Nästa nummer kan ringas.'
    end
  );
end $$;

create or replace function public.close_dial_attempt_with_call()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if new.status is not distinct from old.status then return new; end if;
  if new.status not in ('completed','unanswered','failed','blocked','voicemail','cancelled','outside_business_hours') then
    return new;
  end if;

  update public.dial_attempts a
  set status = case when new.status = 'failed' then 'failed' else 'completed' end,
      error_code = coalesce(a.error_code, 'ATTEMPT_CLOSED_WITH_CALL'),
      updated_at = now()
  where a.call_id = new.id
    and a.tenant_id = new.tenant_id
    and public.dial_attempt_holds_seat(a.status);

  return new;
end $$;

create or replace function public.close_webphone_session_internal(p_session_id uuid, p_status text, p_reason text)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_session record;
  v_released record;
  v_count integer := 0;
begin
  update public.webphone_sessions s
     set status = p_status, closed_at = now(),
         close_reason = left(nullif(trim(coalesce(p_reason, '')), ''), 200),
         updated_at = now()
   where s.id = p_session_id and s.status in ('registering','registered')
  returning s.id, s.tenant_id, s.seller_user_id into v_session;
  if not found then return 0; end if;

  for v_released in
    update public.dial_attempts a
       set status = 'failed',
           error_code = coalesce(a.error_code, 'WEBPHONE_SESSION_ENDED'),
           error_message = left(format(
             'Webbtelefonen tappade registreringen (%s), så samtalsbenet fanns inte kvar. Försöket släpptes så att nästa nummer kan ringas.',
             coalesce(nullif(trim(coalesce(p_reason, '')), ''), 'okänd orsak')
           ), 500),
           provider_request_finished_at = coalesce(a.provider_request_finished_at, now()),
           updated_at = now()
     where a.webphone_session_id = v_session.id
       and public.dial_attempt_holds_seat(a.status)
    returning a.id, a.tenant_id, a.call_id, a.seller_user_id
  loop
    v_count := v_count + 1;

    update public.calls c
       set status = 'failed', ended_at = coalesce(c.ended_at, now()),
           end_cause = coalesce(c.end_cause, 'webphone_session_lost'), updated_at = now()
     where c.id = v_released.call_id and c.tenant_id = v_released.tenant_id
       and public.call_status_rank(c.status) < 40;

    insert into public.call_events(tenant_id, call_id, event_type, payload)
    values (v_released.tenant_id, v_released.call_id, 'webphone.session_ended', jsonb_build_object(
      'session_id', v_session.id, 'attempt_id', v_released.id, 'status', p_status, 'reason', p_reason));

    insert into public.audit_logs(tenant_id, actor_user_id, action, entity_type, entity_id, after_data)
    values (v_released.tenant_id, null, 'webphone.attempt_released', 'call', v_released.call_id::text,
      jsonb_build_object('session_id', v_session.id, 'seller_user_id', v_released.seller_user_id,
        'session_status', p_status, 'reason', p_reason));
  end loop;

  return v_count;
end $$;

create or replace function public.record_webphone_leg_event(
  p_call_id uuid, p_session_id uuid, p_event text, p_occurred_at timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_user uuid := auth.uid();
  v_call record;
  v_rank integer;
  v_attempt_released boolean := false;
  v_advanced text := null;
  v_occurred timestamptz := coalesce(p_occurred_at, now());
begin
  if v_tenant is null or v_user is null then raise exception 'authentication_required'; end if;
  if p_event not in ('ringing','answered','ended','failed') then raise exception 'webphone_leg_event_unknown'; end if;
  if v_occurred > now() + interval '1 minute' then v_occurred := now(); end if;

  if not exists(
    select 1 from public.webphone_sessions s
    where s.id = p_session_id and s.tenant_id = v_tenant and s.seller_user_id = v_user
      and s.status in ('registering','registered')
  ) then raise exception 'webphone_session_not_found'; end if;

  select c.id, c.tenant_id, c.status, c.user_id, c.answered_at into v_call
  from public.calls c where c.tenant_id = v_tenant and c.id = p_call_id for update;
  if not found then raise exception 'call_not_found'; end if;
  if v_call.user_id is distinct from v_user then raise exception 'call_not_owned_by_caller'; end if;

  update public.dial_attempts a
     set webphone_session_id = p_session_id, updated_at = now()
   where a.tenant_id = v_tenant and a.call_id = v_call.id
     and a.webphone_session_id is null
     and public.dial_attempt_holds_seat(a.status);

  v_rank := public.call_status_rank(v_call.status);

  if p_event = 'ringing' and v_rank < 30 then
    update public.calls set status = 'ringing', updated_at = now()
      where tenant_id = v_tenant and id = v_call.id;
    v_advanced := 'ringing';
  elsif p_event = 'answered' and v_rank < 40 then
    update public.calls
       set status = 'answered', answered_at = coalesce(answered_at, v_occurred),
           metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
             'answered_at_source', 'webphone_client', 'webphone_session_id', p_session_id),
           updated_at = now()
     where tenant_id = v_tenant and id = v_call.id;
    v_advanced := 'answered';
  elsif p_event in ('ended','failed') then
    update public.dial_attempts a
       set status = 'failed',
           error_code = coalesce(a.error_code, case when p_event = 'failed' then 'WEBPHONE_LEG_FAILED' else 'WEBPHONE_LEG_ENDED' end),
           error_message = left('Webbtelefonens samtalsben avslutades. Försöket släpptes så att nästa nummer kan ringas.', 500),
           provider_request_finished_at = coalesce(a.provider_request_finished_at, now()),
           updated_at = now()
     where a.tenant_id = v_tenant and a.call_id = v_call.id
       and public.dial_attempt_holds_seat(a.status);
    v_attempt_released := found;

    if v_rank < 40 then
      update public.calls
         set status = case when p_event = 'failed' then 'failed' else 'unanswered' end,
             ended_at = coalesce(ended_at, v_occurred),
             end_cause = coalesce(end_cause, 'webphone_leg_ended'), updated_at = now()
       where tenant_id = v_tenant and id = v_call.id;
      v_advanced := case when p_event = 'failed' then 'failed' else 'unanswered' end;
    end if;
  end if;

  insert into public.call_events(tenant_id, call_id, event_type, occurred_at, payload)
  values (v_tenant, v_call.id, 'webphone.leg.' || p_event, v_occurred, jsonb_build_object(
    'source', 'client_reported', 'session_id', p_session_id, 'seller_user_id', v_user,
    'status_before', v_call.status, 'advanced_to', v_advanced));

  return jsonb_build_object('callId', v_call.id, 'event', p_event, 'advancedTo', v_advanced,
    'attemptReleased', v_attempt_released, 'authoritative', false);
end $$;

-- Kan säljaren ringa just nu, och om inte -- varför?
--
-- Det är hela frågan. Den gamla versionen svarade dessutom på om säljaren fanns
-- provisionerad hos leverantören, hade en registrerad enhet och en aktiv
-- allokering. Inget av det finns att svara på längre.
create or replace function public.telephony_status_for_current_user()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_user uuid := auth.uid();
  v_policy public.telephony_policies%rowtype;
  v_local timestamp;
  v_within_hours boolean := false;
  v_caller record;
  v_has_caller_id boolean := false;
  v_feature boolean := false;
  v_open_attempt boolean := false;
  v_blockers jsonb := '[]'::jsonb;
begin
  if v_tenant is null or v_user is null then raise exception 'authentication_required'; end if;

  select * into v_policy from public.telephony_policies where tenant_id = v_tenant;
  v_feature := exists(select 1 from public.tenant_features
    where tenant_id = v_tenant and feature_key = 'outbound_calls' and enabled);

  if found then
    v_local := now() at time zone v_policy.timezone;
    v_within_hours := extract(isodow from v_local)::integer = any(v_policy.allowed_days)
      and v_local::time >= v_policy.allowed_start_time
      and v_local::time < v_policy.allowed_end_time;
  end if;

  select * into v_caller from public.resolve_caller_id_phone_number(v_tenant, null, null, null, null);
  v_has_caller_id := found;

  v_open_attempt := exists(select 1 from public.dial_attempts a
    where a.tenant_id = v_tenant and a.seller_user_id = v_user
      and public.dial_attempt_holds_seat(a.status));

  -- Varje hinder bär sin egen mening. En säljare som ser "telefoni ej redo" vet
  -- inte vad hon ska göra; en som ser vilket av fyra villkor som brister gör det.
  if not v_feature then
    v_blockers := v_blockers || jsonb_build_object('code','OUTBOUND_CALLS_DISABLED',
      'message','Utgående samtal är inte påslaget för företaget.');
  end if;
  if v_policy.tenant_id is null or not v_policy.telephony_enabled then
    v_blockers := v_blockers || jsonb_build_object('code','TELEPHONY_DISABLED',
      'message','Telefonin är avstängd för företaget.');
  elsif not v_within_hours then
    v_blockers := v_blockers || jsonb_build_object('code','OUTSIDE_CALLING_HOURS',
      'message', format('Utanför företagets ringtider (%s-%s, %s).',
        to_char(v_policy.allowed_start_time,'HH24:MI'),
        to_char(v_policy.allowed_end_time,'HH24:MI'), v_policy.timezone));
  end if;
  if not v_has_caller_id then
    v_blockers := v_blockers || jsonb_build_object('code','CALLER_ID_MISSING',
      'message','Företaget har inget nummer att visa för mottagaren. En administratör behöver välja företagets utgående nummer.');
  end if;
  if v_open_attempt then
    v_blockers := v_blockers || jsonb_build_object('code','ACTIVE_CALL_ALREADY_EXISTS',
      'message','Du har redan ett pågående samtal. Avsluta det innan du ringer nästa nummer.');
  end if;

  return jsonb_build_object(
    'tenantEnabled', coalesce(v_policy.telephony_enabled, false),
    'outboundCallsEnabled', v_feature,
    'withinCallingHours', v_within_hours,
    'callerIdConfigured', v_has_caller_id,
    'callerIdNumber', v_caller.number_e164,
    'callerIdSource', v_caller.caller_id_source,
    'hasOpenAttempt', v_open_attempt,
    'manualReady', v_feature and coalesce(v_policy.telephony_enabled,false)
      and coalesce(v_policy.manual_dialer_enabled,false) and v_within_hours and v_has_caller_id and not v_open_attempt,
    'automaticReady', v_feature and coalesce(v_policy.telephony_enabled,false)
      and coalesce(v_policy.automatic_dialer_enabled,false) and v_within_hours and v_has_caller_id and not v_open_attempt,
    'status', case when jsonb_array_length(v_blockers) = 0 then 'ready' else 'blocked' end,
    'blockers', v_blockers
  );
end $$;

revoke all on function public.telephony_status_for_current_user() from public, anon;
grant execute on function public.telephony_status_for_current_user() to authenticated;

drop function if exists public.current_user_dial_path();
