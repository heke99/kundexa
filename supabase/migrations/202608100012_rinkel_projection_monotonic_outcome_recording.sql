begin;

-- Preserve terminal Rinkel projection evidence across late/out-of-order provider
-- lifecycle events. Later webhook hardening migrations replaced the original
-- monotonic trigger and accidentally stopped protecting provider_outcome and
-- recording_status. A late callStart must never erase a known terminal outcome
-- or downgrade an already-discovered recording.
create or replace function public.protect_rinkel_call_projection()
returns trigger
language plpgsql
set search_path=''
as $$
begin
  if old.provider<>'rinkel' or new.provider<>'rinkel' then
    return new;
  end if;

  -- Recording discovery is monotonic. Once Rinkel has exposed or Kundexa has
  -- copied/stored a recording, a later lifecycle event without recording data
  -- must not move it back to a non-available state.
  if old.recording_status in ('available_at_provider','copy_pending','stored_privately')
    and new.recording_status in ('not_expected','pending','unavailable') then
    new.recording_status:=old.recording_status;
  end if;

  -- A known provider outcome is evidence. Do not let a provider event that omits
  -- outcome information erase it. A later non-null provider result may still
  -- enrich/correct the projection.
  if old.provider_outcome is not null and new.provider_outcome is null then
    new.provider_outcome:=old.provider_outcome;
  end if;

  -- Terminal CRM/provider projection may be enriched, but a lower lifecycle
  -- state must not reopen or partially erase it.
  if public.call_status_rank(old.status)=100 and new.status<>old.status then
    new.status:=old.status;
    new.answered_at:=old.answered_at;
    new.ended_at:=old.ended_at;
    new.duration_seconds:=old.duration_seconds;
    new.end_cause:=old.end_cause;
    new.provider_status:=old.provider_status;
    new.provider_outcome:=old.provider_outcome;
    new.provider_cause:=old.provider_cause;
    new.provider_state_updated_at:=old.provider_state_updated_at;
    return new;
  end if;

  -- Reject lifecycle regression and stale provider-time regression. Recovery
  -- marker states intentionally do not participate in timestamp ordering because
  -- their timestamps are local uncertainty markers rather than Rinkel event time.
  if public.call_status_rank(new.status) < public.call_status_rank(old.status)
    or (
      old.status not in ('provider_outcome_unknown','reconciliation_required')
      and old.provider_state_updated_at is not null
      and new.provider_state_updated_at is not null
      and new.provider_state_updated_at < old.provider_state_updated_at
    ) then
    new.status:=old.status;
    new.answered_at:=old.answered_at;
    new.ended_at:=old.ended_at;
    new.duration_seconds:=old.duration_seconds;
    new.end_cause:=old.end_cause;
    new.provider_status:=old.provider_status;
    new.provider_outcome:=old.provider_outcome;
    new.provider_cause:=old.provider_cause;
    new.provider_state_updated_at:=old.provider_state_updated_at;
  end if;

  return new;
end
$$;

commit;
