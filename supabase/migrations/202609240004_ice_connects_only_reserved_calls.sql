begin;

-- ICE kopplar bara ett samtal som Kundexa har reserverat, och med rätt A-nummer.
--
-- Rutten svarade `connectPstn` på varje ICE från webbtelefonen, även när ingen
-- reservation fanns eller databasen inte svarade (FAILURE-0102). Den som hade en
-- inloggad webbtelefon kunde därför ringa vilket nummer som helst förbi
-- spärrlistan, NIX, ringtiderna och låset på ett samtal i taget, och samtalet
-- fick ingen rad. A-numret togs dessutom ur ICE:n, alltså det nummer klienten
-- byggdes med (företagets förval), inte det nummer resolvern valt för listan,
-- kampanjen eller teamet (FAILURE-0103).
--
-- ICE:n får nu ett besked ur försöksraden:
-- - `connect`: sant bara för ett öppet, obesvarat försök från samma säljare
--   (`user`) till samma nummer (`to.endpoint`).
-- - `destination`: numret som reserverades.
-- - `callerId`: numret resolvern valde och som står på samtalet.
-- En ICE som levereras igen (Sinch gör om leveransen utan kvittering) får samma
-- besked i stället för `matched:false`, annars hade omleveransen lagt på ett
-- samtal som redan fått klartecken.
do $migration$
declare
  v_definition text;
  v_duplicate constant text := $a$    return jsonb_build_object('duplicate', true, 'matched', false);$a$;
  v_final constant text := $a$  return jsonb_build_object('duplicate', false, 'matched', true, 'event', p_event);$a$;
begin
  select pg_get_functiondef('public.ingest_sinch_voice_event(text,text,text,jsonb,timestamptz)'::regprocedure)
    into v_definition;
  if position('ice_connects_only_reserved_calls' in v_definition) > 0 then return; end if;
  if position(v_duplicate in v_definition) = 0 then raise exception 'ingest_sinch_voice_event_duplicate_anchor_missing'; end if;
  if position(v_final in v_definition) = 0 then raise exception 'ingest_sinch_voice_event_final_anchor_missing'; end if;

  v_definition := replace(v_definition, v_duplicate, $r$    -- ice_connects_only_reserved_calls: en omlevererad ICE får samma besked.
    if p_event = 'ice' then
      return coalesce((
        select jsonb_build_object('duplicate', true, 'matched', true, 'event', 'ice',
          'connect', public.dial_attempt_holds_seat(a.status) and a.status <> 'matched'
            and a.seller_user_id::text = p_payload->>'user'
            and a.destination_number_e164 = p_payload#>>'{to,endpoint}',
          'destination', a.destination_number_e164,
          'callerId', a.source_number_e164)
        from public.dial_attempts a
        where a.provider = 'sinch' and a.external_call_id = p_external_call_id
        limit 1
      ), jsonb_build_object('duplicate', true, 'matched', false, 'event', 'ice', 'connect', false));
    end if;
$r$ || v_duplicate);

  v_definition := replace(v_definition, v_final, $r$  if p_event = 'ice' then
    return (
      select jsonb_build_object('duplicate', false, 'matched', true, 'event', 'ice',
        'connect', public.dial_attempt_holds_seat(a.status) and a.status <> 'matched'
          and a.seller_user_id::text = p_payload->>'user'
          and a.destination_number_e164 = p_payload#>>'{to,endpoint}',
        'destination', a.destination_number_e164,
        'callerId', a.source_number_e164)
      from public.dial_attempts a
      where a.id = v_attempt.id
    );
  end if;
$r$ || v_final);

  execute v_definition;
end
$migration$;

commit;
