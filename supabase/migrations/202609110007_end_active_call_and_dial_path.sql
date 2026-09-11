-- Avsluta ett pågående samtal, och gör uppringningsvägen synlig.
--
-- Two facts about Rinkel decide the shape of this migration, both established
-- against Rinkel's own published API surface (developers.rinkel.com, the
-- complete endpoint list) rather than assumed:
--
--   1. The only call-control endpoint Rinkel exposes is `POST /dial`. There is
--      no hangup, no terminate, no call-leg endpoint. Kundexa therefore cannot
--      drop a call that is already up; the seller hangs up on the device.
--   2. `/dial` requires a `deviceId`. A call is always originated *through a
--      provider user's device* and never "from the number" on its own. Which
--      device rings is therefore a property of the seller's Rinkel seat, and
--      when several sellers share one seat every call rings that one person's
--      phone.
--
-- What was missing on Kundexa's side is the part that is ours:
--
--   * `rinkel_reserve_platform_outbound_call_v2` refuses a second dial while an
--     attempt is in a non-terminal status (`active_call_already_exists`), and
--     the only thing that ever released such an attempt was
--     `rinkel_release_stale_call_attempts`, a service-role janitor that refuses
--     any bound under 15 minutes. A seller whose attempt hung could not call
--     anyone for up to an hour, with no control anywhere in the product.
--     `end_active_call` gives that seller the release, immediately.
--   * The device leg was invisible. The reservation has always known the
--     provider user's own phone number (it uses it for the self-dial guard) but
--     showed it nowhere, so "the call went via someone else's phone" could only
--     be discovered by hearing it ring. `current_user_dial_path` reports it, so
--     the dialer can state, before the call, which phone rings first and which
--     number the customer sees.

-- 1. Operator-initiated end of a call.
--
-- Deliberately asymmetric between the two cases, because they are not the same
-- claim:
--
--   * Not yet answered — Kundexa can say truthfully that the call ended, so the
--     call is closed as `cancelled` (a terminal rank, which is what makes the
--     after-call form appear and what `complete_manual_call_work` and
--     `complete_dialer_work_v2` both accept).
--   * Already answered — the conversation is happening on a device Kundexa
--     cannot reach. Writing a terminal status here would freeze the projection
--     (`protect_rinkel_call_projection` pins every provider field once the rank
--     reaches 100) and throw away the real duration and outcome that the
--     webhook or CDR is about to deliver. So the call row is left alone and only
--     the attempt is released. The seller can dial the next number; the truth
--     about this one still arrives from the provider.
create or replace function public.end_active_call(
  p_call_id uuid,
  p_reason text default null
) returns jsonb
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
  if v_tenant is null or v_user is null then
    raise exception 'tenant_context_required';
  end if;

  select c.id, c.user_id, c.status, c.provider, c.customer_id, c.list_id
    into v_call
  from public.calls c
  where c.tenant_id = v_tenant
    and c.id = p_call_id
  for update;
  if not found then
    raise exception 'call_not_found';
  end if;

  v_is_admin := public.is_tenant_admin(v_tenant);
  v_on_behalf := v_call.user_id is distinct from v_user;
  -- A seller ends their own call. An admin may end anyone's, because the whole
  -- point of the action is to unblock a seat, and the person who is blocked is
  -- not always the person who can reach the screen.
  if v_on_behalf and not v_is_admin then
    raise exception 'call_not_owned_by_caller';
  end if;
  v_error_code := case when v_on_behalf then 'ENDED_BY_ADMIN' else 'ENDED_BY_SELLER' end;

  v_rank := public.call_status_rank(v_call.status);

  -- Release the attempt whatever the call's own status is: a terminal call with
  -- a live attempt row is exactly the state that wedges the seat, and it is the
  -- state a lost provider event leaves behind.
  update public.rinkel_call_attempts_v2 a
     set status = 'failed',
         error_code = v_error_code,
         error_message = left(format(
           'Samtalsförsöket avslutades manuellt (%s). Telefonitjänsten kan inte koppla ned ett pågående samtal via sitt API — lägg på i webbtelefonen eller appen. Försöket släpptes så att nästa nummer kan ringas.',
           v_reason
         ), 500),
         provider_request_finished_at = now(),
         updated_at = now()
   where a.tenant_id = v_tenant
     and a.call_id = v_call.id
     and a.status in (
       'requested', 'dial_requested', 'awaiting_provider_event', 'matched',
       'provider_outcome_unknown', 'reconciliation_required'
     )
  returning a.id, a.external_call_id into v_attempt_id, v_external_call_id;
  v_attempt_released := found;

  -- Rank 40 is `answered`/`in_progress`; 100 is terminal. Only an unanswered,
  -- still-open call may be declared ended by Kundexa.
  if v_rank < 40 then
    update public.calls
       set status = 'cancelled',
           ended_at = coalesce(ended_at, now()),
           end_cause = coalesce(end_cause, 'cancelled_by_user'),
           updated_at = now()
     where tenant_id = v_tenant
       and id = v_call.id;
    v_call_closed := true;
  end if;

  if v_attempt_released or v_call_closed then
    insert into public.call_events(tenant_id, call_id, event_type, payload)
    values (v_tenant, v_call.id, 'call.ended_by_user', jsonb_build_object(
      'attempt_id', v_attempt_id,
      'external_call_id', v_external_call_id,
      'actor_user_id', v_user,
      'on_behalf_of_seller', v_on_behalf,
      'reason', v_reason,
      'previous_call_status', v_call.status,
      'attempt_released', v_attempt_released,
      'call_closed', v_call_closed,
      -- Say plainly, in the event stream, that the provider was never asked to
      -- drop the call. Nothing downstream should read `cancelled` as "Rinkel
      -- terminated it".
      'provider_hangup_requested', false
    ));
    insert into public.audit_logs(tenant_id, actor_user_id, action, entity_type, entity_id, after_data)
    values (v_tenant, v_user, 'call.ended_by_user', 'call', v_call.id::text, jsonb_build_object(
      'attempt_id', v_attempt_id,
      'seller_user_id', v_call.user_id,
      'reason', v_reason,
      'attempt_released', v_attempt_released,
      'call_closed', v_call_closed,
      'call_outcome', case when v_call_closed then 'cancelled' else 'left_to_provider' end
    ));
  end if;

  return jsonb_build_object(
    'callId', v_call.id,
    'attemptReleased', v_attempt_released,
    'callClosed', v_call_closed,
    'previousStatus', v_call.status,
    'callStatus', case when v_call_closed then 'cancelled' else v_call.status end,
    -- The client needs to know which of the two stories to tell the seller.
    'providerHangupSupported', false,
    'answeredWhenEnded', v_rank >= 40 and v_rank < 100,
    'message', case
      when v_call_closed then 'Samtalet avslutades och nästa nummer kan ringas.'
      when v_rank >= 100 then 'Samtalet var redan avslutat. Samtalsförsöket släpptes så att nästa nummer kan ringas.'
      else 'Samtalet pågår på din telefonienhet — lägg på där. Kundexa har släppt samtalsförsöket så att nästa nummer kan ringas, och registrerar utfallet när telefonitjänsten rapporterar det.'
    end
  );
