begin;

-- Ett oklart SMS-svar är en händelse för säljaren, inte kundens besked.
--
-- Ett svar som inte var "JA <kod>" eller "NEJ <kod>" sparades som ett godkännande
-- med status `manual_review_required`, och begäran fick samma status
-- (FAILURE-0120). Godkännanden är unika per begäran, så ett riktigt "JA 1234"
-- efteråt returnerade bara den gamla raden och avgjorde ingenting. Begäran var
-- inte längre `pending`, så acceptsidan nekade, påminnelserna fortsatte och
-- utgångssvepet, som bara ser `pending`, gick aldrig ut på avtalet. Det stod som
-- "Väntar på svar" för alltid, och ingen såg varför.
--
-- Nu skrivs svaret som händelsen `contract.reply_needs_review` på avtalet, med
-- texten, och begäran står kvar öppen. Funktionen returnerar NULL i det fallet.
do $migration$
declare
  v_definition text;
  v_anchor constant text := $a$  if p_status not in ('accepted_via_sms','accepted_via_web','declined','manual_review_required') then raise exception 'invalid_acceptance_decision'; end if;$a$;
begin
  select pg_get_functiondef('public.record_contract_acceptance_v3(uuid,public.acceptance_method,public.acceptance_status,text,text,text,text,inet,text,text,text,jsonb)'::regprocedure)
    into v_definition;
  if position('unclear_reply_is_an_event' in v_definition) > 0 then return; end if;
  if position(v_anchor in v_definition) = 0 then raise exception 'record_contract_acceptance_v3_anchor_missing'; end if;
  execute replace(v_definition, v_anchor, v_anchor || $r$
  -- unclear_reply_is_an_event
  if p_status = 'manual_review_required' then
    select * into v_request from public.contract_acceptance_requests where id = p_request_id;
    if not found then raise exception 'acceptance_request_not_found'; end if;
    insert into public.contract_events(tenant_id, contract_id, event_type, payload)
    values(v_request.tenant_id, v_request.contract_id, 'contract.reply_needs_review', jsonb_build_object(
      'request_id', v_request.id, 'method', p_method, 'raw_response', left(coalesce(p_raw_response, ''), 500),
      'provider_message_id', p_provider_message_id, 'evidence', coalesce(p_evidence, '{}'::jsonb)));
    return null;
  end if;$r$);
end
$migration$;

commit;
