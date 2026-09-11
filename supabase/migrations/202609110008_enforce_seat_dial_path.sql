-- Uppringningsvägen: ring från webbtelefonen, inte via någons mobil.
--
-- The previous migration made the dial path *visible*. This one makes it
-- *correctable*, because Rinkel does expose the setting — it just was not being
-- used.
--
-- `PATCH /users/{id}` accepts `preferences.muteOtherDevicesOnWebphone`, which
-- Rinkel documents as "call only Webphone when available", and
-- `preferences.defaultOutboundNumber`. Production ran with
-- `muteOtherDevicesOnWebphone: false` and `ringDevices: "all"`, so every dial
-- rang the seat's mobile (+46 70 …, the account owner's personal line)
-- alongside the webphone. Answering there is what made the call "go via the
-- owner's number". Setting it to `true` keeps the leg on the webphone, so the
-- call is placed from the Rinkel number Kundexa dials with.
--
-- Kundexa writes only those two preferences. Rinkel merges a PATCH body, so the
-- seller's language, colour mode, ringtone and notification settings stay
-- theirs; a whole-object write would silently take them over.

alter table public.platform_rinkel_users
  add column if not exists dial_policy_applied_at timestamptz,
  add column if not exists dial_policy_error text;

comment on column public.platform_rinkel_users.dial_policy_applied_at is
  'När Kundexa senast bekräftade att platsen ringer på webbtelefonen och har rätt utgående nummer. Skrivs först efter en läsning tillbaka från telefonitjänsten.';
comment on column public.platform_rinkel_users.dial_policy_error is
  'Varför den senaste rättningen av uppringningsvägen misslyckades. Null när den lyckades.';

-- Correctness, derived rather than stored, so it can never disagree with the
-- synchronised provider payload.
--
-- Two separate conditions, deliberately not collapsed into one boolean:
--   * `webphone_only` is Kundexa's to fix, over the API.
--   * `outbound_number_matches` is Kundexa's to fix too, but only when the
--     tenant actually holds an allocation.
-- A third condition — several sellers sharing one seat — is not enforceable at
-- all: Rinkel exposes no field binding a seat to a Kundexa user. It surfaces as
-- a warning elsewhere and must never refuse a call.
create or replace function public.rinkel_seat_dial_path_state(
  p_raw jsonb,
  p_expected_number_id text
) returns jsonb
language sql
immutable
set search_path to ''
as $$
  select jsonb_build_object(
    'webphoneOnly', coalesce((p_raw->'preferences'->>'muteOtherDevicesOnWebphone')::boolean, false),
    'ringDevices', nullif(trim(p_raw->'preferences'->>'ringDevices'), ''),
    'defaultOutboundNumberId', nullif(trim(p_raw->'preferences'->>'defaultOutboundNumber'), ''),
    'seatPhoneE164', nullif(trim(p_raw->'phoneNumber'->>'e164'), ''),
    'outboundNumberMatches', case
      when p_expected_number_id is null then null
      else nullif(trim(p_raw->'preferences'->>'defaultOutboundNumber'), '') is not distinct from p_expected_number_id
    end,
    'correct',
      coalesce((p_raw->'preferences'->>'muteOtherDevicesOnWebphone')::boolean, false)
      and (
        p_expected_number_id is null
        or nullif(trim(p_raw->'preferences'->>'defaultOutboundNumber'), '') is not distinct from p_expected_number_id
      )
  )
$$;

comment on function public.rinkel_seat_dial_path_state(jsonb, text) is
  'Härleder om en telefoniplats ringer på webbtelefonen och har rätt utgående nummer. Härledd, aldrig lagrad, så den inte kan säga emot den synkade providerbilden.';

-- The seller's own view: which phone rings, which number the customer sees, and
-- — new here — whether that is correct and what to do when it is not.
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

  -- Does anyone else in this tenant dial through the same seat? The unique index
  -- on the mapping makes this impossible today, but a seat allocated to two
  -- tenants would still land here, and a shared seat is exactly the case where
  -- "the call went via someone else's phone" is unavoidable.
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
    'seatNameMatchesProfile', case
      when v_mapping.provider_user_name is null or v_profile_name is null then null
      else lower(trim(v_mapping.provider_user_name)) = lower(trim(v_profile_name))
    end,
    -- One sentence the seller can act on, rather than four booleans they cannot.
    'issue', case
      when not coalesce((v_state->>'correct')::boolean, false) and v_mapping.provider_user_phone_e164 is not null then
        format(
          'Samtalet ringer upp %s innan kunden kopplas. Be administratören köra "Rätta uppringningsvägen" under Integrationer, så sker samtalet i webbtelefonen i stället.',
          v_mapping.provider_user_phone_e164
        )
      when not coalesce((v_state->>'correct')::boolean, false) then
        'Telefoniplatsens uppringningsinställningar är inte rättade. Be administratören köra "Rätta uppringningsvägen" under Integrationer.'
      when v_seat_shared then
        'Flera säljare delar den här telefoniplatsen, så samtalen ringer upp samma telefon. Det kräver en egen plats per säljare hos telefonitjänsten.'
      else null
    end
  );
end $$;

