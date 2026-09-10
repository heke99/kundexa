begin;

-- Two defects found by executing the dial path the application actually calls
-- (`rinkel_reserve_platform_outbound_call_v2`) against the full migration chain. The
-- runtime suite only ever exercised the v1 reservation, so neither surfaced.
--
-- FAILURE-0045: a single failed job switches the auto-dialer off for every tenant.
-- FAILURE-0046: one call whose outcome the provider never reports locks that seller out
--               of telephony permanently.

-- ---------------------------------------------------------------------------
-- FAILURE-0045 — worker liveness must mean "the run completed", not "no job failed"
-- ---------------------------------------------------------------------------
-- `telephony_status_for_current_user` and the reservation's automatic-dialer gate both
-- require `last_success_at > now() - interval '3 minutes'` for `rinkel-platform-worker`.
-- `record_platform_worker_heartbeat` refreshed `last_success_at` only for status
-- `healthy`, and the worker reports `degraded` whenever *any* claimed job fails. A single
-- job that keeps failing — a reconciliation whose CDR is not available yet is the normal
-- case, and it is requeued with backoff — therefore lets `last_success_at` go stale and
-- silently disables automatic dialing platform-wide while the worker is running perfectly
-- well.
--
-- `degraded` means the run completed with per-job failures that carry their own retry and
-- dead-letter handling; that is a live worker. Only `running` (no result yet) and `failed`
-- (the run itself could not complete) leave liveness unproven. The reported status is
-- unchanged, so operators still see `degraded` and its counters — this only stops a normal
-- job failure from reading as "the worker is gone".
create or replace function public.record_platform_worker_heartbeat(
  p_worker_key text,
  p_worker_id text,
  p_status text,
  p_started_at timestamptz,
  p_finished_at timestamptz,
  p_fetched_count integer,
  p_processed_count integer,
  p_failed_count integer,
  p_requeued_count integer,
  p_error_code text default null,
  p_error_message text default null,
  p_metadata jsonb default '{}'::jsonb
) returns void
language plpgsql
security definer
set search_path=public
as $$
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then raise exception 'service_role_required'; end if;
  insert into public.platform_worker_heartbeats(
    worker_key,worker_id,status,started_at,finished_at,last_success_at,
    fetched_count,processed_count,failed_count,requeued_count,
    last_error_code,last_error_message,metadata,updated_at
  ) values(
    p_worker_key,left(p_worker_id,200),p_status,p_started_at,p_finished_at,
    case when p_status in ('healthy','degraded') then p_finished_at else null end,
    greatest(coalesce(p_fetched_count,0),0),greatest(coalesce(p_processed_count,0),0),
    greatest(coalesce(p_failed_count,0),0),greatest(coalesce(p_requeued_count,0),0),
    left(p_error_code,100),left(p_error_message,500),coalesce(p_metadata,'{}'::jsonb),now()
  )
  on conflict(worker_key) do update set
    worker_id=excluded.worker_id,status=excluded.status,started_at=excluded.started_at,
    finished_at=excluded.finished_at,
    last_success_at=coalesce(excluded.last_success_at,public.platform_worker_heartbeats.last_success_at),
    fetched_count=excluded.fetched_count,processed_count=excluded.processed_count,
    failed_count=excluded.failed_count,requeued_count=excluded.requeued_count,
    last_error_code=excluded.last_error_code,last_error_message=excluded.last_error_message,
    metadata=excluded.metadata,updated_at=now();
