begin;

-- The worker identity is unique for each invocation. Reclaimed submissions retain
-- their message identity so the worker reconciles rather than inventing a send.
create or replace function public.claim_outbox_jobs(p_worker text,p_limit integer default 25)
returns setof public.outbox_jobs language plpgsql security definer set search_path=public as $$
begin
  if nullif(btrim(p_worker),'') is null then raise exception 'worker_required'; end if;
  update public.outbox_jobs set status='dead_letter',last_error='outbox_attempts_exhausted',locked_at=null,locked_by=null
    where attempts>=max_attempts and status in ('pending','failed');
  return query with picked as (
    select id from public.outbox_jobs where
      (status in ('pending','failed') and attempts<max_attempts and available_at<=now())
      or (status='processing' and coalesce(locked_at,created_at)<now()-interval '5 minutes')
    order by priority,created_at for update skip locked limit greatest(1,least(p_limit,100))
  ) update public.outbox_jobs j set status='processing',locked_at=now(),locked_by=p_worker,attempts=j.attempts+1
    from picked where j.id=picked.id returning j.*;
end $$;

create function public.renew_outbox_lease(p_job_id uuid,p_worker text)
returns void language plpgsql security definer set search_path=public as $$
begin
  update public.outbox_jobs set locked_at=now() where id=p_job_id and status='processing'
    and locked_by=p_worker and locked_at>=now()-interval '5 minutes';
  if not found then raise exception 'outbox_lease_lost'; end if;
end $$;

create function public.finish_outbox_job(p_job_id uuid,p_worker text,p_outcome text,p_error text default null,p_delay_seconds integer default 60)
returns void language plpgsql security definer set search_path=public as $$
begin
  if p_outcome not in ('completed','failed','dead_letter') then raise exception 'invalid_outbox_outcome'; end if;
  update public.outbox_jobs set
    status=(case when p_outcome='failed' and attempts>=max_attempts then 'dead_letter' else p_outcome end)::public.job_status,
    completed_at=case when p_outcome='completed' then now() else null end,
    last_error=left(p_error,4000),available_at=now()+make_interval(secs=>greatest(1,p_delay_seconds)),locked_at=null,locked_by=null
  where id=p_job_id and status='processing' and locked_by=p_worker and locked_at>=now()-interval '5 minutes';
  if not found then raise exception 'outbox_lease_lost'; end if;
end $$;
revoke execute on function public.complete_outbox_job(uuid),public.fail_outbox_job(uuid,text,integer),public.dead_letter_outbox_job(uuid,text) from service_role;
revoke all on function public.renew_outbox_lease(uuid,text),public.finish_outbox_job(uuid,text,text,text,integer) from public,anon,authenticated;
grant execute on function public.renew_outbox_lease(uuid,text),public.finish_outbox_job(uuid,text,text,text,integer) to service_role;

-- Freeze parties alongside the canonical PDF. Historical locked documents are
-- deliberately not backfilled from today's mutable customer/company records.
create function private.capture_canonical_document_parties()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_seller jsonb; v_customer jsonb;
begin
  if new.metadata @> '{"canonical":true}'::jsonb then
    select c.seller_snapshot,c.counterparty_snapshot into v_seller,v_customer
      from public.contracts c where c.tenant_id=new.tenant_id and c.id=new.contract_id;
    if new.metadata ? 'locked_parties' and new.metadata->'locked_parties' is distinct from jsonb_build_object('seller',v_seller,'counterparty',v_customer) then
      raise exception 'canonical_document_parties_changed_during_generation';
    end if;
    new.metadata:=new.metadata||jsonb_build_object('locked_parties',jsonb_build_object('seller',v_seller,'counterparty',v_customer));
  end if;
  return new;
end $$;
create trigger capture_canonical_document_parties before insert on public.contract_documents for each row execute function private.capture_canonical_document_parties();
revoke all on function private.capture_canonical_document_parties() from public,anon,authenticated;

create function private.protect_frozen_contract_artifact()
returns trigger language plpgsql set search_path=public as $$
begin
  if old.metadata @> '{"canonical":true}'::jsonb or old.metadata @> '{"immutable":true}'::jsonb then
    if tg_op='DELETE' then raise exception 'frozen_contract_artifact_immutable'; end if;
    if row(new.tenant_id,new.contract_id,new.contract_version_id,new.document_type,new.file_name,new.storage_path,new.mime_type,new.size_bytes,new.sha256,new.metadata)
      is distinct from row(old.tenant_id,old.contract_id,old.contract_version_id,old.document_type,old.file_name,old.storage_path,old.mime_type,old.size_bytes,old.sha256,old.metadata) then
      raise exception 'frozen_contract_artifact_immutable';
    end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