revoke all on function public.current_user_dial_path() from public, anon;
grant execute on function public.current_user_dial_path() to authenticated;

-- The tenant admin's view: every seat this tenant dials through, what is wrong
-- with it, and the provider ids the repair needs. Returned as data rather than
-- as a message so the server action does not have to re-derive any of it.
create or replace function public.tenant_rinkel_dial_path_report()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_expected_number_id text;
  v_seats jsonb;
begin
  if v_tenant is null then
    raise exception 'tenant_context_required';
  end if;
  -- Same audience as the telephony pages themselves: an owner or admin, plus a
  -- team leader, who is the person actually running a calling floor.
  if not (
    public.is_tenant_admin(v_tenant)
    or exists(
      select 1
      from public.tenant_memberships membership
      where membership.tenant_id = v_tenant
        and membership.user_id = auth.uid()
        and membership.status = 'active'
        and membership.role = 'team_lead'
    )
  ) then
    raise exception 'telephony_admin_required';
  end if;

  -- The tenant's own outbound number. A tenant with none has nothing to point
  -- the seats at, and the repair must say that rather than write a null.
  select n.external_number_id
  into v_expected_number_id
  from public.rinkel_number_allocations a
  join public.platform_rinkel_numbers n
    on n.id = a.rinkel_number_id
   and n.active
  where a.tenant_id = v_tenant
    and a.status = 'active'
    and a.valid_to is null
  order by n.is_platform_default desc, a.created_at
  limit 1;

  select coalesce(jsonb_agg(seat order by seat->>'displayName'), '[]'::jsonb)
  into v_seats
  from (
    select jsonb_build_object(
      'providerUserRowId', pu.id,
      'externalUserId', pu.external_user_id,
      'displayName', pu.display_name,
      'email', pu.email,
      'sellerUserId', m.kundexa_user_id,
      'sellerName', p.full_name,
      'appliedAt', pu.dial_policy_applied_at,
      'error', pu.dial_policy_error,
      'state', public.rinkel_seat_dial_path_state(
        coalesce(pu.raw_provider_data, '{}'::jsonb), v_expected_number_id
      )
    ) as seat
    from public.rinkel_user_mappings_v2 m
    join public.rinkel_user_allocations ua
      on ua.id = m.rinkel_user_allocation_id
     and ua.tenant_id = m.tenant_id
     and ua.status = 'active'
     and ua.valid_to is null
    join public.platform_rinkel_users pu
      on pu.id = ua.rinkel_user_id
     and pu.active
    left join public.profiles p on p.id = m.kundexa_user_id
    where m.tenant_id = v_tenant
      and m.active
  ) seats;

  return jsonb_build_object(
    'expectedNumberId', v_expected_number_id,
    'seats', v_seats,
    'incorrectCount', (
      select count(*)
      from jsonb_array_elements(v_seats) entry
      where coalesce((entry->'state'->>'correct')::boolean, false) is not true
    )
  );
end $$;

revoke all on function public.tenant_rinkel_dial_path_report() from public, anon;
grant execute on function public.tenant_rinkel_dial_path_report() to authenticated;

comment on function public.tenant_rinkel_dial_path_report() is
  'Alla telefoniplatser företaget ringer genom, vad som är fel på dem och de provider-id som rättningen behöver.';

-- Records the outcome of one repair. Service role only: the value written is a
-- read-back from the provider, and only the server that performed the call can
-- vouch for it. A tenant admin triggering the repair goes through the server
-- action, which holds the service key — never through this function directly.
create or replace function public.record_rinkel_seat_dial_policy(
  p_provider_user_id uuid,
  p_raw_provider_data jsonb,
  p_error text default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_row record;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception 'service_role_required';
  end if;

  update public.platform_rinkel_users pu
     set raw_provider_data = coalesce(p_raw_provider_data, pu.raw_provider_data),
         -- Applied means confirmed by a read-back, not "the PATCH returned 204".
         -- A 204 says Rinkel accepted the body, not that the seat now rings the
         -- webphone; only reading the seat again establishes that.
         dial_policy_applied_at = case when p_error is null then now() else pu.dial_policy_applied_at end,
         dial_policy_error = left(nullif(trim(coalesce(p_error, '')), ''), 500),
         updated_at = now()
   where pu.id = p_provider_user_id
  returning pu.id, pu.external_user_id, pu.dial_policy_applied_at, pu.dial_policy_error
  into v_row;
  if not found then
    raise exception 'provider_user_not_found';
  end if;

  insert into public.audit_logs(tenant_id, actor_user_id, action, entity_type, entity_id, after_data)
  values (null, null, 'rinkel.seat_dial_policy_applied', 'platform_rinkel_user', v_row.id::text, jsonb_build_object(
    'external_user_id', v_row.external_user_id,
    'applied_at', v_row.dial_policy_applied_at,
    'error', v_row.dial_policy_error
  ));

  return jsonb_build_object(
    'providerUserId', v_row.id,
    'appliedAt', v_row.dial_policy_applied_at,
    'error', v_row.dial_policy_error
  );
end $$;

revoke all on function public.record_rinkel_seat_dial_policy(uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.record_rinkel_seat_dial_policy(uuid, jsonb, text) to service_role;
