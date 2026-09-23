begin;

-- ICE kopplas till sitt uppringningsförsök.
--
-- Sinch skickar ICE innan webbläsaren hunnit rapportera samtalets id (i
-- produktion ca en halv sekund före). Uppslaget på `external_call_id` hittade
-- därför aldrig något, varje ICE blev `unmatched`, och ett samtal som bröts
-- direkt efter ICE lämnade ingen leverantörsorsak på samtalet.
--
-- ICE bär säljarens id (`user`, samma id som registreringstoken utfärdas för)
-- och numret som ringdes. Ett öppet försök från den säljaren till det numret,
-- utan externt id och från de senaste två minuterna, är samtalet. Försöket får
-- sitt id här; klientens rapport sätter sedan samma värde (`coalesce`), och ACE
-- och DiCE hittar försöket på vanligt sätt.
--
-- Tenant tas från försöksraden, aldrig från händelsen.
do $migration$
declare
  v_definition text;
  v_anchor constant text := $a$  where a.provider = 'sinch' and a.external_call_id = p_external_call_id
  limit 1;
$a$;
begin
  select pg_get_functiondef('public.ingest_sinch_voice_event(text,text,text,jsonb,timestamptz)'::regprocedure)
    into v_definition;
  if position(v_anchor in v_definition) = 0 then
    if position('ice_matched_by_seller_and_number' in v_definition) > 0 then return; end if;
    raise exception 'ingest_sinch_voice_event_anchor_missing';
  end if;
  execute replace(v_definition, v_anchor, v_anchor || $r$
  -- ice_matched_by_seller_and_number
  if not found and p_event = 'ice' then
    select a.id, a.tenant_id, a.call_id, a.status
    into v_attempt
    from public.dial_attempts a
    where a.provider = 'sinch'
      and a.external_call_id is null
      and a.seller_user_id::text = p_payload->>'user'
      and a.destination_number_e164 = p_payload#>>'{to,endpoint}'
      and a.status in ('requested','dial_requested','awaiting_provider_event')
      and a.requested_at > p_received_at - interval '2 minutes'
    order by a.requested_at desc
    limit 1
    for update;
    if found then
      update public.dial_attempts
        set external_call_id = p_external_call_id, updated_at = now()
        where id = v_attempt.id;
    end if;
  end if;
$r$);
end
$migration$;

commit;
