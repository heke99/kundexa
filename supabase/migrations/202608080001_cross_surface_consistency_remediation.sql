-- Cross-surface consistency remediation.
-- Forward-only: do not edit already delivered migrations.

-- API customer idempotency uses a pre-reserved customer UUID in audit_logs.
-- The partial unique index makes the reservation atomic without changing the public schema shape.
create unique index if not exists audit_logs_customer_api_idempotency_uidx
  on public.audit_logs(tenant_id, request_id)
  where action='customer.api_created' and request_id is not null;

-- Product creation must commit the product and its first price version together.
-- A private trigger keeps the public generated Supabase type surface unchanged.
create schema if not exists private;
revoke all on schema private from public;

create or replace function private.create_initial_product_price()
returns trigger
language plpgsql
security definer
set search_path=pg_catalog,public
as $$
declare
  v_seed jsonb:=new.configuration->'_initial_price';
begin
  if v_seed is null then
    return new;
  end if;

  if jsonb_typeof(v_seed)<>'object' then
    raise exception 'initial_product_price_invalid';
  end if;

  insert into public.product_price_versions(
    tenant_id,product_id,version,currency,setup_fee,recurring_fee,recurring_interval,
    variable_fees,binding_months,notice_months,payment_terms_days,terms
  ) values(
    new.tenant_id,new.id,1,coalesce(nullif(v_seed->>'currency',''),'SEK'),
    coalesce((v_seed->>'setup_fee')::numeric,0),
    coalesce((v_seed->>'recurring_fee')::numeric,0),
    nullif(v_seed->>'recurring_interval',''),
    coalesce(v_seed->'variable_fees','[]'::jsonb),
    nullif(v_seed->>'binding_months','')::integer,
    nullif(v_seed->>'notice_months','')::integer,
    coalesce((v_seed->>'payment_terms_days')::integer,30),
    coalesce(v_seed->'terms','{}'::jsonb)
  );

  update public.products
  set configuration=coalesce(configuration,'{}'::jsonb)-'_initial_price'
  where tenant_id=new.tenant_id and id=new.id;

  return new;
end $$;

revoke all on function private.create_initial_product_price() from public;
drop trigger if exists products_create_initial_price on public.products;
create trigger products_create_initial_price
  after insert on public.products
  for each row
  when (new.configuration ? '_initial_price')
  execute function private.create_initial_product_price();

-- Keep Resend delivery state, contract projection, reminder cancellation and suppression
-- in the same database transaction. Signature is intentionally unchanged.
create or replace function public.apply_resend_delivery_event(
  p_tenant_id uuid,p_email_message_id uuid,p_provider_event_id text,p_provider_event_type text,
  p_status text,p_occurred_at timestamptz,p_payload jsonb default '{}'::jsonb,p_failure_message text default null
) returns jsonb
language plpgsql security definer set search_path=public as $$
declare
  v_email public.email_messages%rowtype;
  v_event_id uuid;
  v_apply boolean:=false;
  v_reason text;
  v_occurred timestamptz:=coalesce(p_occurred_at,now());
  v_current_rank integer;
  v_new_rank integer;
  v_permanent boolean:=p_status in ('failed','bounced','complained','suppressed','cancelled','dead_letter');
  v_request record;
