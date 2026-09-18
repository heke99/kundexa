-- Tar emot Sinchs samtalshändelser i en enda hållbar databasrundtur.
--
-- Rutten som anropar den har redan verifierat signaturen. Det som återstår är
-- att lagra händelsen idempotent, koppla den till rätt samtalsförsök och skriva
-- utfallet -- och att göra det innan svaret går tillbaka, eftersom en leverantör
-- som inte får kvittering snabbt börjar göra om leveransen eller sluta leverera.
--
-- Två saker skiljer den från Rinkels motsvarighet, och båda är det som gör att
-- avstämningsworkern kan utgå:
--
-- `ace` finns. Rinkels `callStart` levererade aldrig -- noll mottagna sedan
-- 4 augusti -- och utan den gick `answered_at` inte att sätta, vilket i sin tur
-- blockerade kontrakt-från-samtal. Sinch har en egen händelse för att samtalet
-- besvarades, och det är den som låser upp kedjan.
--
-- `dice` bär orsak, längd och faktisk kostnad. Rinkel krävde att vi hämtade
-- CDR:er i efterhand och gissade oss till vilket försök de hörde till.
--
-- En händelse som kommer före klienten hunnit rapportera sitt samtals-ID lagras
-- utan tenant och utan koppling, i stället för att kastas. `tenant_id` är
-- nullbar just för det fallet, och raden kan kopplas senare.

create or replace function public.ingest_sinch_voice_event(
  p_event text,
  p_external_call_id text,
  p_provider_event_id text,
  p_payload jsonb,
  p_received_at timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_event_id uuid;
  v_duplicate boolean := false;
  v_attempt record;
  v_reason text;
  v_call_status text;
  v_answered boolean := false;
begin
  insert into public.provider_webhook_events(
    provider, event_type, provider_event_id, payload, received_at, status)
  values('sinch', p_event, p_provider_event_id, p_payload, p_received_at, 'received')
  on conflict (provider, provider_event_id) do nothing
  returning id into v_event_id;

  if v_event_id is null then
    -- Redan mottagen. Sinch gör om leveransen vid utebliven kvittering, och att
    -- behandla samma händelse två gånger skulle kunna stänga ett samtal som
    -- hunnit börja om.
    return jsonb_build_object('duplicate', true, 'matched', false);
  end if;

  select a.id, a.tenant_id, a.call_id, a.status
  into v_attempt
  from public.dial_attempts a
  where a.provider = 'sinch' and a.external_call_id = p_external_call_id
  limit 1;

  if not found then
    -- Händelsen kom före klientens rapport om sitt samtals-ID. Raden ligger kvar
    -- olöst i stället för att kastas, så den går att koppla i efterhand.
    update public.provider_webhook_events
      set status = 'unmatched'
      where id = v_event_id;
    return jsonb_build_object('duplicate', false, 'matched', false);
  end if;

  update public.provider_webhook_events
    set tenant_id = v_attempt.tenant_id, status = 'processed', processed_at = now()
    where id = v_event_id;

  if p_event = 'ace' then
    -- Besvarat. Providerns ord väger tyngre än klientens, så källan skrivs ut:
    -- webbläsaren kan också rapportera ett svar, och den som läser raden ska
    -- kunna se vilken av dem som satte tiden.
    update public.calls c
    set status = 'answered',
        answered_at = coalesce(c.answered_at, coalesce((p_payload->>'timestamp')::timestamptz, p_received_at)),
        provider_status = 'connected',
        metadata = c.metadata || jsonb_build_object('answered_at_source', 'sinch_ace'),
        updated_at = now()
    where c.id = v_attempt.call_id and c.tenant_id = v_attempt.tenant_id
      and public.call_status_rank(c.status) < public.call_status_rank('answered');

    update public.dial_attempts
      set status = 'matched', updated_at = now()
      where id = v_attempt.id and public.dial_attempt_holds_seat(status);

    insert into public.call_events(tenant_id, call_id, event_type, payload)
    values(v_attempt.tenant_id, v_attempt.call_id, 'sinch.call_answered',
      jsonb_build_object('attempt_id', v_attempt.id, 'source', 'provider'));

    return jsonb_build_object('duplicate', false, 'matched', true, 'event', 'ace');
  end if;

  if p_event = 'dice' then
    v_reason := upper(coalesce(p_payload->>'reason', 'N/A'));
    v_answered := exists(
      select 1 from public.calls c
      where c.id = v_attempt.call_id and c.tenant_id = v_attempt.tenant_id and c.answered_at is not null);

    -- Ett samtal som besvarades är genomfört, oavsett vem som lade på. Ett som
    -- aldrig besvarades är obesvarat, inte misslyckat -- skillnaden avgör om
    -- numret ska ringas igen.
    v_call_status := case
      when v_reason = 'BLOCKED' then 'blocked'
      when v_answered then 'completed'
      when v_reason in ('TIMEOUT','CALLERHANGUP','CALLEEHANGUP','MANAGERHANGUP','CANCEL') then 'unanswered'
      else 'failed' end;

    update public.calls c
    set status = v_call_status,
        provider_status = 'ended',
        ended_at = coalesce(c.ended_at, coalesce((p_payload->>'timestamp')::timestamptz, p_received_at)),
        end_cause = coalesce(c.end_cause, lower(v_reason)),
        duration_seconds = coalesce(c.duration_seconds, (p_payload->>'duration')::integer),
        updated_at = now()
    where c.id = v_attempt.call_id and c.tenant_id = v_attempt.tenant_id
      and public.call_status_rank(c.status) < public.call_status_rank(v_call_status);

    update public.dial_attempts
      set status = case when v_call_status = 'failed' then 'failed' else 'completed' end,
          provider_request_finished_at = coalesce(provider_request_finished_at, now()),
          updated_at = now()
      where id = v_attempt.id and public.dial_attempt_holds_seat(status);

    insert into public.call_events(tenant_id, call_id, event_type, payload)
    values(v_attempt.tenant_id, v_attempt.call_id, 'sinch.call_ended', jsonb_build_object(
      'attempt_id', v_attempt.id, 'reason', v_reason,
      'duration', p_payload->'duration', 'debit', p_payload->'debit'));

    return jsonb_build_object('duplicate', false, 'matched', true,
      'event', 'dice', 'callStatus', v_call_status);
  end if;

  return jsonb_build_object('duplicate', false, 'matched', true, 'event', p_event);
end $$;

comment on function public.ingest_sinch_voice_event(text, text, text, jsonb, timestamptz) is
  'Lagrar en verifierad Sinch-händelse idempotent och skriver utfallet på samtalet och försöket.';

revoke all on function public.ingest_sinch_voice_event(text, text, text, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.ingest_sinch_voice_event(text, text, text, jsonb, timestamptz) to service_role;
