begin;

-- Two changes to match how the business actually works.
--
-- 1. NIX is reported from the customer card, not only from a call.
--
-- The tenant buys pre-screened numbers, so a number is assumed clean and the
-- register is satisfied by the source rather than by a per-number lookup
-- (`nix_screening_mode = 'pre_screened_source'`). The exception path is the
-- seller: whoever finds out that a number is listed records it, and from then on
-- the number is refused in every mode.
--
-- Until now that report could only be filed as a call disposition in the dialer.
-- But a seller learns a number is NIX-listed in ways that are not a completed
-- call — the customer says so on an inbound call, it arrives by email, a
-- colleague passes it on. Forcing the report through a call outcome means those
-- cases are either never recorded or recorded as a fake call.
--
-- The report therefore gets its own entry point on the customer card. It
-- delegates to `apply_call_block_disposition`, which is the single definition of
-- what a blocking disposition does, so the card and the dialer cannot drift:
-- both set `do_not_call`, both write a `compliance_blocks` row per number, and
-- both record a phone-keyed `nix_checks` result so a customer card created later
-- for the same number is refused on the register rather than on this card.
create or replace function public.report_customer_nix_listing(
  p_customer_id uuid,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_user uuid := auth.uid();
  v_phone text;
  v_alternate text;
  v_already boolean;
begin
  if v_user is null or v_tenant is null then raise exception 'authentication_required'; end if;
  -- Marking a number NIX-listed blocks it permanently, so it needs the same
  -- authority as any other write to the customer, not merely read access.
  if not public.can_write_customer(p_customer_id) then raise exception 'customer_write_permission_required'; end if;

  select c.phone_e164, c.alternate_phone_e164
  into v_phone, v_alternate
  from public.customers c
  where c.tenant_id=v_tenant and c.id=p_customer_id and c.deleted_at is null
  for update;
  if not found then raise exception 'customer_not_found'; end if;
  if v_phone is null and v_alternate is null then raise exception 'customer_has_no_phone_number'; end if;

  -- `apply_call_block_disposition` appends rather than upserts, by design: every
  -- report is evidence and the trail is meant to keep them all. Reporting the
  -- same card twice would still be a duplicate screening result for one number,
  -- so the second report is a no-op that says so instead of growing the register.
  select exists(
    select 1 from public.nix_checks n
    where n.tenant_id=v_tenant and n.customer_id=p_customer_id
      and n.source='seller_reported' and n.result='listed'
      and n.valid_until > now()
  ) into v_already;
  if v_already then
    return jsonb_build_object('status','already_reported','customerId',p_customer_id);
  end if;

  perform public.apply_call_block_disposition(
    v_tenant, p_customer_id, 'nix_listed', p_notes, v_user, 'customer_card'
  );

  insert into public.audit_logs(tenant_id, actor_user_id, action, entity_type, entity_id, after_data)
  values(
    v_tenant, v_user, 'customer.nix_reported', 'customer', p_customer_id,
    jsonb_build_object('surface','customer_card','has_alternate', v_alternate is not null)
  );

  return jsonb_build_object(
    'status','reported',
    'customerId',p_customer_id,
    'blockedNumbers',(case when v_phone is not null then 1 else 0 end)
      + (case when v_alternate is not null and v_alternate is distinct from v_phone then 1 else 0 end)
  );
end $$;
revoke all on function public.report_customer_nix_listing(uuid,text) from public,anon;
grant execute on function public.report_customer_nix_listing(uuid,text) to authenticated;

-- 2. A team leader may author a contract template.
--
-- Team leaders own what their team sells, and the contract is part of that. They
-- could not create a template version, so every new agreement type had to go
-- through an owner, an admin or a contract manager even to be drafted.
--
-- Approval deliberately does NOT move: `approve_contract_template_version` stays
-- with owner and admin. A template version is legally binding text that reaches
-- every customer the team sends to, so it is written by the team leader and
-- released by an owner. A team leader who also holds the owner role passes both
-- checks, so a small organisation is not slowed down by the separation.
do $migration$
declare
  v_definition text;
  v_anchor text:=$needle$  if not public.has_current_role(array['owner','admin','contract_manager']) then raise exception 'contract_template_permission_required'; end if;$needle$;
begin
  select pg_get_functiondef('public.create_contract_template_version(uuid,text,text,text,text,uuid,text,text,text,jsonb,jsonb,jsonb)'::regprocedure)
  into v_definition;
  if position(v_anchor in v_definition)=0 then
    -- Already patched by an earlier run: team_lead is in the allowed set.
    if position($already$'owner','admin','contract_manager','team_lead'$already$ in v_definition)>0 then return; end if;
    raise exception 'create_contract_template_version_role_anchor_missing';
  end if;
  v_definition:=replace(
    v_definition,
    v_anchor,
    $replacement$  if not public.has_current_role(array['owner','admin','contract_manager','team_lead']) then raise exception 'contract_template_permission_required'; end if;$replacement$
  );
  execute v_definition;
end
$migration$;

revoke all on function public.create_contract_template_version(uuid,text,text,text,text,uuid,text,text,text,jsonb,jsonb,jsonb) from public,anon;
grant execute on function public.create_contract_template_version(uuid,text,text,text,text,uuid,text,text,text,jsonb,jsonb,jsonb) to authenticated;

commit;