begin
  if auth.role()<>'service_role' then raise exception 'service_role_required'; end if;
  if p_status not in ('draft','queued','submitting','created','sent','delayed','delivered','opened','clicked','failed','bounced','complained','suppressed','cancelled','dead_letter') then
    raise exception 'invalid_delivery_status';
  end if;

  insert into public.email_delivery_events(
    tenant_id,email_message_id,provider_event_id,provider_event_type,delivery_status,occurred_at,payload
  ) values(p_tenant_id,p_email_message_id,p_provider_event_id,p_provider_event_type,p_status::public.delivery_status,v_occurred,coalesce(p_payload,'{}'::jsonb))
  on conflict(provider,provider_event_id) do nothing returning id into v_event_id;
  if v_event_id is null then
    update public.provider_webhook_events
    set status='processed',processed_at=coalesce(processed_at,now()),attempts=greatest(attempts,1),last_error=null
    where tenant_id=p_tenant_id and provider='resend' and provider_event_id=p_provider_event_id;
    return jsonb_build_object('duplicate',true,'applied',false);
  end if;

  select * into v_email from public.email_messages where tenant_id=p_tenant_id and id=p_email_message_id for update;
  if not found then raise exception 'email_message_not_found'; end if;
  v_current_rank:=public.delivery_status_rank(v_email.status::text);
  v_new_rank:=public.delivery_status_rank(p_status);
  if v_email.provider_status_at is null then
    v_apply:=true; v_reason:='first_provider_event';
  elsif v_occurred < v_email.provider_status_at then
    v_reason:='older_provider_event';
  elsif v_new_rank < v_current_rank then
    v_reason:='regressive_provider_event';
  else
    v_apply:=true;
    v_reason:=case when v_occurred=v_email.provider_status_at then 'same_time_non_regressive' else 'newer_non_regressive' end;
  end if;

  if v_apply then
    update public.email_messages set
      status=p_status::public.delivery_status,provider_status=p_provider_event_type,provider_status_at=v_occurred,
      sent_at=case when p_status='sent' then coalesce(sent_at,v_occurred) else sent_at end,
      delivered_at=case when p_status='delivered' then coalesce(delivered_at,v_occurred) else delivered_at end,
      opened_at=case when p_status='opened' then coalesce(opened_at,v_occurred) else opened_at end,
      clicked_at=case when p_status='clicked' then coalesce(clicked_at,v_occurred) else clicked_at end,
      delayed_at=case when p_status='delayed' then coalesce(delayed_at,v_occurred) else delayed_at end,
      bounced_at=case when p_status='bounced' then coalesce(bounced_at,v_occurred) else bounced_at end,
      complained_at=case when p_status='complained' then coalesce(complained_at,v_occurred) else complained_at end,
      suppressed_at=case when p_status='suppressed' then coalesce(suppressed_at,v_occurred) else suppressed_at end,
      error_message=case when v_permanent then left(coalesce(p_failure_message,p_provider_event_type),500) else error_message end,
      failure_code=case when v_permanent then p_status else failure_code end
    where tenant_id=p_tenant_id and id=p_email_message_id;

    update public.contract_deliveries set
      status=p_status::public.delivery_status,provider_status=p_provider_event_type,provider_status_at=v_occurred,
      sent_at=case when p_status='sent' then coalesce(sent_at,v_occurred) else sent_at end,
      delivered_at=case when p_status='delivered' then coalesce(delivered_at,v_occurred) else delivered_at end,
      opened_at=case when p_status='opened' then coalesce(opened_at,v_occurred) else opened_at end,
      clicked_at=case when p_status='clicked' then coalesce(clicked_at,v_occurred) else clicked_at end,
      delayed_at=case when p_status='delayed' then coalesce(delayed_at,v_occurred) else delayed_at end,
      bounced_at=case when p_status='bounced' then coalesce(bounced_at,v_occurred) else bounced_at end,
      complained_at=case when p_status='complained' then coalesce(complained_at,v_occurred) else complained_at end,
      suppressed_at=case when p_status='suppressed' then coalesce(suppressed_at,v_occurred) else suppressed_at end,
      failure_code=case when v_permanent then p_status else failure_code end,
      failure_message=case when v_permanent then left(coalesce(p_failure_message,p_provider_event_type),500) else failure_message end
    where tenant_id=p_tenant_id and email_message_id=p_email_message_id
      and (provider_status_at is null or provider_status_at<=v_occurred);

    if v_email.contract_id is not null then
      insert into public.contract_events(tenant_id,contract_id,event_type,payload)
      values(p_tenant_id,v_email.contract_id,p_provider_event_type,jsonb_build_object(
        'provider_event_id',p_provider_event_id,
        'email_message_id',p_email_message_id,
        'status',p_status,
        'occurred_at',v_occurred,
        'projection_reason',v_reason
      ));

      if p_status='delivered' then
        update public.contracts set status='delivered'
        where tenant_id=p_tenant_id and id=v_email.contract_id and status='sent';
      elsif p_status in ('opened','clicked') then
        update public.contracts set status='opened'
        where tenant_id=p_tenant_id and id=v_email.contract_id and status in ('sent','delivered');
      end if;

      if v_permanent then
        for v_request in
          select id from public.contract_acceptance_requests
          where tenant_id=p_tenant_id and contract_id=v_email.contract_id and status='pending'
          for update
        loop
          perform public.cancel_contract_reminders(v_request.id,p_status);
        end loop;
      end if;
    end if;

    if v_email.customer_id is not null and p_status in ('complained','suppressed') then
      update public.customers
      set do_not_email=true,blocked_reason='Resend '||p_status
      where tenant_id=p_tenant_id and id=v_email.customer_id;
    end if;
  end if;

  update public.email_delivery_events set projection_applied=v_apply,projection_reason=v_reason where id=v_event_id;
  update public.provider_webhook_events
  set status='processed',processed_at=now(),attempts=greatest(attempts,1),last_error=null
  where tenant_id=p_tenant_id and provider='resend' and provider_event_id=p_provider_event_id;
  return jsonb_build_object(
    'duplicate',false,'applied',v_apply,'reason',v_reason,'permanent',v_permanent,
    'contract_id',v_email.contract_id,'customer_id',v_email.customer_id,'status',p_status
  );
