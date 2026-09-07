-- Contact policy: the legal-basis gate never fired for customers with no
-- contact-permission row.
--
-- `v_has_legal_basis` was computed as
--   <legal_basis present> or v_permission_status='allowed'
-- and `v_permission_status` is null whenever the customer has no row in
-- `contact_permissions`. In three-valued logic `false or null` is null, so
-- `not v_has_legal_basis` was null and the guard
--   if v_customer.customer_type='person' and not v_has_legal_basis
-- evaluated to null rather than true and did not fire.
--
-- The effect: a private individual with no recorded legal basis and no consent
-- record - precisely the case the gate exists to stop - passed the marketing
-- legal-basis check. The gate only ever fired when a permission row existed with
-- a status other than 'allowed', which is the narrower case.
--
-- No unlawful call resulted here because the NIX gate that follows it still
-- refuses a private individual without a valid screening result, but the two are
-- independent controls and the legal-basis one must stand on its own.
--
-- Forward-only: behaviour of every other branch is unchanged.

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

  if p_purpose in ('direct_marketing','automation_marketing') then
    if v_customer.marketing_allowed is false then
      return jsonb_build_object('allowed',false,'reason','marketing_not_allowed');
    end if;
    -- `v_permission_status` is null when the customer has no contact-permission
    -- row at all. Without coalescing, `false or null` yields null, `not null`
    -- yields null, and the legal-basis gate below silently does not fire - which
    -- is exactly the case it exists to stop.
    v_has_legal_basis := nullif(trim(coalesce(v_customer.legal_basis,'')),'') is not null
      or coalesce(v_permission_status,'')='allowed';
    if v_customer.customer_type='person' and not v_has_legal_basis then
      return jsonb_build_object('allowed',false,'reason','legal_basis_required');
    end if;
  end if;

  if p_channel='call' and p_purpose in ('direct_marketing','automation_marketing') then
    select coalesce(t.timezone,'Europe/Stockholm'),coalesce(ts.compliance,'{}'::jsonb)
      into v_timezone,v_compliance
    from public.tenants t left join public.tenant_settings ts on ts.tenant_id=t.id
    where t.id=p_tenant_id;
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
      if v_nix_result is null then return jsonb_build_object('allowed',false,'reason','nix_check_required'); end if;
      if v_nix_result<>'not_listed' then return jsonb_build_object('allowed',false,'reason','nix_'||v_nix_result); end if;
    end if;
  end if;

  return jsonb_build_object('allowed',true,'reason','allowed','feature',v_feature);
end
$$;
