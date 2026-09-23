begin;

-- Avtalets svar når säljaren.
--
-- Genomgången 2026-09-23: e-postens leveransstatus nådde avtalet, SMS:ens inte;
-- att kunden öppnade länken ändrade inte avtalets status; och de händelser som
-- webhooks och automationer erbjuder (`contract.accepted`, `contract.expired`)
-- skapades aldrig, så en prenumeration på dem utlöstes aldrig.

-- 1. SMS-leverans når avtalet.
--
-- Rutten skrev bara `sms_messages`, och skrev över: en sen "skickat" tog bort
-- "levererat", och `delivered_at` nollades vid varje rapport som inte var
-- "levererat". Nu gäller samma regel som för e-post: status går aldrig bakåt,
-- och avtalsutskicket och avtalet följer med.
create or replace function public.apply_sms_delivery_event(
  p_tenant_id uuid,
  p_sms_message_id uuid,
  p_status text,
  p_provider_message_id text default null,
  p_provider_status text default null,
  p_failure_message text default null
)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_sms public.sms_messages%rowtype;
  v_apply boolean;
  v_now timestamptz := now();
  v_contract uuid;
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_required'; end if;
  if p_status not in ('created','sent','delivered','failed') then raise exception 'invalid_delivery_status'; end if;

  select * into v_sms from public.sms_messages where tenant_id = p_tenant_id and id = p_sms_message_id for update;
  if not found then raise exception 'sms_message_not_found'; end if;
  v_apply := public.delivery_status_rank(p_status) >= public.delivery_status_rank(v_sms.status::text);

  update public.sms_messages set
    provider_message_id = coalesce(provider_message_id, p_provider_message_id),
    status = case when v_apply then p_status::public.delivery_status else status end,
    sent_at = case when v_apply and p_status = 'sent' then coalesce(sent_at, v_now) else sent_at end,
    delivered_at = case when v_apply and p_status = 'delivered' then coalesce(delivered_at, v_now) else delivered_at end,
    error_message = case when v_apply and p_status = 'failed' then left(coalesce(p_failure_message, p_provider_status), 500) else error_message end,
    updated_at = v_now
  where tenant_id = p_tenant_id and id = p_sms_message_id;

  if not v_apply then
    return jsonb_build_object('applied', false, 'reason', 'regressive_provider_event');
  end if;

  update public.contract_deliveries set
    status = p_status::public.delivery_status,
    provider_status = p_provider_status,
    provider_status_at = v_now,
    sent_at = case when p_status = 'sent' then coalesce(sent_at, v_now) else sent_at end,
    delivered_at = case when p_status = 'delivered' then coalesce(delivered_at, v_now) else delivered_at end,
    failure_code = case when p_status = 'failed' then 'failed' else failure_code end,
    failure_message = case when p_status = 'failed' then left(coalesce(p_failure_message, p_provider_status), 500) else failure_message end
  where tenant_id = p_tenant_id and sms_message_id = p_sms_message_id
    and public.delivery_status_rank(status::text) <= public.delivery_status_rank(p_status)
  returning contract_id into v_contract;

  v_contract := coalesce(v_contract, v_sms.contract_id);
  if v_contract is not null and p_status in ('delivered','failed') then
    insert into public.contract_events(tenant_id, contract_id, event_type, payload)
    values(p_tenant_id, v_contract, 'sms.' || p_status, jsonb_build_object(
      'sms_message_id', p_sms_message_id, 'provider_status', p_provider_status));
    if p_status = 'delivered' then
      update public.contracts set status = 'delivered'
        where tenant_id = p_tenant_id and id = v_contract and status = 'sent';
    end if;
  end if;

  return jsonb_build_object('applied', true, 'contract_id', v_contract, 'status', p_status);
end $$;

revoke all on function public.apply_sms_delivery_event(uuid,uuid,text,text,text,text) from public, anon, authenticated;
grant execute on function public.apply_sms_delivery_event(uuid,uuid,text,text,text,text) to service_role;

