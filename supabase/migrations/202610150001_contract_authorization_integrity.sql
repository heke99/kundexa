begin;

-- Remove every old customer write policy: permissive policies are ORed.
do $$ declare p record; begin
  for p in select policyname from pg_policies where schemaname='public' and tablename='customers' and cmd in ('INSERT','UPDATE','ALL') loop
    execute format('drop policy %I on public.customers',p.policyname);
  end loop;
end $$;
create policy customers_writer_insert on public.customers for insert to authenticated
with check (tenant_id=public.current_tenant_id()
  and public.has_current_role(array['owner','admin','team_lead','sales','backoffice'])
  and public.can_access_customer_row(id,tenant_id,assigned_user_id,created_by,assigned_team_id));
create policy customers_writer_update on public.customers for update to authenticated
using (tenant_id=public.current_tenant_id() and public.can_write_customer(id))
with check (tenant_id=public.current_tenant_id()
  and public.has_current_role(array['owner','admin','team_lead','sales','backoffice'])
  and public.can_access_customer_row(id,tenant_id,assigned_user_id,created_by,assigned_team_id));

-- Invoker trigger: direct Data API writes run as authenticated; checked SECURITY
-- DEFINER workflows run as their owner. A client-set GUC is never a bypass.
create or replace function public.guard_contract_controlled_fields() returns trigger
language plpgsql set search_path=public as $$
begin
  if tg_op='UPDATE' and new.status='cancelled' and old.status<>'cancelled'
    and exists(select 1 from public.signing_envelopes e
      where e.tenant_id=new.tenant_id and e.contract_id=new.id and e.provider='docuseal'
        and e.status in ('draft','creating','sent','partially_signed')) then
    raise exception 'external_signing_cancellation_required';
  end if;
  if current_user in ('authenticated','anon') then
    if tg_op='INSERT' then
      if new.status<>'draft' or new.acceptance_generation<>0 or new.active_version_id is not null or new.signed_at is not null then
        raise exception 'controlled_contract_transition_required';
      end if;
    elsif new.status is distinct from old.status
       or new.acceptance_generation is distinct from old.acceptance_generation
       or new.active_version_id is distinct from old.active_version_id
       or new.signed_at is distinct from old.signed_at then
      raise exception 'controlled_contract_transition_required';
    end if;
    if not public.has_current_role(array['owner','admin','contract_manager']) then
      if tg_op='INSERT' or new.value is distinct from old.value
        or new.currency is distinct from old.currency
        or new.binding_months is distinct from old.binding_months
        or new.notice_months is distinct from old.notice_months
        or new.product_id is distinct from old.product_id then
        raise exception 'commercial_override_permission_required';
      end if;
    end if;
  end if;
  if auth.uid() is not null and new.active_version_id is not null
    and not public.has_current_role(array['owner','admin','contract_manager']) then
    if not exists(select 1 from public.contract_versions cv
      join public.product_price_versions pv on pv.tenant_id=cv.tenant_id and pv.id=cv.price_version_id
      where cv.tenant_id=new.tenant_id and cv.id=new.active_version_id and pv.product_id=new.product_id
        and new.value is not distinct from pv.recurring_fee and new.currency=pv.currency
        and new.binding_months is not distinct from pv.binding_months
        and new.notice_months is not distinct from pv.notice_months) then
      raise exception 'commercial_override_permission_required';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.guard_contract_controlled_fields() from public,anon,authenticated;
create trigger contracts_controlled_fields before insert or update on public.contracts
for each row execute function public.guard_contract_controlled_fields();

create or replace function public.guard_recipient_controlled_fields() returns trigger
language plpgsql set search_path=public as $$
begin
  if current_user in ('authenticated','anon') then
    if tg_op='INSERT' then
      if new.status<>'pending' or new.signed_at is not null or not new.required
        or new.identity_assurance_level<>'low' or new.provider_recipient_id is not null
        or new.generation<>coalesce((select acceptance_generation from public.contracts where id=new.contract_id and tenant_id=new.tenant_id),-1) then raise exception 'controlled_recipient_transition_required'; end if;
    elsif (old.generation>0 and new is distinct from old)
       or new.identity_assurance_level is distinct from old.identity_assurance_level
       or new.provider_recipient_id is distinct from old.provider_recipient_id
       or new.status is distinct from old.status or new.required is distinct from old.required
       or new.signed_at is distinct from old.signed_at
       or new.generation is distinct from old.generation
       or new.contract_id is distinct from old.contract_id
       or new.tenant_id is distinct from old.tenant_id then
      raise exception 'controlled_recipient_transition_required';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.guard_recipient_controlled_fields() from public,anon,authenticated;
create trigger contract_recipients_controlled_fields before insert or update on public.contract_recipients
for each row execute function public.guard_recipient_controlled_fields();

