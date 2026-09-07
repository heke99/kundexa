-- NIX screening: a seller-reported exception instead of a blanket pre-call gate.
--
-- The previous model assumed Kundexa performs the screening itself: a private
-- individual could not be called until a `nix_checks` row existed for the number.
-- A tenant that buys already-screened number sources has no such row for any
-- number, so every business-to-consumer call was refused with
-- `nix_check_required` and the register could never be satisfied.
--
-- The legal obligation is not to call a listed consumer; how a tenant satisfies it
-- is an operational choice. Two modes are now supported, on
-- `tenant_settings.compliance`:
--
--   nix_screening_mode = 'provider_check'      (default, unchanged behaviour)
--       Kundexa screens. An unscreened number may not be called.
--   nix_screening_mode = 'pre_screened_source'
--       The tenant sources numbers that are screened before import. A missing
--       result no longer refuses the call. A seller who reaches a listed number
--       reports it, which records a 'listed' result and blocks the number.
--
-- A recorded result that is not 'not_listed' refuses the call in BOTH modes, so
-- relaxing the mode never makes a known-listed number callable. The seller report
-- is durable and phone-keyed: it writes `nix_checks`, sets `customers.do_not_call`
-- and inserts a `compliance_blocks` row for the number, so the same number is
-- refused again even on a different customer card created later.
--
-- Marketing legal basis gains the same shape. A tenant whose whole operation runs
-- on one documented basis records it once as
-- `tenant_settings.compliance ->> 'default_marketing_legal_basis'` instead of on
-- every card. A per-card basis or an explicit consent still takes precedence.
--
-- Both settings default to the strict behaviour and only change when a tenant
-- administrator sets them deliberately.

-- One definition of what a blocking disposition does, shared by the manual dialer
-- and the list dialer so the two can never drift.
create or replace function public.apply_call_block_disposition(
  p_tenant_id uuid,
  p_customer_id uuid,
  p_disposition text,
  p_notes text,
  p_actor_id uuid,
  p_surface text
) returns void
language plpgsql
security definer
set search_path=public
as $$
declare
  v_reason text;
  v_phone text;
  v_alternate text;
begin
  if p_disposition not in ('do_not_call','nix_listed') then return; end if;

  v_reason := coalesce(
    nullif(trim(coalesce(p_notes,'')),''),
    case when p_disposition='nix_listed'
      then 'Numret är NIX-registrerat enligt säljarens kontroll i ' || p_surface
      else 'Kundens önskemål via ' || p_surface end
  );

  update public.customers
  set do_not_call=true,
      blocked_reason=v_reason
  where tenant_id=p_tenant_id and id=p_customer_id
  returning phone_e164, alternate_phone_e164 into v_phone, v_alternate;
  if not found then raise exception 'call_block_customer_not_found'; end if;

  insert into public.compliance_blocks(tenant_id,customer_id,phone_e164,channels,reason,source,created_by)
  values(
    p_tenant_id,p_customer_id,v_phone,array['call'],v_reason,
    case when p_disposition='nix_listed' then 'seller_reported_nix' else 'seller_reported_do_not_call' end,
    p_actor_id
  );

  -- A NIX listing is a property of the number, not of this customer card. Record
  -- it as a screening result so a card created later for the same number is
  -- refused on the register, not only on this card's block.
  if p_disposition='nix_listed' then
    if v_phone is not null then
      insert into public.nix_checks(
        tenant_id,customer_id,phone_e164,source,source_version,result,checked_at,valid_until,evidence
      ) values(
        p_tenant_id,p_customer_id,v_phone,'seller_reported','manual',
        'listed',now(),now()+interval '1 year',
        jsonb_build_object('surface',p_surface,'reported_by',p_actor_id,'reason',v_reason)
      );
    end if;
    if v_alternate is not null and v_alternate is distinct from v_phone then
      insert into public.compliance_blocks(tenant_id,customer_id,phone_e164,channels,reason,source,created_by)
      values(p_tenant_id,p_customer_id,v_alternate,array['call'],v_reason,'seller_reported_nix',p_actor_id);
    end if;
  end if;
