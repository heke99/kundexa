-- Lägg om avslutade listposter så säljaren kan ringa dem igen.
--
-- The queue already filters worked prospects out on its own: `claim_next_list_member`
-- only ever looks at `pending`, `retry`, `callback` and `skipped`, so an entry
-- that ended as `not_interested` — state `completed` — quietly stops being
-- offered. That half works. What was missing is the way back: once a list had
-- been worked through there was nothing that could put "inte intresserad" back
-- in circulation, short of rebuilding the list by hand.
--
-- Non-terminal outcomes never needed this. `no_answer`, `busy` and `voicemail`
-- carry a `retry_after_minutes` (1440, 120 and 1440 by default) that
-- `complete_dialer_work` turns into `next_attempt_at` with state `retry`, so
-- they come back by themselves after the configured time. This is only for the
-- outcomes that deliberately ended the entry.
--
-- Two things it must never re-queue, because they are not sales outcomes:
--
--   * `do_not_call` and `nix_listed`, which set state `blocked` and also write a
--     compliance block. Putting those back in a dialling queue would call
--     someone who asked not to be called.
--   * anything whose `compliance_status` is not `allowed`.
--
-- The guard is `can_manage_customer_list`, the same authority that decides who
-- may set a list to automatic dialling — a team leader for their own team's
-- list, or a tenant admin.
create or replace function public.requeue_customer_list_members(
  p_list_id uuid,
  p_outcomes text[] default null,
  p_delay_minutes integer default 0,
  p_completed_before timestamptz default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_user uuid := auth.uid();
  v_delay integer := greatest(coalesce(p_delay_minutes, 0), 0);
  v_next timestamptz;
  v_count integer;
begin
  if v_user is null or v_tenant is null then raise exception 'authentication_required'; end if;
  if not public.can_manage_customer_list(p_list_id) then raise exception 'list_manage_permission_denied'; end if;
  if v_delay > 525600 then raise exception 'requeue_delay_out_of_range'; end if;

  -- A delay of zero means "available now", not "available at an unset time":
  -- `claim_next_list_member` treats a null `next_attempt_at` as due, but being
  -- explicit keeps the list readable to whoever looks at it next.
  v_next := now() + make_interval(mins => v_delay);

  with requeued as (
    update public.customer_list_members m
    set state = 'pending',
        next_attempt_at = v_next,
        -- The attempt counter has to go back too. Re-queueing an entry that had
        -- already reached the list's `max_attempts` without resetting it would
        -- put it straight back to `completed` on the next disposition, which
        -- looks like the re-queue silently failed.
        attempts = 0,
        completed_at = null,
        claimed_by = null,
        claim_expires_at = null,
        updated_at = now()
    where m.tenant_id = v_tenant
      and m.list_id = p_list_id
      and m.state = 'completed'
      and coalesce(m.outcome, '') not in ('do_not_call', 'nix_listed')
      and m.compliance_status = 'allowed'
      and (p_outcomes is null or m.outcome = any(p_outcomes))
      and (p_completed_before is null or m.completed_at < p_completed_before)
    returning m.id
  )
  select count(*)::integer into v_count from requeued;

  insert into public.audit_logs(tenant_id, actor_user_id, action, entity_type, entity_id, after_data)
  values (
    v_tenant, v_user, 'customer_list.members_requeued', 'customer_list', p_list_id::text,
    jsonb_build_object('outcomes', p_outcomes, 'delay_minutes', v_delay, 'requeued', v_count, 'completed_before', p_completed_before)
  );

  return v_count;
end
$$;

revoke all on function public.requeue_customer_list_members(uuid, text[], integer, timestamptz) from public, anon;
grant execute on function public.requeue_customer_list_members(uuid, text[], integer, timestamptz) to authenticated;

-- What is sitting in the worked-through pile, so the person deciding can see
-- what a re-queue would bring back before they press anything. Read-only and
-- `security invoker`, so row-level security decides what is visible.
create or replace function public.customer_list_requeue_candidates(p_list_id uuid)
returns table (outcome text, label text, outcome_group text, members integer, last_completed_at timestamptz)
language sql
stable
security invoker
set search_path = public
as $$
  select
    m.outcome,
    coalesce(d.label, m.outcome),
    coalesce(d.outcome_group, 'neutral'),
    count(*)::integer,
    max(m.completed_at)
  from public.customer_list_members m
  left join public.list_dispositions d on d.list_id = m.list_id and d.key = m.outcome
  where m.list_id = p_list_id
    and m.state = 'completed'
    and coalesce(m.outcome, '') not in ('do_not_call', 'nix_listed')
    and m.compliance_status = 'allowed'
  group by m.outcome, d.label, d.outcome_group
  order by count(*) desc, m.outcome;
$$;

revoke all on function public.customer_list_requeue_candidates(uuid) from public, anon;
grant execute on function public.customer_list_requeue_candidates(uuid) to authenticated;
