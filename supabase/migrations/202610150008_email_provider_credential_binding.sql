begin;

-- Resend's idempotency scope belongs to the account behind the credential.
-- Preserve a one-way fingerprint with the frozen request. A credential change
-- cannot safely establish that the old and new keys belong to the same account.
create function public.prepare_email_submission(
  p_tenant_id uuid,p_message_id uuid,p_job_id uuid,p_worker text,p_payload jsonb,p_credential_fingerprint text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_job public.outbox_jobs%rowtype;
  v_email public.email_messages%rowtype;
  v_fingerprint text;
begin
  if p_credential_fingerprint is null or p_credential_fingerprint !~ '^[a-f0-9]{64}$' then
    raise exception 'email_provider_credential_fingerprint_required';
  end if;
  select * into v_job from public.outbox_jobs where tenant_id=p_tenant_id and id=p_job_id
    and aggregate_id=p_message_id and job_type='email.send' and status='processing'
    and locked_by=p_worker and locked_at>=now()-interval '5 minutes' for update;
  if not found then raise exception 'outbox_lease_lost'; end if;
  select * into v_email from public.email_messages where tenant_id=p_tenant_id and id=p_message_id and provider_message_id is null for update;
  if not found then raise exception 'email_message_not_found_or_already_submitted'; end if;
  v_fingerprint:=v_job.payload#>>'{submission,credential_fingerprint}';
  if v_fingerprint is not null then
    if v_fingerprint is distinct from p_credential_fingerprint then
      raise exception 'email_provider_credentials_changed_requires_reconciliation';
    end if;
  elsif v_job.payload ? 'submission' or v_email.status not in ('draft','queued') then
    -- Older workers may already have contacted a provider without recording an
    -- account binding. Never bless that unknown attempt with today's key.
    raise exception 'email_provider_credentials_unknown_requires_reconciliation';
  end if;
  if (v_job.payload#>>'{submission,started_at}')::timestamptz<now()-interval '23 hours' then
    raise exception 'email_submission_requires_provider_reconciliation';
  end if;
  p_payload:=coalesce(v_job.payload#>'{submission,provider_request}',p_payload);
  update public.outbox_jobs set payload=payload||jsonb_build_object('submission',jsonb_build_object(
    'started_at',coalesce(payload#>>'{submission,started_at}',now()::text),
    'provider_request',p_payload,'credential_fingerprint',p_credential_fingerprint)) where id=p_job_id;
  update public.email_messages set status='submitting',provider_status='submitting' where tenant_id=p_tenant_id and id=p_message_id;
  return p_payload;
end $$;
revoke all on function public.prepare_email_submission(uuid,uuid,uuid,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.prepare_email_submission(uuid,uuid,uuid,text,jsonb,text) to service_role;

-- Fail closed during a rolling worker deployment: the previous signature cannot
-- authorize a send because it supplies no credential/account binding.
create or replace function public.prepare_email_submission(
  p_tenant_id uuid,p_message_id uuid,p_job_id uuid,p_worker text,p_payload jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
begin
  raise exception 'email_provider_credential_fingerprint_required';
end $$;
revoke all on function public.prepare_email_submission(uuid,uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.prepare_email_submission(uuid,uuid,uuid,text,jsonb) to service_role;
commit;
