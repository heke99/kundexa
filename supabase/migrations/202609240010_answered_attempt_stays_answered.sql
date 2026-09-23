begin;

-- Ett besvarat försök går inte tillbaka till "kopplas".
--
-- `finalize_dial('accepted')` skriver `dial_requested` på varje försök som
-- håller platsen, och `matched` (besvarat, satt av ACE) håller platsen. Kom
-- webbläsarens rapport efter ACE flyttades ett pågående samtal tillbaka till
-- "kopplas", och svepet för fastnade försök kunde släppa platsen för ett samtal
-- som pågick. Ett `matched` försök räknas nu som redan avgjort: samtals-id:t
-- sparas, statusen rörs inte.
do $migration$
declare
  v_definition text;
  v_anchor constant text := $a$    and public.dial_attempt_holds_seat(a.status);$a$;
begin
  select pg_get_functiondef('public.finalize_dial(uuid,uuid,text,text,text,text)'::regprocedure) into v_definition;
  if position('answered_attempt_stays_answered' in v_definition) > 0 then return; end if;
  if position(v_anchor in v_definition) = 0 then raise exception 'finalize_dial_anchor_missing'; end if;
  v_definition := replace(v_definition, v_anchor, $r$    and public.dial_attempt_holds_seat(a.status)
    and a.status <> 'matched'; -- answered_attempt_stays_answered$r$);
  -- Samtals-id:t som ICE redan satt behålls. Är webbläsarens ett annat, hade
  -- ACE och DiCE annars slutat hitta försöket.
  v_definition := replace(v_definition, $a$      external_call_id = coalesce(p_external_call_id, a.external_call_id),$a$,
    $r$      external_call_id = coalesce(a.external_call_id, p_external_call_id),$r$);
  execute v_definition;
end
$migration$;

commit;