-- 2. Öppnat betyder att kunden öppnade länken.
--
-- "Öppnat" kom bara från e-postens öppningsspårning. En kund som fick länken
-- per SMS och öppnade den visades som "Skickat" tills hen svarade.
create or replace function public.mark_acceptance_opened(p_request_id uuid)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare v_request public.contract_acceptance_requests%rowtype; v_now timestamptz:=now();
begin
  if auth.role()<>'service_role' then raise exception 'service_role_required'; end if;
  select * into v_request from public.contract_acceptance_requests where id=p_request_id for update;
  if not found then raise exception 'acceptance_request_not_found'; end if;
  if v_request.status<>'pending' or v_request.opened_at is not null then
    return jsonb_build_object('opened',false,'opened_at',v_request.opened_at,'status',v_request.status);
  end if;
  update public.contract_acceptance_requests set opened_at=v_now where id=v_request.id;
  insert into public.contract_events(tenant_id,contract_id,event_type,payload)
    values(v_request.tenant_id,v_request.contract_id,'acceptance.opened',jsonb_build_object('request_id',v_request.id,'opened_at',v_now));
  update public.contracts set status='opened'
    where tenant_id=v_request.tenant_id and id=v_request.contract_id and status in ('sent','delivered');
  return jsonb_build_object('opened',true,'opened_at',v_now,'status',v_request.status);
end $$;

-- 3. De händelser som erbjuds ska också skickas.
--
-- Webhook- och automationsformulären erbjuder `contract.accepted` och
-- `contract.expired`. Databasen skapade bara `contract.accepted_via_web` och
-- `..._via_sms`, och ingen utgångshändelse alls. Båda triggarna skickar nu även
-- det gemensamma namnet för en acceptans, med egen dedupliceringsnyckel.
create or replace function public.emit_contract_webhook_event()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
begin
  perform public.enqueue_outgoing_webhook_event(
    new.tenant_id,new.event_type,'contract_event:'||new.id::text,
    new.payload||jsonb_build_object('contract_id',new.contract_id,'occurred_at',new.occurred_at)
  );
  if new.event_type in ('contract.accepted_via_web','contract.accepted_via_sms') then
    perform public.enqueue_outgoing_webhook_event(
      new.tenant_id,'contract.accepted','contract_event:'||new.id::text||':accepted',
      new.payload||jsonb_build_object('contract_id',new.contract_id,'occurred_at',new.occurred_at,'channel',new.event_type)
    );
  end if;
  return new;
end
$$;

create or replace function public.emit_contract_automation_event()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
begin
  perform public.enqueue_automation_event(new.tenant_id,new.event_type,'contract_event:'||new.id::text,'contract',new.contract_id,new.payload||jsonb_build_object('contract_id',new.contract_id));
  if new.event_type in ('contract.accepted_via_web','contract.accepted_via_sms') then
    perform public.enqueue_automation_event(new.tenant_id,'contract.accepted','contract_event:'||new.id::text||':accepted','contract',new.contract_id,
      new.payload||jsonb_build_object('contract_id',new.contract_id,'channel',new.event_type));
  end if;
  return new;
end
$$;

create or replace function public.expire_contracts_without_pending_acceptance()
returns integer
language plpgsql security definer set search_path to 'public'
as $$
declare v_count integer;
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then raise exception 'service_role_required'; end if;
  with expired as (
    update public.contracts c
    set status='expired'
    where c.status in ('sent','delivered','opened')
      and exists(
        select 1 from public.contract_acceptance_requests a
        where a.tenant_id=c.tenant_id and a.contract_id=c.id and a.status='expired'
          and a.generation=c.acceptance_generation
      )
      and not exists(
        select 1 from public.contract_acceptance_requests a
        where a.tenant_id=c.tenant_id and a.contract_id=c.id and a.status='pending' and a.expires_at>now()
      )
    returning c.tenant_id, c.id
  )
  insert into public.contract_events(tenant_id,contract_id,event_type,payload)
  select tenant_id, id, 'contract.expired', '{}'::jsonb from expired;
  get diagnostics v_count=row_count;
  return v_count;
end $$;

-- 4. Snabbfiltren visar alla avtal i läget.
--
-- "Väntar på svar" visade bara `sent`, och "Signerade" bara `signed` -- ett avtal
-- som kunden klickat godkänt är `accepted` och syntes inte. Filtren blir
-- lägesfilter: väntar, ja och nej.
do $migration$
declare
  v_definition text;
  v_anchor constant text := $a$      or (p_attention='waiting' and c.status in ('sent','delivered','opened'))$a$;
begin
  select pg_get_functiondef(p.oid) into v_definition from pg_proc p
    where p.pronamespace='public'::regnamespace and p.proname='contract_registry_page';
  if position($a$p_attention='answered_yes'$a$ in v_definition) > 0 then return; end if;
  if position(v_anchor in v_definition) = 0 then raise exception 'contract_registry_page_waiting_anchor_missing'; end if;
  execute replace(v_definition, v_anchor, $r$      or (p_attention='waiting' and c.status in ('sent','delivered','opened','signing'))
      or (p_attention='answered_yes' and c.status in ('accepted','signed','active'))
      or (p_attention='answered_no' and c.status in ('declined','expired'))$r$);
end
$migration$;

commit;
