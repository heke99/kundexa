begin;

-- Upptaget är upptaget, inte "inget svar".
--
-- DiCE bär `result` (ANSWERED, BUSY, NOANSWER, FAILED) utöver `reason`, men bara
-- `reason` lästes. Ett upptaget samtal blev därför `unanswered`, och i en lista
-- fick prospektet "Inget svar" med ett dygns väntan i stället för "Upptaget" med
-- två timmar. Webbläsarens avslutsrapport kommer oftast före DiCE och säger
-- `unanswered`; leverantörens `busy` får ersätta den på samma villkor som
-- `failed` redan får (202609230003).
do $migration$
declare
  v_definition text;
  v_map constant text := $a$      when v_answered then 'completed'
$a$;
  v_where constant text := $a$or (c.status = 'unanswered' and v_call_status = 'failed' and c.answered_at is null)$a$;
begin
  select pg_get_functiondef('public.ingest_sinch_voice_event(text,text,text,jsonb,timestamptz)'::regprocedure)
    into v_definition;
  if position('dice_result_busy' in v_definition) > 0 then return; end if;
  if position(v_map in v_definition) = 0 or position(v_where in v_definition) = 0 then
    raise exception 'ingest_sinch_voice_event_busy_anchor_missing';
  end if;
  v_definition := replace(v_definition, v_map, v_map || $r$      -- dice_result_busy
      when upper(coalesce(p_payload->>'result', '')) = 'BUSY' then 'busy'
$r$);
  v_definition := replace(v_definition, v_where,
    $r$or (c.status = 'unanswered' and v_call_status in ('failed','busy') and c.answered_at is null)$r$);
  execute v_definition;
end
$migration$;

do $migration$
declare
  v_definition text;
  v_anchor constant text := $a$  if old.status='unanswered' and new.status='failed' and old.answered_at is null$a$;
begin
  select pg_get_functiondef('public.protect_call_projection()'::regprocedure) into v_definition;
  if position($a$new.status in ('failed','busy')$a$ in v_definition) > 0 then return; end if;
  if position(v_anchor in v_definition) = 0 then raise exception 'protect_call_projection_busy_anchor_missing'; end if;
  execute replace(v_definition, v_anchor,
    $r$  if old.status='unanswered' and new.status in ('failed','busy') and old.answered_at is null$r$);
end
$migration$;

commit;
