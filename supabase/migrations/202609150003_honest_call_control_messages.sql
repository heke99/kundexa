-- Två meddelanden som lovar saker systemet inte kan göra.
--
-- Båda upptäcktes genom att ägaren gjorde precis det de bad om och det inte
-- hjälpte. Det är samma felklass som raderaknappen som lovade vad databasen
-- vägrade: ett gränssnitt som föreslår en åtgärd utan att kontrollera att
-- åtgärden kan lyckas.
--
-- 1. `current_user_dial_path` sade: "Samtalet ringer upp +46704781927 innan
--    kunden kopplas. Be administratören köra 'Rätta uppringningsvägen'."
--    Administratören körde den. Den lyckades — applied_at satt, inget fel,
--    `muteOtherDevicesOnWebphone: true`. Samtalet ringde ändå mobilen.
--
--    Orsaken är att `POST /dial` kräver ett `deviceId` och inte bär någon
--    ljudväg, så den *måste* ringa upp en enhet först. Att säljaren rings först
--    är inte ett felläge utan hur endpointen fungerar, och ingen inställning
--    ändrar det. `muteOtherDevicesOnWebphone` betyder dessutom bara "ring inte
--    övriga enheter när webbtelefonen är online" — och det finns ingen
--    webbtelefon ännu.
--
--    Rättningen är fortfarande meningsfull för sin andra halva: den sätter
--    vilket nummer kunden ser. Meddelandet skiljer nu på de två, och ber bara
--    om rättningen när rättningen faktiskt kan göra något.
--
-- 2. `end_active_call` svarade "Samtalet avslutades och nästa nummer kan ringas."
--    Kundexa hade stängt sin egen rad. Telefonen fortsatte ringa, eftersom
--    telefonitjänsten inte har någon endpoint för att koppla ned — vilket
--    funktionens egen kommentar redan sade. Mätt 2026-09-15 10:57: ägaren tryckte
--    avsluta, `call.ended_by_user` skrevs 10:57:21, och samtalet fortsatte på
--    enheten tills det lades på där.

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
  v_state jsonb;
  v_seat_shared boolean;
  v_number_wrong boolean;
begin
  if v_tenant is null or v_user is null then
    return jsonb_build_object('mapped', false);
  end if;

  select
    m.id as mapping_id,
    m.default_number_allocation_id,
    pu.id as provider_user_row_id,
    pu.display_name as provider_user_name,
    pu.raw_provider_data,
    pu.dial_policy_applied_at,
    pu.dial_policy_error,
    nullif(trim(pu.raw_provider_data->'phoneNumber'->>'e164'), '') as provider_user_phone_e164,
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

  v_state := public.rinkel_seat_dial_path_state(
    coalesce(v_mapping.raw_provider_data, '{}'::jsonb),
    v_caller.provider_number_id
  );

  select exists(
    select 1
    from public.rinkel_user_mappings_v2 other
    join public.rinkel_user_allocations other_allocation
      on other_allocation.id = other.rinkel_user_allocation_id
     and other_allocation.rinkel_user_id = v_mapping.provider_user_row_id
     and other_allocation.status = 'active'
     and other_allocation.valid_to is null
    where other.active
      and other.kundexa_user_id is distinct from v_user
  ) into v_seat_shared;

  -- Den enda halvan rättningen faktiskt kan ändra: vilket nummer kunden ser.
  -- `false` betyder fel nummer; `null` betyder att företaget inte har någon
  -- nummertilldelning alls, och då finns inget att peka platsen på.
  v_number_wrong := (v_state->>'outboundNumberMatches') = 'false';

  return jsonb_build_object(
    'mapped', true,
    'deviceReady', v_mapping.provider_device_id is not null,
    'deviceRingsPhone', v_mapping.provider_user_phone_e164,
    'providerUserName', v_mapping.provider_user_name,
    'callerIdNumber', v_caller.phone_number_e164,
    'callerIdSource', v_caller.allocation_source,
    'webphoneOnly', v_state->'webphoneOnly',
    'ringDevices', v_state->'ringDevices',
    'outboundNumberMatches', v_state->'outboundNumberMatches',
    'dialPathCorrect', v_state->'correct',
    'dialPolicyAppliedAt', v_mapping.dial_policy_applied_at,
    'dialPolicyError', v_mapping.dial_policy_error,
    'seatSharedWithOtherUser', v_seat_shared,
    -- Nytt: säger rakt ut att den första uppringningen inte är ett felläge, så
    -- gränssnittet kan förklara i stället för att föreslå en åtgärd.
    'ringsSellerFirst', true,
    'repairChangesAnything', v_number_wrong,
    'seatNameMatchesProfile', case
      when v_mapping.provider_user_name is null or v_profile_name is null then null
      else lower(trim(v_mapping.provider_user_name)) = lower(trim(v_profile_name))
    end,
    -- Bara sådant säljaren eller administratören faktiskt kan göra något åt.
    -- Att samtalet ringer upp säljaren först står inte längre här: det är hur
    -- telefonitjänsten fungerar, och en uppmaning att rätta det vore en lögn.
    'issue', case
      when v_number_wrong then
        'Kunden ser fel nummer när du ringer. Be administratören köra "Rätta uppringningsvägen" under Integrationer.'
      when v_seat_shared then
        'Flera säljare delar den här telefoniplatsen, så samtalen ringer upp samma telefon. Det kräver en egen plats per säljare hos telefonitjänsten.'
      else null
    end
  );
end $$;

revoke all on function public.current_user_dial_path() from public, anon;
grant execute on function public.current_user_dial_path() to authenticated;

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
    -- Meddelandet får aldrig påstå att samtalet kopplades ned. Kundexa har
    -- stängt sin egen rad; enheten ringer eller talar vidare tills någon lägger
    -- på där. Ägaren tryckte avsluta 2026-09-15 10:57:21 och telefonen fortsatte
    -- ringa, eftersom den gamla formuleringen sade motsatsen.
    'message', case
      when v_call_closed then 'Uppringningen avbröts i Kundexa och nästa nummer kan ringas. Ringer telefonen fortfarande — avvisa samtalet där; telefonitjänsten kan inte kopplas ned härifrån.'
      when v_rank >= 100 then 'Samtalet var redan avslutat. Samtalsförsöket släpptes så att nästa nummer kan ringas.'
      else 'Samtalet pågår på din telefonienhet — lägg på där. Kundexa har släppt samtalsförsöket så att nästa nummer kan ringas, och registrerar utfallet när telefonitjänsten rapporterar det.'
    end
  );
end $$;

revoke all on function public.end_active_call(uuid, text) from public, anon;
grant execute on function public.end_active_call(uuid, text) to authenticated;
