begin;

-- Efterarbete efter ett obesvarat samtal från webbtelefonen gick inte att spara.
--
-- Webbtelefonens avslut sätter `unanswered`. `complete_manual_call_work_v2`
-- försöker normalisera det till `no_answer` innan den inre funktionen anropas,
-- men `calls_projection_monotonic` skyddar ett avslutat samtal mot statusbyte
-- och återställer tyst till `unanswered`. Den inre funktionen godtog bara
-- ('completed','busy','no_answer','failed','cancelled') och svarade
-- `call_not_finished` på ett samtal som var avslutat. Säljaren kunde aldrig
-- registrera utfallet, och nästa samtal hindrades av ett öppet efterarbete.
--
-- Rättelsen är samma regel som listdialerns efterarbete redan använder:
-- avslutat är det `is_terminal_call_status` säger.
--
-- Samma för utgående webhooks: `call.completed` skickades inte för
-- `unanswered`, `voicemail`, `blocked` eller `outside_business_hours`.
do $migration$
declare
  v_definition text;
  v_anchor constant text := $a$if v_call.status not in ('completed','busy','no_answer','failed','cancelled') or v_call.ended_at is null then raise exception 'call_not_finished'; end if;$a$;
begin
  select pg_get_functiondef('public.complete_manual_call_work(uuid,text,text,text,timestamptz)'::regprocedure)
    into v_definition;
  if position(v_anchor in v_definition) = 0 then
    if position('public.is_terminal_call_status(v_call.status)' in v_definition) > 0 then return; end if;
    raise exception 'complete_manual_call_work_status_anchor_missing';
  end if;
  execute replace(v_definition, v_anchor,
    $r$if not public.is_terminal_call_status(v_call.status) or v_call.ended_at is null then raise exception 'call_not_finished'; end if;$r$);
end
$migration$;

do $migration$
declare
  v_definition text;
  v_anchor constant text := $a$when new.status in ('completed','busy','no_answer','failed','cancelled') then 'call.completed'$a$;
begin
  select pg_get_functiondef('public.emit_call_webhook_event()'::regprocedure) into v_definition;
  if position(v_anchor in v_definition) = 0 then
    if position('public.is_terminal_call_status(new.status) then' in v_definition) > 0 then return; end if;
    raise exception 'emit_call_webhook_event_status_anchor_missing';
  end if;
  execute replace(v_definition, v_anchor,
    $r$when public.is_terminal_call_status(new.status) then 'call.completed'$r$);
end
$migration$;

commit;