create trigger protect_frozen_contract_artifact before update or delete on public.contract_documents for each row execute function private.protect_frozen_contract_artifact();
revoke all on function private.protect_frozen_contract_artifact() from public,anon,authenticated;

create function public.freeze_outbox_artifact(p_job_id uuid,p_worker text,p_artifact jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
begin
  update public.outbox_jobs set payload=payload||jsonb_build_object('frozen_artifact',coalesce(payload->'frozen_artifact',p_artifact))
    where id=p_job_id and job_type='evidence.generate' and status='processing' and locked_by=p_worker and locked_at>=now()-interval '5 minutes'
    returning payload->'frozen_artifact' into p_artifact;
  if not found then raise exception 'outbox_lease_lost'; end if;
  return p_artifact;
end $$;
revoke all on function public.freeze_outbox_artifact(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.freeze_outbox_artifact(uuid,text,jsonb) to service_role;

create function public.replay_unmatched_resend_events(p_limit integer default 100)
returns integer language plpgsql security definer set search_path=public as $$
declare e record; m record; v_status text; v_count integer:=0;
begin
  for e in select event.* from public.provider_webhook_events event where event.provider='resend' and event.status in ('unmatched','failed','received')
    and exists(select 1 from public.email_messages message where message.provider_message_id=coalesce(event.payload#>>'{data,email_id}',event.payload#>>'{data,id}'))
    order by event.received_at for update of event skip locked limit greatest(1,least(p_limit,500))
  loop
    select id,tenant_id into strict m from public.email_messages where provider_message_id=coalesce(e.payload#>>'{data,email_id}',e.payload#>>'{data,id}');
    if not found then continue; end if;
    v_status:=case e.event_type when 'email.sent' then 'sent' when 'email.delivered' then 'delivered' when 'email.opened' then 'opened'
      when 'email.clicked' then 'clicked' when 'email.delivery_delayed' then 'delayed' when 'email.bounced' then 'bounced'
      when 'email.complained' then 'complained' when 'email.failed' then 'failed' when 'email.suppressed' then 'suppressed' end;
    if v_status is null then continue; end if;
    -- Shared platform Resend account: the message determines tenant ownership.
    update public.provider_webhook_events set tenant_id=m.tenant_id where id=e.id;
    perform public.apply_resend_delivery_event(m.tenant_id,m.id,e.provider_event_id,e.event_type,v_status,
      coalesce((e.payload->>'created_at')::timestamptz,e.received_at),e.payload,
      coalesce(e.payload#>>'{data,bounce,message}',e.payload#>>'{data,reason}',e.event_type));
    v_count:=v_count+1;
  end loop;
  return v_count;
end $$;

-- Freeze the exact provider request before contacting Resend. Retry is allowed
-- only inside its documented idempotency retention window.
create function public.prepare_email_submission(p_tenant_id uuid,p_message_id uuid,p_job_id uuid,p_worker text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_job public.outbox_jobs%rowtype;
begin
  select * into v_job from public.outbox_jobs where tenant_id=p_tenant_id and id=p_job_id
    and aggregate_id=p_message_id and job_type='email.send' and status='processing'
    and locked_by=p_worker and locked_at>=now()-interval '5 minutes' for update;
  if not found then raise exception 'outbox_lease_lost'; end if;
  perform 1 from public.email_messages where tenant_id=p_tenant_id and id=p_message_id and provider_message_id is null for update;
  if not found then raise exception 'email_message_not_found_or_already_submitted'; end if;
  if (v_job.payload#>>'{submission,started_at}')::timestamptz<now()-interval '23 hours' then raise exception 'email_submission_requires_provider_reconciliation'; end if;
  p_payload:=coalesce(v_job.payload#>'{submission,provider_request}',p_payload);
  update public.outbox_jobs set payload=payload||jsonb_build_object('submission',jsonb_build_object(
    'started_at',coalesce(payload#>>'{submission,started_at}',now()::text),'provider_request',p_payload)) where id=p_job_id;
  update public.email_messages set status='submitting',provider_status='submitting' where tenant_id=p_tenant_id and id=p_message_id;
  return p_payload;
end $$;
revoke all on function public.prepare_email_submission(uuid,uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.prepare_email_submission(uuid,uuid,uuid,text,jsonb) to service_role;

-- Repair local projections after provider acceptance without another send.
create function public.repair_outbound_delivery(p_tenant_id uuid,p_message_id uuid,p_channel text)
returns void language plpgsql security definer set search_path=public as $$
declare v_status public.delivery_status; v_sent timestamptz; v_delivered timestamptz; v_provider_status text;
begin
  if p_channel='sms' then
    select status::text::public.delivery_status,sent_at,delivered_at into v_status,v_sent,v_delivered
      from public.sms_messages where tenant_id=p_tenant_id and id=p_message_id and provider_message_id is not null for update;
  elsif p_channel='email' then
    select status,sent_at,delivered_at into v_status,v_sent,v_delivered
      from public.email_messages where tenant_id=p_tenant_id and id=p_message_id and provider_message_id is not null for update;
  else raise exception 'invalid_delivery_channel'; end if;
  if not found then raise exception 'accepted_message_not_found'; end if;
  if v_status='submitting' then v_status:='sent'; end if;
  update public.contract_deliveries set status=v_status,provider_status='reconciled_'||v_status::text,
    sent_at=coalesce(sent_at,v_sent),delivered_at=coalesce(delivered_at,v_delivered)
    where tenant_id=p_tenant_id and ((p_channel='sms' and sms_message_id=p_message_id) or (p_channel='email' and email_message_id=p_message_id))
      and public.delivery_status_rank(status::text)<=public.delivery_status_rank(v_status::text);
  if p_channel='email' then
    update public.email_messages set status=v_status where tenant_id=p_tenant_id and id=p_message_id and status='submitting';
  end if;
  update public.contract_reminders set status=case when v_status in ('failed','bounced','complained','suppressed','cancelled','dead_letter') then 'failed' else 'sent' end,
    sent_at=case when v_status in ('sent','delivered','opened','clicked') then coalesce(sent_at,v_sent) else sent_at end
    where tenant_id=p_tenant_id and status in ('queued','scheduled') and v_status not in ('created','queued','submitting')
    and ((p_channel='sms' and sms_message_id=p_message_id) or (p_channel='email' and email_message_id=p_message_id));
  if p_channel='email' then perform public.replay_unmatched_resend_events(100); end if;
end $$;
-- Persist provider identity and its result atomically, preserving an earlier
-- terminal callback. A retry can then repair projection without another send.
create function public.record_sms_submission(p_tenant_id uuid,p_message_id uuid,p_provider_message_id text,p_status text,p_sent_at timestamptz,p_delivered_at timestamptz default null,p_parts integer default null,p_cost numeric default null)
returns void language plpgsql security definer set search_path=public as $$
begin
  if nullif(p_provider_message_id,'') is null or p_status not in ('created','sent','delivered','failed') then raise exception 'invalid_sms_submission'; end if;
  update public.sms_messages set provider_message_id=p_provider_message_id,
    status=case when public.delivery_status_rank(status::text)<=public.delivery_status_rank(p_status) then p_status::public.delivery_status else status end,
    sent_at=coalesce(sent_at,p_sent_at),delivered_at=coalesce(delivered_at,p_delivered_at),parts=coalesce(p_parts,parts),cost=coalesce(p_cost,cost)
    where tenant_id=p_tenant_id and id=p_message_id and (provider_message_id is null or provider_message_id=p_provider_message_id);
  if not found then raise exception 'sms_submission_binding_mismatch'; end if;
  perform public.repair_outbound_delivery(p_tenant_id,p_message_id,'sms');
end $$;
revoke all on function public.record_sms_submission(uuid,uuid,text,text,timestamptz,timestamptz,integer,numeric) from public,anon,authenticated;
grant execute on function public.record_sms_submission(uuid,uuid,text,text,timestamptz,timestamptz,integer,numeric) to service_role;

revoke all on function public.repair_outbound_delivery(uuid,uuid,text),public.replay_unmatched_resend_events(integer) from public,anon,authenticated;
grant execute on function public.repair_outbound_delivery(uuid,uuid,text),public.replay_unmatched_resend_events(integer) to service_role;
commit;