end $$;

revoke all on function public.apply_resend_delivery_event(uuid,uuid,text,text,text,timestamptz,jsonb,text) from public,anon,authenticated;
grant execute on function public.apply_resend_delivery_event(uuid,uuid,text,text,text,timestamptz,jsonb,text) to service_role;

-- A compliance block is the canonical deny record. Project its channels onto the
-- customer in the same transaction so no write ordering can briefly leave a blocked
-- contact callable/sendable.
create or replace function private.project_compliance_block_to_customer()
returns trigger
language plpgsql
security definer
set search_path=pg_catalog,public
as $$
declare
  v_all_channels boolean;
begin
  if not new.active or new.customer_id is null then
    return new;
  end if;

  v_all_channels := array['call','sms','email']::text[] <@ new.channels;
  update public.customers
  set
    do_not_call=do_not_call or ('call'=any(new.channels)),
    do_not_sms=do_not_sms or ('sms'=any(new.channels)),
    do_not_email=do_not_email or ('email'=any(new.channels)),
    marketing_allowed=case when ('call'=any(new.channels) or 'sms'=any(new.channels) or 'email'=any(new.channels)) then false else marketing_allowed end,
    lifecycle=case when v_all_channels then 'blocked'::public.customer_lifecycle else lifecycle end,
    blocked_reason=coalesce(nullif(new.reason,''),blocked_reason)
  where tenant_id=new.tenant_id and id=new.customer_id;

  return new;
end $$;

revoke all on function private.project_compliance_block_to_customer() from public;
drop trigger if exists compliance_blocks_project_customer on public.compliance_blocks;
create trigger compliance_blocks_project_customer
  after insert or update of active,channels,reason on public.compliance_blocks
  for each row execute function private.project_compliance_block_to_customer();

-- Platform read pages must follow RLS instead of using a service-role data client.
-- Support is intentionally excluded, matching the existing platform list/audit policies.
drop policy if exists tenants_platform_read on public.tenants;
create policy tenants_platform_read on public.tenants
  for select to authenticated
  using(public.is_platform_role(array[
    'platform_owner'::public.platform_role,
    'platform_admin'::public.platform_role,
    'platform_auditor'::public.platform_role
  ]));

drop policy if exists tenant_memberships_platform_read on public.tenant_memberships;
create policy tenant_memberships_platform_read on public.tenant_memberships
  for select to authenticated
  using(public.is_platform_role(array[
    'platform_owner'::public.platform_role,
    'platform_admin'::public.platform_role,
    'platform_auditor'::public.platform_role
  ]));

-- Bring pre-existing active compliance blocks onto the same customer projection as
-- future writes. Aggregate channels across all active blocks so three separate block
-- records are equivalent to one block containing call/sms/email.
with active_customer_blocks as (
  select
    tenant_id,
    customer_id,
    bool_or('call'=any(channels)) as blocks_call,
    bool_or('sms'=any(channels)) as blocks_sms,
    bool_or('email'=any(channels)) as blocks_email,
    (array_agg(nullif(reason,'') order by created_at desc) filter (where nullif(reason,'') is not null))[1] as latest_reason
  from public.compliance_blocks
  where active and customer_id is not null
  group by tenant_id,customer_id
)
update public.customers c
set
  do_not_call=c.do_not_call or b.blocks_call,
  do_not_sms=c.do_not_sms or b.blocks_sms,
  do_not_email=c.do_not_email or b.blocks_email,
  marketing_allowed=case when b.blocks_call or b.blocks_sms or b.blocks_email then false else c.marketing_allowed end,
  lifecycle=case when b.blocks_call and b.blocks_sms and b.blocks_email then 'blocked'::public.customer_lifecycle else c.lifecycle end,
  blocked_reason=coalesce(b.latest_reason,c.blocked_reason)
from active_customer_blocks b
where c.tenant_id=b.tenant_id and c.id=b.customer_id;