end $$;

revoke all on function public.end_active_call(uuid, text) from public, anon;
grant execute on function public.end_active_call(uuid, text) to authenticated;

comment on function public.end_active_call(uuid, text) is
  'Avslutar säljarens pågående samtal i Kundexa och släpper samtalsförsöket. Telefonitjänsten saknar API för att koppla ned ett uppkopplat samtal — det görs på enheten.';

-- 2. The dial path, as a first-class readable fact.
--
-- Added as its own function rather than by rewriting
-- `telephony_status_for_current_user`: that function is ~200 lines of readiness
-- rules that nothing here changes, and retyping it to append two fields is how
-- an unrelated rule gets lost.
--
-- `deviceRingsPhone` is the number Rinkel rings first — the phone on the
-- seller's Rinkel seat. `callerIdNumber` is what the customer sees. They are
-- different numbers and were being confused for one another, because only the
-- second was ever displayed. When one Rinkel seat is shared, every seller's
-- call rings that seat's phone; that is visible here and nowhere else.
create or replace function public.current_user_dial_path()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_user uuid := auth.uid();
  v_mapping record;
  v_caller record;
  v_profile_name text;
begin
  if v_tenant is null or v_user is null then
    return jsonb_build_object('mapped', false);
  end if;

  select
    m.id as mapping_id,
    m.default_number_allocation_id,
    pu.display_name as provider_user_name,
    nullif(trim(pu.raw_provider_data->'phoneNumber'->>'e164'), '') as provider_user_phone_e164,
    nullif(trim(pu.raw_provider_data->>'email'), '') as provider_user_email,
    device.provider_device_id
  into v_mapping
  from public.rinkel_user_mappings_v2 m
  join public.rinkel_user_allocations ua
    on ua.id = m.rinkel_user_allocation_id
   and ua.tenant_id = m.tenant_id
   and ua.status = 'active'
   and ua.valid_to is null
  join public.platform_rinkel_users pu
    on pu.id = ua.rinkel_user_id
   and pu.active
  left join lateral public.rinkel_effective_provider_device(pu.id, m.selected_device_id) device on true
  where m.tenant_id = v_tenant
    and m.kundexa_user_id = v_user
    and m.active;
  if not found then
    return jsonb_build_object('mapped', false);
  end if;

  select * into v_caller
  from public.resolve_rinkel_caller_id(
    v_tenant, v_user, null, null, null, null, v_mapping.default_number_allocation_id
  );

  select p.full_name into v_profile_name
  from public.profiles p
  where p.id = v_user;

  return jsonb_build_object(
    'mapped', true,
    'deviceReady', v_mapping.provider_device_id is not null,
    'deviceRingsPhone', v_mapping.provider_user_phone_e164,
    'providerUserName', v_mapping.provider_user_name,
    'callerIdNumber', v_caller.phone_number_e164,
    'callerIdSource', v_caller.allocation_source,
    -- A weak signal on purpose: Rinkel has no field that ties a seat to a
    -- Kundexa user, so the display name is all there is. It drives a warning,
    -- never a refusal — refusing a call on a name mismatch would ground a
    -- seller over a spelling.
    'seatNameMatchesProfile', case
      when v_mapping.provider_user_name is null or v_profile_name is null then null
      else lower(trim(v_mapping.provider_user_name)) = lower(trim(v_profile_name))
    end
  );
end $$;

revoke all on function public.current_user_dial_path() from public, anon;
grant execute on function public.current_user_dial_path() to authenticated;

comment on function public.current_user_dial_path() is
  'Visar vilken telefon som ringer först (säljarens plats hos telefonitjänsten) och vilket nummer kunden ser. Två olika nummer som tidigare inte gick att skilja åt i gränssnittet.';