end
$$;
revoke all on function public.apply_call_block_disposition(uuid,uuid,text,text,uuid,text) from public,anon,authenticated;

create or replace function public.evaluate_contact_policy_for_tenant(
  p_tenant_id uuid,
  p_customer_id uuid,
  p_channel text,
  p_purpose text default 'direct_marketing'
)
returns jsonb
language plpgsql stable security definer set search_path=public
as $$
declare
  v_customer public.customers%rowtype;
  v_feature text;
  v_permission_status text;
  v_nix_result text;
  v_timezone text := 'Europe/Stockholm';
  v_compliance jsonb := '{}'::jsonb;
  v_local timestamp;
  v_days jsonb;
  v_start time;
  v_end time;
  v_has_legal_basis boolean := false;
begin
  if p_channel not in ('call','sms','email') then
    return jsonb_build_object('allowed',false,'reason','invalid_channel');
  end if;

  select * into v_customer from public.customers
  where tenant_id=p_tenant_id and id=p_customer_id and deleted_at is null;
  if not found then return jsonb_build_object('allowed',false,'reason','customer_not_found'); end if;

  v_feature := case
    when p_purpose in ('contract_delivery','contract_confirmation') and p_channel='sms' then 'contract_delivery_sms'
    when p_purpose in ('contract_delivery','contract_confirmation') and p_channel='email' then 'contract_delivery_email'
    when p_channel='call' then 'outbound_calls'
    when p_channel='sms' then 'outbound_sms'
    else 'outbound_email'
  end;

  if not exists(
    select 1 from public.tenant_features
    where tenant_id=p_tenant_id and feature_key=v_feature and enabled
  ) then return jsonb_build_object('allowed',false,'reason','feature_disabled','feature',v_feature); end if;

  if (p_channel='call' and v_customer.do_not_call)
     or (p_channel='sms' and v_customer.do_not_sms)
     or (p_channel='email' and v_customer.do_not_email) then
    return jsonb_build_object('allowed',false,'reason','customer_channel_block');
  end if;

  if exists(
    select 1 from public.compliance_blocks b
    where b.tenant_id=p_tenant_id and b.active
      and (b.expires_at is null or b.expires_at>now())
      and p_channel=any(b.channels)
      and (
        b.customer_id=v_customer.id
        or (b.phone_e164 is not null and b.phone_e164 in (v_customer.phone_e164,v_customer.alternate_phone_e164))
        or (b.email is not null and b.email=v_customer.email)
      )
  ) then return jsonb_build_object('allowed',false,'reason','compliance_block'); end if;

  select cp.status into v_permission_status
  from public.contact_permissions cp
  where cp.tenant_id=p_tenant_id and cp.customer_id=p_customer_id and cp.channel=p_channel
    and cp.purpose=p_purpose and cp.valid_from<=now()
    and (cp.valid_until is null or cp.valid_until>now())
  order by cp.created_at desc limit 1;

  if v_permission_status in ('denied','objected','expired') then
    return jsonb_build_object('allowed',false,'reason','contact_permission_'||v_permission_status);
  end if;

  -- Compliance configuration is needed by both the legal-basis and the NIX
  -- branches below, so it is loaded once here rather than inside the call branch.
  select coalesce(t.timezone,'Europe/Stockholm'),coalesce(ts.compliance,'{}'::jsonb)
    into v_timezone,v_compliance
  from public.tenants t left join public.tenant_settings ts on ts.tenant_id=t.id
  where t.id=p_tenant_id;

  if p_purpose in ('direct_marketing','automation_marketing') then
    if v_customer.marketing_allowed is false then
      return jsonb_build_object('allowed',false,'reason','marketing_not_allowed');
    end if;
    -- `v_permission_status` is null when the customer has no contact-permission
    -- row at all. Without coalescing, `false or null` yields null, `not null`
    -- yields null, and the legal-basis gate below silently does not fire - which
    -- is exactly the case it exists to stop.
    -- A tenant that has documented one legal basis for its whole marketing
    -- operation (a purchased, pre-screened list under legitimate interest, say)
    -- records it once in tenant settings instead of on every card. A per-card
    -- basis or an explicit consent still takes precedence and is unchanged.
    v_has_legal_basis := nullif(trim(coalesce(v_customer.legal_basis,'')),'') is not null
      or coalesce(v_permission_status,'')='allowed'
      or nullif(trim(coalesce(v_compliance->>'default_marketing_legal_basis','')),'') is not null;
    if v_customer.customer_type='person' and not v_has_legal_basis then
      return jsonb_build_object('allowed',false,'reason','legal_basis_required');
    end if;
  end if;

  if p_channel='call' and p_purpose in ('direct_marketing','automation_marketing') then
    v_local := now() at time zone v_timezone;
    v_days := coalesce(v_compliance->'allowed_call_isodow','[1,2,3,4,5]'::jsonb);
    v_start := coalesce(nullif(v_compliance->>'call_start_local','')::time,'08:00'::time);
    v_end := coalesce(nullif(v_compliance->>'call_end_local','')::time,'21:00'::time);
    if not (v_days @> to_jsonb(array[extract(isodow from v_local)::integer]))
       or v_local::time < v_start or v_local::time >= v_end then
      return jsonb_build_object('allowed',false,'reason','outside_contact_hours','timezone',v_timezone);
    end if;

    if v_customer.customer_type='person' then
      select n.result into v_nix_result
      from public.nix_checks n
      where n.tenant_id=p_tenant_id and n.phone_e164=v_customer.phone_e164
        and n.valid_until>now()
      order by n.checked_at desc limit 1;
      -- A recorded result that is not 'not_listed' always refuses the call, in
      -- every mode. Only the treatment of a *missing* result is configurable:
      --   provider_check      - the default. Screening happens in Kundexa, so an
      --                         unscreened number may not be called.
      --   pre_screened_source - the tenant sources numbers that are already
      --                         screened before import, and sellers report an
      --                         individual listing they encounter, which records
      --                         a 'listed' result and blocks the number for good.
      if v_nix_result is not null and v_nix_result<>'not_listed' then
        return jsonb_build_object('allowed',false,'reason','nix_'||v_nix_result);
      end if;
      if v_nix_result is null
         and coalesce(v_compliance->>'nix_screening_mode','provider_check')<>'pre_screened_source' then
        return jsonb_build_object('allowed',false,'reason','nix_check_required');
      end if;
    end if;
  end if;

  return jsonb_build_object('allowed',true,'reason','allowed','feature',v_feature);
