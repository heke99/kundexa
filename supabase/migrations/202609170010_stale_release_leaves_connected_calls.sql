-- Gallringen av hängande uppringningsförsök får inte röra ett uppkopplat samtal.
--
-- När funktionen porterades till den neutrala försöksmodellen blev villkoret
-- `dial_attempt_holds_seat(status)`, vilket är hela mängden statusar som håller
-- platsen -- inklusive `matched`. Men `matched` betyder att samtalet är
-- uppkopplat. Med det villkoret släpps säljarens plats mitt i ett pågående
-- samtal, och nästa uppringning startar medan den förra fortfarande låter i
-- luren.
--
-- Den ursprungliga funktionen räknade upp statusarna en och en av precis det
-- skälet. Uppräkningen är återställd: det som släpps är försök där vi väntar på
-- ett besked som aldrig kom, aldrig ett samtal som kan pågå.

create or replace function public.release_stale_dial_attempts(
  p_max_age interval default '01:00:00'::interval,
  p_limit integer default 200
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_released record;
  v_count integer := 0;
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then raise exception 'service_role_required'; end if;
  if p_max_age < interval '15 minutes' then raise exception 'stale_attempt_bound_too_short'; end if;

  for v_released in
    update public.dial_attempts a
    set status = 'failed',
        error_code = 'PROVIDER_OUTCOME_NEVER_REPORTED',
        error_message = left(format(
          'Ingen leverantörshändelse kom inom %s; uppringningsförsöket släpptes så att säljaren kan ringa igen. Samtalet självt är fortfarande oavgjort.',
          p_max_age::text
        ), 500),
        provider_request_finished_at = coalesce(a.provider_request_finished_at, now()),
        updated_at = now()
    where a.id in (
      select candidate.id
      from public.dial_attempts candidate
      -- `matched` saknas medvetet. Den statusen betyder uppkopplat samtal, och
      -- ett uppkopplat samtal är inte hängande hur länge det än pågår.
      where candidate.status in (
              'requested','dial_requested','awaiting_provider_event',
              'provider_outcome_unknown','reconciliation_required')
        and candidate.requested_at <= now() - p_max_age
      order by candidate.requested_at
      limit greatest(coalesce(p_limit,200),1)
      for update skip locked
    )
    returning a.id, a.tenant_id, a.call_id, a.seller_user_id, a.external_call_id
  loop
    v_count := v_count + 1;
    insert into public.call_events(tenant_id,call_id,event_type,payload)
    values(v_released.tenant_id, v_released.call_id, 'dial_attempt.released_unresolved', jsonb_build_object(
      'attempt_id', v_released.id,
      'external_call_id', v_released.external_call_id,
      'reason', 'PROVIDER_OUTCOME_NEVER_REPORTED',
      'max_age', p_max_age::text
    ));
    insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
    values(v_released.tenant_id, null, 'telephony.dial_attempt_released', 'call', v_released.call_id::text, jsonb_build_object(
      'attempt_id', v_released.id,
      'seller_user_id', v_released.seller_user_id,
      'reason', 'PROVIDER_OUTCOME_NEVER_REPORTED',
      'call_outcome', 'unresolved'
    ));
  end loop;

  return jsonb_build_object('released', v_count, 'maxAge', p_max_age::text);
end $$;

revoke all on function public.release_stale_dial_attempts(interval, integer) from public, anon, authenticated;
