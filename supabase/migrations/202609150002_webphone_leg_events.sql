-- Webbläsaren vet direkt hur samtalet går. Men den är part i målet.
--
-- I dag är en webhook enda källan till att ett samtal ringde, svarades eller
-- avslutades. När den uteblir står `answered_at` kvar som null för alltid, och
-- allt som hänger på "samtalet besvarades" — avtal från samtal, efterarbete,
-- statistik — hänger med. Mätt i produktion: samtalet 2026-09-15 08:12 fick noll
-- `call_events` och inget `external_call_id`.
--
-- Med en webbtelefon vet klienten det före telefonitjänsten. Frestelsen är att
-- låta den skriva sanningen. Det vore fel: en klient kan ljuga, tappa nätet mitt
-- i, eller rapportera i fel ordning, och ett `answered_at` som en webbläsare
-- hittat på är värre än inget alls när det ligger till grund för fakturerbar tid.
--
-- Uppdelningen blir därför den här:
--
--   * Klienten får **flytta samtalet framåt** genom lägen den bevisligen känner
--     till före någon annan — ringer, svarade — men bara uppåt, aldrig förbi ett
--     läge telefonitjänsten redan fastställt.
--   * Klienten får **släppa platsen** när benet dör, vilket är den verkliga
--     vinsten: säljaren kan ringa nästa nummer direkt.
--   * Klienten får **aldrig** skriva ett slutgiltigt utfall på ett besvarat
--     samtal. Längd och orsak är telefonitjänstens, precis som i
--     `end_active_call`, där samma avvägning redan är gjord och testad.
--
-- Varje rad märks `"source": "client_reported"` i nyttolasten, så en avstämning
-- alltid kan se vad som kom från en webbläsare och vad som kom från leverantören.

create or replace function public.record_webphone_leg_event(
  p_call_id uuid,
  p_session_id uuid,
  p_event text,
  p_occurred_at timestamptz default now()
) returns jsonb
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
  if v_tenant is null or v_user is null then
    raise exception 'authentication_required';
  end if;
  if p_event not in ('ringing','answered','ended','failed') then
    raise exception 'webphone_leg_event_unknown';
  end if;
  -- En webbläsares klocka går inte att lita på. En tidpunkt i framtiden, eller
  -- långt före samtalet, får inte bli det som står i historiken.
  if v_occurred > now() + interval '1 minute' then
    v_occurred := now();
  end if;

  -- Sessionen måste vara anroparens egen och levande. Annars kunde en säljare
  -- rapportera ett samtalsben för någon annan.
  if not exists(
    select 1 from public.webphone_sessions s
    where s.id = p_session_id
      and s.tenant_id = v_tenant
      and s.seller_user_id = v_user
      and s.status in ('registering','registered')
  ) then
    raise exception 'webphone_session_not_found';
  end if;

  select c.id, c.tenant_id, c.status, c.user_id, c.answered_at
    into v_call
  from public.calls c
  where c.tenant_id = v_tenant and c.id = p_call_id
  for update;
  if not found then
    raise exception 'call_not_found';
  end if;
  if v_call.user_id is distinct from v_user then
    raise exception 'call_not_owned_by_caller';
  end if;

  -- Första händelsen binder försöket till sessionen. Det är den bindningen som
  -- gör att sopningen vet att just det här benet bars av en webbläsare — utan
  -- den skulle försöket se ut som vilket `/dial`-försök som helst och aldrig
  -- släppas när fliken dör.
  update public.rinkel_call_attempts_v2 a
     set webphone_session_id = p_session_id,
         updated_at = now()
   where a.tenant_id = v_tenant
     and a.call_id = v_call.id
     and a.webphone_session_id is null
     and public.rinkel_attempt_holds_seat(a.status);

  v_rank := public.call_status_rank(v_call.status);

  if p_event = 'ringing' and v_rank < 30 then
    update public.calls set status = 'ringing', updated_at = now()
      where tenant_id = v_tenant and id = v_call.id;
    v_advanced := 'ringing';
  elsif p_event = 'answered' and v_rank < 40 then
    update public.calls
       set status = 'answered',
           answered_at = coalesce(answered_at, v_occurred),
           -- Härkomsten skrivs med. En avstämning som senare får leverantörens
           -- egen tidpunkt ska kunna se att den här kom från en webbläsare, i
           -- stället för att två olika tider tyst konkurrerar.
           metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
             'answered_at_source', 'webphone_client',
             'webphone_session_id', p_session_id
           ),
           updated_at = now()
     where tenant_id = v_tenant and id = v_call.id;
    v_advanced := 'answered';
  elsif p_event in ('ended','failed') then
    update public.rinkel_call_attempts_v2 a
       set status = 'failed',
           error_code = coalesce(a.error_code, case when p_event = 'failed' then 'WEBPHONE_LEG_FAILED' else 'WEBPHONE_LEG_ENDED' end),
           error_message = left(
             'Webbtelefonens samtalsben avslutades. Försöket släpptes så att nästa nummer kan ringas.', 500),
           provider_request_finished_at = coalesce(a.provider_request_finished_at, now()),
           updated_at = now()
     where a.tenant_id = v_tenant
       and a.call_id = v_call.id
       and public.rinkel_attempt_holds_seat(a.status);
    v_attempt_released := found;

    -- Ett obesvarat samtal får klienten avsluta: ingen längd och inget utfall
    -- går förlorat, eftersom det aldrig fanns något. Ett besvarat lämnas till
    -- telefonitjänsten — dess längd och orsak är det enda som är värt något,
    -- och en terminal status här skulle frysa projektionen innan de landat.
    if v_rank < 40 then
      update public.calls
         set status = case when p_event = 'failed' then 'failed' else 'unanswered' end,
             ended_at = coalesce(ended_at, v_occurred),
             end_cause = coalesce(end_cause, 'webphone_leg_ended'),
             updated_at = now()
       where tenant_id = v_tenant and id = v_call.id;
      v_advanced := case when p_event = 'failed' then 'failed' else 'unanswered' end;
    end if;
  end if;

  insert into public.call_events(tenant_id, call_id, event_type, occurred_at, payload)
  values (v_tenant, v_call.id, 'webphone.leg.' || p_event, v_occurred, jsonb_build_object(
    'source', 'client_reported',
    'session_id', p_session_id,
    'seller_user_id', v_user,
    'status_before', v_call.status,
    'advanced_to', v_advanced
  ));

  return jsonb_build_object(
    'callId', v_call.id,
    'event', p_event,
    'advancedTo', v_advanced,
    'attemptReleased', v_attempt_released,
    -- Sägs rakt ut så gränssnittet aldrig presenterar en webbläsares ord som
    -- telefonitjänstens.
    'authoritative', false
  );
end $$;

revoke all on function public.record_webphone_leg_event(uuid, uuid, text, timestamptz) from public, anon;
grant execute on function public.record_webphone_leg_event(uuid, uuid, text, timestamptz) to authenticated;

comment on function public.record_webphone_leg_event(uuid, uuid, text, timestamptz) is
  'Webbtelefonens egen rapport om samtalsbenet. Får flytta samtalet framåt och släppa platsen, aldrig skriva ett slutgiltigt utfall på ett besvarat samtal — det förblir telefonitjänstens.';