-- Validate approved commercial values even inside the checked draft RPCs. This
-- closes direct RPC calls that bypass the server action's form restrictions.
create or replace function public.guard_contract_commercial_terms() returns trigger
language plpgsql set search_path=public as $$
declare p public.product_price_versions%rowtype;
begin
  if auth.uid() is not null and not public.has_current_role(array['owner','admin','contract_manager']) then
    if current_user in ('authenticated','anon') then raise exception 'controlled_contract_version_required'; end if;
    if tg_op='UPDATE' and new.commercial_terms is not distinct from old.commercial_terms
      and new.price_version_id is not distinct from old.price_version_id
      and new.rendered_body is not distinct from old.rendered_body
      and new.rendered_terms is not distinct from old.rendered_terms then return new; end if;
    if coalesce(auth.role(),'')<>'service_role' then raise exception 'controlled_contract_rendering_required'; end if;
    select pv.* into p from public.product_price_versions pv
    join public.contracts c on c.tenant_id=pv.tenant_id and c.product_id=pv.product_id
    where c.id=new.contract_id and c.tenant_id=new.tenant_id and pv.id=new.price_version_id and pv.active
      and pv.valid_from<=current_date and (pv.valid_to is null or pv.valid_to>=current_date);
    if not found then raise exception 'approved_product_price_required'; end if;
    if new.commercial_terms->>'currency' is distinct from p.currency
      or (new.commercial_terms->>'recurring_fee')::numeric is distinct from p.recurring_fee
      or (new.commercial_terms->>'setup_fee')::numeric is distinct from p.setup_fee
      or (new.commercial_terms->>'binding_months')::integer is distinct from p.binding_months
      or (new.commercial_terms->>'notice_months')::integer is distinct from p.notice_months
      or (new.commercial_terms->>'payment_terms_days')::integer is distinct from p.payment_terms_days
      or (new.commercial_terms->>'contract_value')::numeric is distinct from p.recurring_fee
      or coalesce(new.commercial_terms->'variable_fees','[]'::jsonb) is distinct from coalesce(p.variable_fees,'[]'::jsonb)
      or coalesce(new.commercial_terms->'additional_terms','{}'::jsonb) is distinct from coalesce(p.terms,'{}'::jsonb)
    then raise exception 'commercial_override_permission_required'; end if;
    if current_user in ('authenticated','anon') then raise exception 'controlled_contract_version_required'; end if;
  end if;
  return new;
end $$;
revoke all on function public.guard_contract_commercial_terms() from public,anon,authenticated;
create trigger contract_versions_approved_commercial before insert or update on public.contract_versions
for each row execute function public.guard_contract_commercial_terms();

create or replace function public.guard_order_approved_price() returns trigger
language plpgsql set search_path=public as $$
begin
  if auth.uid() is not null and not public.has_current_role(array['owner','admin','contract_manager']) then
    if not exists(select 1 from public.product_price_versions p
      where p.tenant_id=new.tenant_id and p.id=new.price_version_id and p.product_id=new.product_id
        and p.active and p.valid_from<=current_date and (p.valid_to is null or p.valid_to>=current_date)
        and new.unit_price=p.setup_fee+p.recurring_fee and new.discount=0
        and new.line_total=round(new.quantity*new.unit_price,2)) then
      raise exception 'commercial_override_permission_required';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.guard_order_approved_price() from public,anon,authenticated;
create trigger sales_order_items_approved_price before insert or update on public.sales_order_items
for each row execute function public.guard_order_approved_price();

-- Rendering is performed by the trusted application server, never accepted
-- from an ordinary seller's direct RPC payload. Resource and actor checks still
-- execute in v3 under the verified membership, not the service principal.
create or replace function public.create_contract_draft_for_actor(
  p_tenant_id uuid,p_actor_user_id uuid,p_input jsonb
) returns uuid language plpgsql security definer set search_path=public as $$
begin
  if auth.role()<>'service_role' then raise exception 'service_role_required'; end if;
  if not exists(select 1 from public.tenant_memberships m join public.tenants t on t.id=m.tenant_id
    where m.tenant_id=p_tenant_id and m.user_id=p_actor_user_id and m.status='active'
      and t.status in ('trial','active')) then raise exception 'active_membership_required'; end if;
  perform set_config('request.jwt.claim.sub',p_actor_user_id::text,true);
  perform set_config('app.kundexa_tenant_id',p_tenant_id::text,true);
  if public.current_tenant_id() is distinct from p_tenant_id then raise exception 'tenant_context_rejected'; end if;
  return public.create_contract_draft_v3(
    p_input->>'p_contract_number',(p_input->>'p_customer_id')::uuid,(p_input->>'p_product_id')::uuid,
    (p_input->>'p_price_version_id')::uuid,(p_input->>'p_template_id')::uuid,
    (p_input->>'p_template_version_id')::uuid,(p_input->>'p_legal_entity_id')::uuid,
    p_input->>'p_title',p_input->>'p_rendered_body',p_input->>'p_rendered_terms',
    p_input->'p_commercial_terms',p_input->>'p_document_hash',p_input->>'p_sales_channel',
    p_input->'p_seller_snapshot',p_input->'p_counterparty_snapshot',
    (p_input->>'p_owner_user_id')::uuid,(p_input->>'p_team_id')::uuid,
    (p_input->>'p_starts_on')::date,(p_input->>'p_ends_on')::date,
    (p_input->>'p_binding_months')::integer,(p_input->>'p_notice_months')::integer,
    (p_input->>'p_contract_value')::numeric,p_input->>'p_currency',(p_input->>'p_expires_at')::timestamptz
  );
end $$;
revoke all on function public.create_contract_draft_for_actor(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.create_contract_draft_for_actor(uuid,uuid,jsonb) to service_role;

-- Keep PostGIS reference reads and extension ownership; remove public DML only.
do $$ begin
  if to_regclass('public.spatial_ref_sys') is not null then
    revoke insert,update,delete,truncate,references,trigger on public.spatial_ref_sys from public,anon,authenticated;
  end if;
end $$;
commit;
