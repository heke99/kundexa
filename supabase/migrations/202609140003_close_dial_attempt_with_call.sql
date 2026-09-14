-- One finished call permanently bricked the dialer for that seller.
--
-- `rinkel_reserve_platform_outbound_call_v2` refuses a new call while the seller
-- has an attempt in any of six statuses:
--
--   requested, dial_requested, awaiting_provider_event,
--   matched, provider_outcome_unknown, reconciliation_required
--
-- but `rinkel_release_stale_call_attempts` only ever releases two of them:
--
--   provider_outcome_unknown, reconciliation_required
--
-- `matched` is the status a *successfully* matched dial lands in, and nothing
-- moved it on when the call ended. Measured in production: a call placed on
-- 2026-09-11 ended `unanswered` at 14:59:59, its attempt stayed `matched`, and
-- three days later the seller still could not dial — "Säljaren eller den valda
-- enheten har redan ett aktivt samtal".
--
-- The fix belongs where the call ends, not in a sweeper: an attempt is only
-- meaningful while its call is live, so when the call reaches a terminal status
-- the attempt is closed with it, whichever code path got the call there.

create or replace function public.close_dial_attempt_with_call()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status is not distinct from old.status then return new; end if;
  if new.status not in ('completed','unanswered','failed','blocked','voicemail','cancelled','outside_business_hours') then
    return new;
  end if;

  update public.rinkel_call_attempts_v2 a
  set status = case when new.status = 'failed' then 'failed' else 'completed' end,
      error_code = coalesce(a.error_code, 'ATTEMPT_CLOSED_WITH_CALL'),
      updated_at = now()
  where a.call_id = new.id
    and a.tenant_id = new.tenant_id
    and a.status in ('requested','dial_requested','awaiting_provider_event',
                     'matched','provider_outcome_unknown','reconciliation_required');

  return new;
end $$;

drop trigger if exists close_dial_attempt_with_call on public.calls;
create trigger close_dial_attempt_with_call
  after update of status on public.calls
  for each row execute function public.close_dial_attempt_with_call();

-- Belt and braces, but only for the pre-answer states. `matched` is deliberately
-- NOT added: it means the call is connected, and a good sales call outlasts any
-- sane p_max_age — releasing it would let the seller start a second call while
-- the first is still live, which is the exact thing the reservation guard
-- exists to prevent. The suite already asserted this and caught the attempt.
-- Only `requested`, `dial_requested` and `awaiting_provider_event` are added:
-- none of them can legitimately persist, since no dial is still ringing after
-- fifteen minutes.
create or replace function public.rinkel_release_stale_call_attempts(
  p_max_age interval default '01:00:00'::interval,
  p_limit integer default 200
) returns jsonb language plpgsql security definer set search_path = 'public' as $$
declare
  v_released record;
  v_count integer := 0;
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then raise exception 'service_role_required'; end if;
  if p_max_age < interval '15 minutes' then raise exception 'stale_attempt_bound_too_short'; end if;

  for v_released in
    update public.rinkel_call_attempts_v2 a
    set status = 'failed',
        error_code = 'PROVIDER_OUTCOME_NEVER_REPORTED',
        error_message = left(format(
          'No provider event or CDR arrived within %s; the dial attempt was released so the seller can call again. The call itself stays unresolved.',
          p_max_age::text
        ), 500),
        updated_at = now()
    where a.id in (
      select candidate.id
      from public.rinkel_call_attempts_v2 candidate
      where candidate.status in (
              'provider_outcome_unknown','reconciliation_required',
              'requested','dial_requested','awaiting_provider_event')
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
    values(v_released.tenant_id, null, 'rinkel.dial_attempt_released', 'call', v_released.call_id::text, jsonb_build_object(
      'attempt_id', v_released.id,
      'seller_user_id', v_released.seller_user_id,
      'reason', 'PROVIDER_OUTCOME_NEVER_REPORTED',
      'call_outcome', 'unresolved'
    ));
  end loop;

  return jsonb_build_object('released', v_count, 'maxAge', p_max_age::text);
end $$;

revoke all on function public.close_dial_attempt_with_call() from public, anon, authenticated;

-- Close anything already stranded by the old behaviour.
update public.rinkel_call_attempts_v2 a
set status = case when c.status = 'failed' then 'failed' else 'completed' end,
    error_code = coalesce(a.error_code, 'ATTEMPT_CLOSED_WITH_CALL'),
    updated_at = now()
from public.calls c
where c.id = a.call_id
  and a.status in ('requested','dial_requested','awaiting_provider_event',
                   'matched','provider_outcome_unknown','reconciliation_required')
  and c.status in ('completed','unanswered','failed','blocked','voicemail','cancelled','outside_business_hours');
