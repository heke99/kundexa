begin;

-- Versioned wrapper: retain create_contract_draft_v2 for existing callers while
-- making the complete manual/API draft input atomic and tenant-safe.
create or replace function public.create_contract_draft_v3(
  p_contract_number text,
  p_customer_id uuid,
  p_product_id uuid,
  p_price_version_id uuid,
  p_template_id uuid,
  p_template_version_id uuid,
  p_legal_entity_id uuid,
  p_title text,
  p_rendered_body text,
  p_rendered_terms text,
  p_commercial_terms jsonb,
  p_document_hash text,
  p_sales_channel text,
  p_seller_snapshot jsonb,
  p_counterparty_snapshot jsonb,
  p_owner_user_id uuid default null,
  p_team_id uuid default null,
  p_starts_on date default null,
  p_ends_on date default null,
  p_binding_months integer default null,
  p_notice_months integer default null,
  p_contract_value numeric default null,
  p_currency text default 'SEK',
  p_expires_at timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path=public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_user uuid := auth.uid();
  v_owner uuid := coalesce(p_owner_user_id, auth.uid());
  v_role text := public.current_membership_role()::text;
  v_contract uuid;
begin
  if v_tenant is null or v_user is null then raise exception 'authentication_required'; end if;
  if not public.has_current_role(array['owner','admin','team_lead','sales','contract_manager','backoffice']) then
    raise exception 'contract_write_permission_required';
  end if;
  if p_ends_on is not null and p_starts_on is not null and p_ends_on < p_starts_on then
    raise exception 'contract_end_before_start';
  end if;
  if p_binding_months is not null and (p_binding_months < 0 or p_binding_months > 240) then
    raise exception 'invalid_binding_months';
  end if;
  if p_notice_months is not null and (p_notice_months < 0 or p_notice_months > 120) then
    raise exception 'invalid_notice_months';
  end if;
  if p_contract_value is not null and p_contract_value < 0 then raise exception 'invalid_contract_value'; end if;
  if p_currency !~ '^[A-Z]{3}$' then raise exception 'invalid_contract_currency'; end if;
  if p_expires_at is not null and p_expires_at <= now() then raise exception 'acceptance_expiry_must_be_future'; end if;

  if not exists(
    select 1 from public.tenant_memberships
    where tenant_id=v_tenant and user_id=v_owner and status='active'
  ) then raise exception 'contract_owner_not_active_member'; end if;

  if p_team_id is not null then
    if not exists(select 1 from public.teams where tenant_id=v_tenant and id=p_team_id and status='active') then
      raise exception 'contract_team_not_active';
    end if;
    if not exists(
      select 1 from public.team_members
      where tenant_id=v_tenant and team_id=p_team_id and user_id=v_owner and assignment_paused=false
    ) then raise exception 'contract_owner_not_in_team'; end if;
  end if;

  if v_owner <> v_user then
    if v_role in ('owner','admin','contract_manager') then
      null;
    elsif v_role='team_lead' and p_team_id is not null and public.can_manage_team(p_team_id) then
      null;
    else
      raise exception 'contract_owner_assignment_forbidden';
    end if;
  end if;

  if p_team_id is not null and v_role not in ('owner','admin','contract_manager') then
    if v_role='team_lead' and public.can_manage_team(p_team_id) then
      null;
    elsif v_owner=v_user and exists(
      select 1 from public.team_members
      where tenant_id=v_tenant and team_id=p_team_id and user_id=v_user and assignment_paused=false
    ) then
      null;
    else
      raise exception 'contract_team_assignment_forbidden';
    end if;
  end if;

  v_contract := public.create_contract_draft_v2(
    p_contract_number,p_customer_id,p_product_id,p_price_version_id,p_template_id,p_template_version_id,
    p_legal_entity_id,p_title,p_rendered_body,p_rendered_terms,p_commercial_terms,p_document_hash,
    p_sales_channel,p_seller_snapshot,p_counterparty_snapshot
  );

  update public.contracts
  set owner_user_id=v_owner,
      team_id=p_team_id,
      starts_on=p_starts_on,
      ends_on=p_ends_on,
      binding_months=p_binding_months,
      notice_months=p_notice_months,
      value=coalesce(p_contract_value,value),
      currency=p_currency,
      expires_at=p_expires_at,
      updated_at=now()
  where tenant_id=v_tenant and id=v_contract;

  insert into public.contract_events(tenant_id,contract_id,event_type,actor_user_id,payload)
  values(v_tenant,v_contract,'contract.commercial_terms_bound',v_user,jsonb_build_object(
    'owner_user_id',v_owner,'team_id',p_team_id,'starts_on',p_starts_on,'ends_on',p_ends_on,
    'binding_months',p_binding_months,'notice_months',p_notice_months,'value',p_contract_value,
    'currency',p_currency,'expires_at',p_expires_at
  ));
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
  values(v_tenant,v_user,'contract.commercial_terms_bound','contract',v_contract::text,jsonb_build_object(
    'owner_user_id',v_owner,'team_id',p_team_id,'starts_on',p_starts_on,'ends_on',p_ends_on,
    'binding_months',p_binding_months,'notice_months',p_notice_months,'value',p_contract_value,
    'currency',p_currency,'expires_at',p_expires_at
  ));
  return v_contract;
end
$$;

revoke all on function public.create_contract_draft_v3(text,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,jsonb,text,text,jsonb,jsonb,uuid,uuid,date,date,integer,integer,numeric,text,timestamptz) from public,anon;
grant execute on function public.create_contract_draft_v3(text,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,jsonb,text,text,jsonb,jsonb,uuid,uuid,date,date,integer,integer,numeric,text,timestamptz) to authenticated;

commit;