end $$;
revoke all on function public.record_platform_worker_heartbeat(text,text,text,timestamptz,timestamptz,integer,integer,integer,integer,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.record_platform_worker_heartbeat(text,text,text,timestamptz,timestamptz,integer,integer,integer,integer,text,text,jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- FAILURE-0046 — the one-active-call lock had no way out
-- ---------------------------------------------------------------------------
-- A seller may hold exactly one non-terminal dial attempt: `rinkel_reserve_platform_-
-- outbound_call_v2` refuses a second one, and `rinkel_call_attempts_v2_active_seller_uidx`
-- / `..._active_device_uidx` enforce it at storage level. Nothing ever left that state
-- when the provider went silent. The worker moves a hanging attempt to
-- `reconciliation_required` after 15 minutes, which is itself one of the blocking
-- statuses, and a CDR that never appears makes the reconciliation job fail until it
-- dead-letters. The seller was then locked out of telephony with no automatic release and
-- no operator action to release it — and, because the storage-level guard raises a unique
-- violation rather than the reservation's own error, with an opaque failure message.
--
-- Give up waiting on a bound instead of waiting forever. This terminalizes the *attempt*
-- only: "Kundexa stopped waiting for a provider outcome" is a true statement about the
-- dial request. The `calls` row keeps `reconciliation_required` and
-- `provider_outcome='unknown'`, so no call outcome is invented, the call stays visible as
-- unresolved, and CDR repair keeps running — the worker also enqueues reconciliation from
-- the calls side, and `reconcile_rinkel_call_from_cdr` still projects a late CDR onto the
-- attempt if one turns up.
--
-- Only statuses where the provider signal is already known to be lost are released, never
-- one that could still be a live call: `awaiting_provider_event` and `matched` are left to
-- the existing 15-minute stale sweep, which moves them into scope on its own.
create or replace function public.rinkel_release_stale_call_attempts(
  p_max_age interval default interval '1 hour',
  p_limit integer default 200
) returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_released record;
  v_count integer:=0;
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then raise exception 'service_role_required'; end if;
  if p_max_age < interval '15 minutes' then raise exception 'stale_attempt_bound_too_short'; end if;

  for v_released in
    update public.rinkel_call_attempts_v2 a
    set status='failed',
        error_code='PROVIDER_OUTCOME_NEVER_REPORTED',
        error_message=left(format(
          'No provider event or CDR arrived within %s; the dial attempt was released so the seller can call again. The call itself stays unresolved.',
          p_max_age::text
        ),500),
        updated_at=now()
    where a.id in (
      select candidate.id
      from public.rinkel_call_attempts_v2 candidate
      where candidate.status in ('provider_outcome_unknown','reconciliation_required')
        and candidate.requested_at <= now() - p_max_age
      order by candidate.requested_at
      limit greatest(coalesce(p_limit,200),1)
      for update skip locked
    )
    returning a.id,a.tenant_id,a.call_id,a.seller_user_id,a.external_call_id
  loop
    v_count:=v_count+1;
    insert into public.call_events(tenant_id,call_id,event_type,payload)
    values(v_released.tenant_id,v_released.call_id,'dial_attempt.released_unresolved',jsonb_build_object(
      'attempt_id',v_released.id,
      'external_call_id',v_released.external_call_id,
      'reason','PROVIDER_OUTCOME_NEVER_REPORTED',
      'max_age',p_max_age::text
    ));
    insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
    values(v_released.tenant_id,null,'rinkel.dial_attempt_released','call',v_released.call_id::text,jsonb_build_object(
      'attempt_id',v_released.id,
      'seller_user_id',v_released.seller_user_id,
      'reason','PROVIDER_OUTCOME_NEVER_REPORTED',
      'call_outcome','unresolved'
    ));
  end loop;

  return jsonb_build_object('released',v_count,'maxAge',p_max_age::text);
end $$;
revoke all on function public.rinkel_release_stale_call_attempts(interval,integer) from public,anon,authenticated;
grant execute on function public.rinkel_release_stale_call_attempts(interval,integer) to service_role;

-- The release scans by status and age on every reconciliation pass.
create index if not exists rinkel_call_attempts_v2_unresolved_age_idx
  on public.rinkel_call_attempts_v2(requested_at)
  where status in ('provider_outcome_unknown','reconciliation_required');

commit;
