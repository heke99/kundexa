begin;
-- At most one worker obtains permission to create the external SMS effect.
-- A lost response is reconciled; absence from an eventually consistent search is not retry permission.
create function public.prepare_sms_submission(p_tenant_id uuid,p_message_id uuid,p_job_id uuid,p_worker text,p_attempt integer)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_job public.outbox_jobs%rowtype; v_sms public.sms_messages%rowtype; v_policy jsonb;
begin
  select * into v_job from public.outbox_jobs where tenant_id=p_tenant_id and id=p_job_id
    and aggregate_id=p_message_id and job_type='sms.send' and status='processing'
    and locked_by=p_worker and attempts=p_attempt and locked_at>=now()-interval '5 minutes' for update;
  if not found then raise exception 'outbox_lease_lost'; end if;
  select * into v_sms from public.sms_messages where tenant_id=p_tenant_id and id=p_message_id for update;
  if not found or v_sms.provider_message_id is not null or v_sms.status not in ('draft','queued') or v_job.payload ? 'sms_submission' then
    raise exception 'sms_submission_requires_reconciliation';
  end if;
  if not exists(select 1 from public.tenants where id=p_tenant_id and status in ('active','trial')) then raise exception 'tenant_inactive'; end if;
  if v_sms.customer_id is not null then
    v_policy:=public.evaluate_contact_policy_for_tenant(p_tenant_id,v_sms.customer_id,'sms',v_sms.purpose);
    if coalesce(v_policy->>'allowed','false')<>'true' then raise exception 'sms_contact_policy_blocked'; end if;
  end if;
  update public.outbox_jobs set payload=payload||jsonb_build_object('sms_submission',jsonb_build_object('started_at',now(),'attempt',p_attempt,'worker',p_worker)) where id=p_job_id;
  update public.sms_messages set status='submitting' where tenant_id=p_tenant_id and id=p_message_id;
  return jsonb_build_object('from',v_sms.from_number,'to',v_sms.to_number,'body',v_sms.body,'clientReference',v_sms.id::text);
end $$;
revoke all on function public.prepare_sms_submission(uuid,uuid,uuid,text,integer) from public,anon,authenticated;
grant execute on function public.prepare_sms_submission(uuid,uuid,uuid,text,integer) to service_role;
commit;