end
$$;

create or replace function public.complete_manual_call_work(
  p_call_id uuid,p_disposition text,p_notes text,p_callback_scope text,p_callback_due_at timestamptz
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_tenant uuid:=public.current_tenant_id(); v_user uuid:=auth.uid(); v_call public.calls%rowtype; v_callback uuid; v_team uuid;
begin
  if p_disposition not in ('no_answer','busy','voicemail','callback','interested','not_interested','wrong_number','do_not_call','nix_listed') then raise exception 'manual_disposition_invalid'; end if;
  select * into v_call from public.calls where tenant_id=v_tenant and id=p_call_id and user_id=v_user for update;
  if not found or v_call.list_id is not null then raise exception 'manual_call_not_found'; end if;
  if v_call.disposition is not null then return jsonb_build_object('completed',true,'idempotentReplay',true); end if;
  if v_call.status not in ('completed','busy','no_answer','failed','cancelled') or v_call.ended_at is null then raise exception 'call_not_finished'; end if;
  if p_disposition='callback' and (p_callback_due_at is null or p_callback_due_at<=now() or p_callback_scope not in ('personal','global')) then raise exception 'future_callback_required'; end if;
  update public.calls set disposition=p_disposition,notes=nullif(trim(p_notes),''),after_call_completed_at=now() where tenant_id=v_tenant and id=p_call_id;
  update public.customers set last_contact_at=coalesce(v_call.ended_at,now()),call_attempts=call_attempts+1 where tenant_id=v_tenant and id=v_call.customer_id;
  if nullif(trim(p_notes),'') is not null then
    insert into public.notes(tenant_id,customer_id,body,visibility,note_type,call_id,created_by)
    values(v_tenant,v_call.customer_id,trim(p_notes),'team',case when p_disposition='callback' then 'callback' else 'call' end,p_call_id,v_user);
  end if;
  if v_call.callback_activity_id is not null then
    update public.activities set status='completed',completed_at=now(),handled_at=now(),claimed_by=null,claim_expires_at=null
      where tenant_id=v_tenant and id=v_call.callback_activity_id;
  end if;
  if p_disposition='callback' then
    select assigned_team_id into v_team from public.customers where tenant_id=v_tenant and id=v_call.customer_id;
    insert into public.activities(tenant_id,customer_id,type,status,title,description,assigned_user_id,assigned_team_id,priority,due_at,created_by,call_id,callback_scope)
    values(v_tenant,v_call.customer_id,'callback','open','Återkomst',nullif(trim(p_notes),''),case when p_callback_scope='personal' then v_user else null end,
      case when p_callback_scope='global' then v_team else null end,'high',p_callback_due_at,v_user,p_call_id,p_callback_scope) returning id into v_callback;
    update public.customers set next_activity_at=least(coalesce(next_activity_at,p_callback_due_at),p_callback_due_at) where tenant_id=v_tenant and id=v_call.customer_id;
  end if;
  if p_disposition in ('do_not_call','nix_listed') then
    perform public.apply_call_block_disposition(v_tenant,v_call.customer_id,p_disposition,p_notes,v_user,'manuell dialer');
  end if;
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
  values(v_tenant,v_user,'manual_call.after_work_completed','call',p_call_id::text,jsonb_build_object('disposition',p_disposition,'callbackId',v_callback));
  return jsonb_build_object('completed',true,'callbackId',v_callback);
end $$;

create or replace function public.complete_dialer_work(
  p_call_id uuid,p_disposition_key text,p_notes text,p_callback_scope text,p_callback_due_at timestamptz,
  p_create_order boolean,p_product_id uuid,p_quantity numeric,p_unit_price numeric,p_idempotency_key text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_tenant uuid:=public.current_tenant_id(); v_user uuid:=auth.uid(); v_call public.calls%rowtype; v_member public.customer_list_members%rowtype;
  v_list public.customer_lists%rowtype; v_disposition public.list_dispositions%rowtype; v_order uuid; v_order_number text;
  v_product public.products%rowtype; v_price public.product_price_versions%rowtype; v_quantity numeric:=greatest(coalesce(p_quantity,1),0.0001);
  v_unit numeric; v_line numeric; v_next timestamptz; v_callback uuid; v_team uuid;
begin
  if nullif(trim(p_idempotency_key),'') is null then raise exception 'idempotency_key_required'; end if;
  select * into v_call from public.calls where tenant_id=v_tenant and id=p_call_id and user_id=v_user for update;
  if not found or v_call.list_id is null or v_call.list_member_id is null or v_call.dialer_session_id is null then raise exception 'list_call_not_found'; end if;
  if v_call.after_call_completed_at is not null then
    select id into v_order from public.sales_orders where tenant_id=v_tenant and source_call_id=p_call_id;
    return jsonb_build_object('completed',true,'idempotentReplay',true,'orderId',v_order);
  end if;
  if v_call.status not in ('completed','busy','no_answer','failed','cancelled') or v_call.ended_at is null then raise exception 'call_not_finished'; end if;
  select * into v_list from public.customer_lists where tenant_id=v_tenant and id=v_call.list_id;
  select * into v_member from public.customer_list_members where tenant_id=v_tenant and id=v_call.list_member_id for update;
  select * into v_disposition from public.list_dispositions where tenant_id=v_tenant and list_id=v_call.list_id and key=p_disposition_key and active;
  if not found then raise exception 'invalid_list_disposition'; end if;
  if v_disposition.requires_note and nullif(trim(p_notes),'') is null then raise exception 'disposition_note_required'; end if;
  if v_disposition.requires_callback and (p_callback_due_at is null or p_callback_due_at<=now()) then raise exception 'future_callback_required'; end if;
  if p_callback_scope is not null and p_callback_scope not in ('personal','global') then raise exception 'callback_scope_invalid'; end if;
  if v_disposition.requires_callback and not (v_list.callback_policy='both' or v_list.callback_policy=p_callback_scope) then raise exception 'callback_scope_not_allowed'; end if;

  update public.calls set disposition=p_disposition_key,notes=nullif(trim(p_notes),''),after_call_completed_at=now(),
    status=case when status in ('queued','initiating','ringing','answered') then 'completed' else status end,ended_at=coalesce(ended_at,now())
  where id=p_call_id;
  update public.customers set last_contact_at=now(),call_attempts=call_attempts+1 where tenant_id=v_tenant and id=v_call.customer_id;
  if nullif(trim(p_notes),'') is not null then
    insert into public.notes(tenant_id,customer_id,body,visibility,note_type,call_id,list_id,created_by)
    values(v_tenant,v_call.customer_id,trim(p_notes),'team',case when v_disposition.requires_callback then 'callback' else 'call' end,p_call_id,v_call.list_id,v_user);
  end if;

  if v_call.callback_activity_id is not null then
    update public.activities set status='completed',completed_at=now(),handled_at=now(),claimed_by=null,claim_expires_at=null where tenant_id=v_tenant and id=v_call.callback_activity_id;
  end if;
  if v_disposition.requires_callback then
    v_team:=v_list.team_id;
    insert into public.activities(tenant_id,customer_id,type,status,title,description,assigned_user_id,assigned_team_id,priority,due_at,created_by,list_id,call_id,callback_scope,metadata)
    values(v_tenant,v_call.customer_id,'callback','open','Återkomst · '||v_list.name,nullif(trim(p_notes),''),case when p_callback_scope='personal' then v_user else null end,
      case when p_callback_scope='global' then v_team else null end,'high',p_callback_due_at,v_user,v_call.list_id,p_call_id,p_callback_scope,jsonb_build_object('source','dialer','disposition',p_disposition_key))
    returning id into v_callback;
    v_next:=p_callback_due_at;
  elsif v_disposition.retry_after_minutes is not null then
    v_next:=now()+make_interval(mins=>v_disposition.retry_after_minutes);
  end if;

  if p_create_order or v_disposition.requires_order then
    if p_product_id is null then raise exception 'order_product_required'; end if;
    select * into v_product from public.products where tenant_id=v_tenant and id=p_product_id and active;
    if not found then raise exception 'active_product_not_found'; end if;
    select * into v_price from public.product_price_versions where tenant_id=v_tenant and product_id=p_product_id and active and valid_from<=current_date and (valid_to is null or valid_to>=current_date) order by version desc limit 1;
    v_unit:=coalesce(p_unit_price,v_price.setup_fee+v_price.recurring_fee,0); v_line:=round(v_quantity*v_unit,2);
    v_order_number:='KX-'||to_char(now(),'YYYYMM')||'-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,8));
    insert into public.sales_orders(tenant_id,order_number,customer_id,source_call_id,source_list_id,owner_user_id,status,currency,subtotal,total,notes,confirmed_at)
    values(v_tenant,v_order_number,v_call.customer_id,p_call_id,v_call.list_id,v_user,'confirmed',coalesce(v_price.currency,'SEK'),v_line,v_line,nullif(trim(p_notes),''),now()) returning id into v_order;
    insert into public.sales_order_items(tenant_id,order_id,product_id,price_version_id,description,quantity,unit_price,line_total)
    values(v_tenant,v_order,p_product_id,v_price.id,v_product.name,v_quantity,v_unit,v_line);
    update public.customers set lifecycle='customer' where tenant_id=v_tenant and id=v_call.customer_id and lifecycle in ('prospect','lead');
  end if;

  update public.customer_list_members set
    state=case when p_disposition_key in ('do_not_call','nix_listed') then 'blocked' when v_disposition.requires_callback then 'callback'
      when v_disposition.retry_after_minutes is not null and attempts<v_list.max_attempts then 'retry' else 'completed' end,
    outcome=p_disposition_key,next_attempt_at=v_next,claimed_by=null,claim_expires_at=null,
    completed_at=case when v_disposition.terminal or p_create_order or v_disposition.requires_order then now() else null end
  where id=v_member.id;
  if p_disposition_key in ('do_not_call','nix_listed') then
    perform public.apply_call_block_disposition(v_tenant,v_call.customer_id,p_disposition_key,p_notes,v_user,'dialer');
  end if;
  update public.customers set next_activity_at=v_next where tenant_id=v_tenant and id=v_call.customer_id;
  update public.dialer_sessions set state='active',current_list_member_id=null,current_callback_activity_id=null,current_call_id=null,last_seen_at=now() where tenant_id=v_tenant and id=v_call.dialer_session_id and user_id=v_user;
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,request_id,after_data)
  values(v_tenant,v_user,'dialer.after_call_completed','call',p_call_id::text,p_idempotency_key,jsonb_build_object('disposition',p_disposition_key,'callback_id',v_callback,'order_id',v_order));
  return jsonb_build_object('completed',true,'orderId',v_order,'callbackId',v_callback,'nextAttemptAt',v_next,'autoNextDelaySeconds',v_list.auto_next_delay_seconds);
end $$;

-- The reservation path carries a second NIX control, keyed on the number actually
-- dialled rather than the one on the card. It had two problems: it applied to every
-- customer type, so a company call was refused for a missing consumer-register
-- result, and it knew nothing about the screening mode. Both are corrected here so
-- that this control and `evaluate_contact_policy_for_tenant` agree.
--
-- Only the NIX block below differs from the delivered definition; everything else is
-- reproduced unchanged.
create or replace function public.evaluate_exact_call_policy(
  p_tenant_id uuid,
  p_user_id uuid,
  p_customer_id uuid,
  p_contact_person_id uuid,
  p_target_phone text,
  p_session_id uuid default null,
  p_list_member_id uuid default null,
  p_callback_activity_id uuid default null,
  p_contract_id uuid default null
) returns jsonb
language plpgsql
stable
security definer
set search_path=public
as $$
declare
  v_customer public.customers%rowtype;
  v_contact public.contact_people%rowtype;
  v_membership public.tenant_memberships%rowtype;
  v_list_id uuid;
  v_callback_contract_id uuid;
  v_callback_team_id uuid;
  v_purpose text;
  v_contact_policy jsonb;
  v_nix text;
  v_compliance jsonb;
  v_reason text;
begin
  if auth.uid() is null or auth.uid() is distinct from p_user_id then
    return jsonb_build_object('allowed',false,'reason','actor_identity_mismatch','policyVersion','exact-call-policy-v1','evaluatedAt',now());
  end if;
  if p_target_phone is null or p_target_phone !~ '^\+[1-9][0-9]{7,14}$' then
    return jsonb_build_object('allowed',false,'reason','target_phone_invalid','policyVersion','exact-call-policy-v1','evaluatedAt',now());
  end if;
  if not exists(select 1 from public.tenants t where t.id=p_tenant_id and t.status in ('trial','active')) then
    return jsonb_build_object('allowed',false,'reason','tenant_not_active','policyVersion','exact-call-policy-v1','evaluatedAt',now());
  end if;
  select * into v_membership from public.tenant_memberships m
    where m.tenant_id=p_tenant_id and m.user_id=p_user_id and m.status='active';
  if not found then
    return jsonb_build_object('allowed',false,'reason','membership_not_active','policyVersion','exact-call-policy-v1','evaluatedAt',now());
  end if;
  if v_membership.role not in ('owner','admin','team_lead','sales') then
    return jsonb_build_object('allowed',false,'reason','call_role_not_permitted','policyVersion','exact-call-policy-v1','evaluatedAt',now());
  end if;

  select * into v_customer from public.customers c
    where c.tenant_id=p_tenant_id and c.id=p_customer_id and c.deleted_at is null;
  if not found then return jsonb_build_object('allowed',false,'reason','customer_not_found','policyVersion','exact-call-policy-v1','evaluatedAt',now()); end if;
  if not public.can_access_customer(p_customer_id) then
    return jsonb_build_object('allowed',false,'reason','customer_access_denied','policyVersion','exact-call-policy-v1','evaluatedAt',now());
  end if;

  if p_contact_person_id is null then
    if p_target_phone is distinct from v_customer.phone_e164 and p_target_phone is distinct from v_customer.alternate_phone_e164 then
      return jsonb_build_object('allowed',false,'reason','target_phone_customer_mismatch','policyVersion','exact-call-policy-v1','evaluatedAt',now());
    end if;
  else
    select * into v_contact from public.contact_people cp
      where cp.tenant_id=p_tenant_id and cp.id=p_contact_person_id and cp.customer_id=p_customer_id;
    if not found then return jsonb_build_object('allowed',false,'reason','contact_person_not_found','policyVersion','exact-call-policy-v1','evaluatedAt',now()); end if;
    if p_target_phone is distinct from v_contact.phone_e164 and p_target_phone is distinct from v_contact.alternate_phone_e164 then
      return jsonb_build_object('allowed',false,'reason','target_phone_contact_mismatch','policyVersion','exact-call-policy-v1','evaluatedAt',now());
    end if;
  end if;

  if p_session_id is not null or p_list_member_id is not null then
    if p_session_id is null or p_list_member_id is null then
      return jsonb_build_object('allowed',false,'reason','list_call_context_incomplete','policyVersion','exact-call-policy-v1','evaluatedAt',now());
    end if;
    select ds.list_id into v_list_id
    from public.dialer_sessions ds
    join public.customer_list_members lm on lm.tenant_id=ds.tenant_id and lm.list_id=ds.list_id
      and lm.id=p_list_member_id and lm.customer_id=p_customer_id
      and lm.claimed_by=p_user_id and lm.claim_expires_at>now()
    join public.customer_lists l on l.tenant_id=ds.tenant_id and l.id=ds.list_id and l.status='active'
    where ds.tenant_id=p_tenant_id and ds.id=p_session_id and ds.user_id=p_user_id and ds.state in ('active','after_call');
    if v_list_id is null or not public.can_work_customer_list(v_list_id) then
      return jsonb_build_object('allowed',false,'reason','list_claim_not_operational','policyVersion','exact-call-policy-v1','evaluatedAt',now());
    end if;
    v_purpose:='direct_marketing';
  elsif p_callback_activity_id is not null then
    select a.contract_id,a.assigned_team_id into v_callback_contract_id,v_callback_team_id
    from public.activities a
    where a.tenant_id=p_tenant_id and a.id=p_callback_activity_id and a.customer_id=p_customer_id
      and a.type='callback' and a.status in ('open','in_progress')
      and (a.assigned_user_id=p_user_id or (a.callback_scope='global' and a.claimed_by=p_user_id))
      and (a.assigned_team_id is null or public.can_operate_in_team(a.assigned_team_id,p_user_id))
      and (a.list_id is null or public.can_work_customer_list(a.list_id));
    if not found then return jsonb_build_object('allowed',false,'reason','callback_not_available','policyVersion','exact-call-policy-v1','evaluatedAt',now()); end if;
    v_purpose:=case when v_callback_contract_id is not null then 'contract_followup' else 'direct_marketing' end;
  elsif p_contract_id is not null then
    if not exists(
      select 1 from public.contracts c where c.tenant_id=p_tenant_id and c.id=p_contract_id and c.customer_id=p_customer_id
        and c.status not in ('cancelled','superseded','terminated') and public.can_access_contract(c.id)
    ) then return jsonb_build_object('allowed',false,'reason','contract_followup_not_authorized','policyVersion','exact-call-policy-v1','evaluatedAt',now()); end if;
    v_purpose:='contract_followup';
  elsif v_customer.lifecycle in ('customer','former_customer') then
    v_purpose:='customer_service';
  else
    v_purpose:='direct_marketing';
  end if;

  if v_customer.do_not_call then
    return jsonb_build_object('allowed',false,'reason','customer_do_not_call','purpose',v_purpose,'policyVersion','exact-call-policy-v1','evaluatedAt',now());
  end if;
  v_contact_policy:=public.evaluate_contact_policy_for_tenant(p_tenant_id,p_customer_id,'call',v_purpose);
  if coalesce(v_contact_policy->>'allowed','false')<>'true' then
    v_reason:=coalesce(v_contact_policy->>'reason','contact_policy_denied');
    return jsonb_build_object('allowed',false,'reason',v_reason,'purpose',v_purpose,'policyVersion','exact-call-policy-v1','evaluatedAt',now(),'contactPolicy',v_contact_policy);
  end if;
  if exists(
    select 1 from public.compliance_blocks b
    where b.tenant_id=p_tenant_id and (b.customer_id=p_customer_id or b.phone_e164=p_target_phone)
      and 'call'=any(b.channels) and b.active and (b.expires_at is null or b.expires_at>now())
  ) then return jsonb_build_object('allowed',false,'reason','compliance_block','purpose',v_purpose,'policyVersion','exact-call-policy-v1','evaluatedAt',now()); end if;

  -- NIX-Telefon registers private subscriptions, so this control applies to private
  -- individuals, matching `evaluate_contact_policy_for_tenant`. It stays keyed on the
  -- number actually dialled, which may be a contact person's rather than the card's.
  -- A recorded listing refuses the call in every mode; only a *missing* result is
  -- governed by the tenant's screening mode.
  if v_purpose in ('direct_marketing','automation_marketing') and v_customer.customer_type='person' then
    select coalesce(ts.compliance,'{}'::jsonb) into v_compliance
    from public.tenant_settings ts where ts.tenant_id=p_tenant_id;
    select result into v_nix from public.nix_checks
    where tenant_id=p_tenant_id and phone_e164=p_target_phone and valid_until>now()
    order by checked_at desc limit 1;
    if v_nix is not null and v_nix<>'not_listed' then
      return jsonb_build_object('allowed',false,'reason','target_nix_'||v_nix,'purpose',v_purpose,'policyVersion','exact-call-policy-v1','evaluatedAt',now());
    end if;
    if v_nix is null
       and coalesce(v_compliance->>'nix_screening_mode','provider_check')<>'pre_screened_source' then
      return jsonb_build_object('allowed',false,'reason','target_nix_check_required','purpose',v_purpose,'policyVersion','exact-call-policy-v1','evaluatedAt',now());
    end if;
  end if;

  return jsonb_build_object(
    'allowed',true,'reason',null,'purpose',v_purpose,'policyVersion','exact-call-policy-v1','evaluatedAt',now(),
    'tenantId',p_tenant_id,'userId',p_user_id,'customerId',p_customer_id,'contactPersonId',p_contact_person_id,
    'targetPhoneSuffix',right(p_target_phone,4),'listId',v_list_id,'callbackActivityId',p_callback_activity_id,'contractId',coalesce(p_contract_id,v_callback_contract_id)
  );
end $$;
revoke all on function public.evaluate_exact_call_policy(uuid,uuid,uuid,uuid,text,uuid,uuid,uuid,uuid) from public,anon;
grant execute on function public.evaluate_exact_call_policy(uuid,uuid,uuid,uuid,text,uuid,uuid,uuid,uuid) to authenticated,service_role;

-- Restore a pgcrypto search path that a later migration silently reverted.
--
-- `202608080002` set `search_path = public, extensions` on these functions because
-- Supabase installs pgcrypto in `extensions`. `202608100006` then redefined
-- `rinkel_reserve_platform_outbound_call_v2` with `set search_path=public`, and a
-- `create or replace` replaces the whole SET clause, so the hardening was lost.
-- The reservation hashes its idempotency key with `digest()`, so on the hosted
-- project every outbound call failed with
--   function digest(text, unknown) does not exist
-- at the point the call row is inserted. `finalize_signing_envelope` carries the
-- same defect and would fail the same way when finalising a signed contract.
--
-- The PGlite harness defines its own `public.digest`, which is why replaying the
-- migrations never reproduced this. `scripts/verify-sql.mjs` now asserts the
-- invariant directly against `proconfig` so a future redefinition cannot revert it
-- unnoticed again.
alter function public.rinkel_reserve_platform_outbound_call_v2(uuid,uuid,text,uuid,uuid,uuid,uuid,text,text,uuid)
  set search_path = public, extensions;
alter function public.finalize_signing_envelope(uuid,uuid,jsonb)
  set search_path = public, extensions;
