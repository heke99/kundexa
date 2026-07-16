begin;

create or replace function public.activate_automation(p_automation_id uuid)
returns void
language plpgsql security definer set search_path=public
as $$
declare
  v_tenant_id uuid;
  v_current_version integer;
begin
  select tenant_id,current_version into v_tenant_id,v_current_version
  from public.automation_rules
  where id=p_automation_id and tenant_id=public.current_tenant_id()
  for update;

  if v_tenant_id is null then raise exception 'automation_not_found'; end if;
  if not public.has_current_role(array['owner','admin']) then raise exception 'permission_denied'; end if;
  if not exists(
    select 1 from public.automation_versions
    where tenant_id=v_tenant_id and automation_id=p_automation_id and version=v_current_version
      and jsonb_typeof(actions)='array' and jsonb_array_length(actions)>0
  ) then raise exception 'automation_version_invalid'; end if;

  update public.automation_versions
  set test_mode=false,approved_by=auth.uid()
  where tenant_id=v_tenant_id and automation_id=p_automation_id and version=v_current_version;

  update public.automation_rules
  set status='active',updated_at=now()
  where tenant_id=v_tenant_id and id=p_automation_id;
end
$$;
revoke all on function public.activate_automation(uuid) from public,anon;
grant execute on function public.activate_automation(uuid) to authenticated;

create or replace function public.enqueue_outgoing_webhook_event(
  p_tenant_id uuid,
  p_event_type text,
  p_event_id text,
  p_payload jsonb default '{}'::jsonb
)
returns integer
language plpgsql security definer set search_path=public
as $$
declare v_count integer;
begin
  with created as (
    insert into public.webhook_deliveries(tenant_id,endpoint_id,event_type,event_id,payload,status,next_attempt_at)
    select p_tenant_id,e.id,p_event_type,p_event_id,coalesce(p_payload,'{}'::jsonb),'pending',now()
    from public.webhook_endpoints e
    where e.tenant_id=p_tenant_id and e.active and p_event_type=any(e.subscribed_events)
    on conflict(tenant_id,endpoint_id,event_id) do nothing
    returning id,tenant_id,event_type,event_id
  ), queued as (
    insert into public.outbox_jobs(tenant_id,job_type,aggregate_type,aggregate_id,payload,status,available_at,priority,idempotency_key)
    select tenant_id,'webhook.deliver','webhook_delivery',id,
      jsonb_build_object('event_type',event_type,'event_id',event_id),'pending',now(),50,'webhook.deliver:'||id::text
    from created
    on conflict(tenant_id,idempotency_key) do nothing
    returning 1
  )
  select count(*) into v_count from queued;
  return coalesce(v_count,0);
end
$$;
revoke all on function public.enqueue_outgoing_webhook_event(uuid,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.enqueue_outgoing_webhook_event(uuid,text,text,jsonb) to service_role;

create or replace function public.emit_customer_webhook_event()
returns trigger
language plpgsql security definer set search_path=public
as $$
declare v_event text;
begin
  if tg_op='INSERT' then
    v_event:='customer.created';
  elsif (not old.do_not_call and new.do_not_call)
     or (not old.do_not_sms and new.do_not_sms)
     or (not old.do_not_email and new.do_not_email) then
    v_event:='customer.blocked';
  else
    v_event:='customer.updated';
  end if;
  perform public.enqueue_outgoing_webhook_event(
    new.tenant_id,v_event,
    'customer:'||new.id::text||':'||txid_current()::text||':'||tg_op,
    jsonb_build_object('customer_id',new.id,'before',case when tg_op='UPDATE' then to_jsonb(old) else null end,'after',to_jsonb(new))
  );
  return new;
end
$$;
drop trigger if exists customers_outgoing_webhooks on public.customers;
create trigger customers_outgoing_webhooks after insert or update on public.customers
for each row execute function public.emit_customer_webhook_event();

create or replace function public.emit_call_webhook_event()
returns trigger
language plpgsql security definer set search_path=public
as $$
declare v_event text;
begin
  if old.status is not distinct from new.status then return new; end if;
  v_event:=case
    when new.status='answered' then 'call.answered'
    when new.status in ('completed','busy','no_answer','failed','cancelled') then 'call.completed'
    else null
  end;
  if v_event is not null then
    perform public.enqueue_outgoing_webhook_event(
      new.tenant_id,v_event,
      'call:'||new.id::text||':'||new.status||':'||txid_current()::text,
      jsonb_build_object('call_id',new.id,'customer_id',new.customer_id,'status',new.status,'disposition',new.disposition,'started_at',new.started_at,'answered_at',new.answered_at,'ended_at',new.ended_at)
    );
  end if;
  return new;
end
$$;
drop trigger if exists calls_outgoing_webhooks on public.calls;
create trigger calls_outgoing_webhooks after update of status on public.calls
for each row execute function public.emit_call_webhook_event();

create or replace function public.emit_contract_webhook_event()
returns trigger
language plpgsql security definer set search_path=public
as $$
begin
  perform public.enqueue_outgoing_webhook_event(
    new.tenant_id,new.event_type,'contract_event:'||new.id::text,
    new.payload||jsonb_build_object('contract_id',new.contract_id,'occurred_at',new.occurred_at)
  );
  return new;
end
$$;
drop trigger if exists contract_events_outgoing_webhooks on public.contract_events;
create trigger contract_events_outgoing_webhooks after insert on public.contract_events
for each row execute function public.emit_contract_webhook_event();

commit;
